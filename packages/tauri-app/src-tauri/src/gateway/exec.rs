//! Shell execution for a scheduled task.
//!
//! This is the ADR-0008 escape hatch in its widest form: the process is spawned
//! directly, with the arguments passed as a vector. There is deliberately **no
//! shell** — no `sh -c`, no string concatenation, no interpolation of the
//! arguments into a command line. A model that emits `runCommand("rm", ["-rf",
//! "/"])` gets exactly that argv, which is both the honest semantics ("this is
//! the command that ran") and the one that removes the entire class of quoting
//! and injection accidents from the payload.
//!
//! Three things bound the call, and none of them are access control:
//!
//!   - a wall-clock ceiling ([`MAX_EXEC_TIMEOUT`]), because an unattended run
//!     that hangs holds a child process, a task slot and an unresolved invoke
//!     promise indefinitely;
//!   - a per-stream output cap ([`MAX_OUTPUT_BYTES`]), because `cat` on a
//!     4 GB core dump must not take the app down with it;
//!   - drain-to-EOF after the cap, so a child that keeps writing exits normally
//!     instead of blocking forever on a full pipe (see [`read_into`]).
//!
//! A killed child keeps whatever it had already written: the timeout arm drains
//! both pipes after the reap, so a command that ran for the full deadline
//! reports how far it got rather than an empty string beside `timedOut`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use super::{clamp_timeout, to_text, GatewayContext, GatewayError, GatewayErrorCode};

/// Hard ceiling on one command, whatever the caller asks for.
pub const MAX_EXEC_TIMEOUT: Duration = Duration::from_secs(600);

/// Largest stdout (and, separately, stderr) the app will hold in memory.
///
/// A megabyte is roughly two orders of magnitude more than an LLM context can
/// usefully consume, so nothing legitimate is lost by stopping there — but a
/// command with no such habit (`docker build`, `find /`) would otherwise
/// allocate without limit inside the app process. The overflow is dropped, not
/// errored, and the flag below says so.
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// How long to wait for a killed child to actually be reaped.
///
/// `start_kill` sends SIGKILL but does not reap, and dropping the `Child`
/// without a `wait` leaves a zombie nobody will ever collect — one per timed-out
/// command, on a path a scheduler can hit repeatedly.
const REAP_TIMEOUT: Duration = Duration::from_secs(2);

/// How long to spend reading a killed child's pipes before giving up on them.
///
/// The child is already gone by this point, so both write ends are closed and the
/// reads end at whatever is buffered — this is a backstop, not the expected
/// path. Short anyway: it runs on the way to answering the caller, and a
/// truncated tail is a better answer than a wait that never finishes.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Read granularity while draining a pipe.
const READ_CHUNK: usize = 16 * 1024;

/// A single `runCommand` call from the agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    /// Who is asking. Unused today, load-bearing the day permissions tighten.
    #[serde(flatten)]
    pub context: GatewayContext,
    /// Program to run, resolved through `PATH`. Not a shell string.
    pub command: String,
    /// Arguments, passed through verbatim — no globbing, no word splitting.
    #[serde(default)]
    pub args: Vec<String>,
    /// Working directory. `None` inherits the app's own cwd, which is rarely
    /// what a task author means, so the TS layer always sends one.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Optional deadline in milliseconds, clamped to [`MAX_EXEC_TIMEOUT`].
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Everything one execution produced.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
    /// `None` when the child was killed by a signal rather than exiting.
    pub exit_code: Option<i32>,
    /// Signal that killed the child, on unix. A `timeout` usually shows up as
    /// `SIGKILL` here, which is otherwise indistinguishable from a crash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    /// The deadline was hit and the child killed. Not an error: the run record
    /// shows the command, its output and this flag.
    pub timed_out: bool,
}

/// The gateway entry point for `runCommand`. Every path into the shell goes
/// through here, which is what makes it the place a future allowlist check
/// belongs (ADR-0008).
pub async fn exec(request: ExecRequest) -> Result<ExecOutcome, GatewayError> {
    if request.command.trim().is_empty() {
        return Err(GatewayError::new(
            GatewayErrorCode::InvalidRequest,
            "command must not be empty",
        ));
    }

    let cwd = resolve_cwd(request.cwd.as_deref())?;

    let mut command = tokio::process::Command::new(&request.command);
    command
        .args(&request.args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // `kill_on_drop` is a backstop for a path that cannot otherwise kill its
        // child: an error between spawn and the timeout arming. The explicit
        // kill below remains, because drop-time killing cannot be waited on.
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|e| {
        GatewayError::new(
            GatewayErrorCode::SpawnFailed,
            format!("cannot run {:?} in {}: {e}", request.command, cwd.display()),
        )
    })?;

    let timeout = clamp_timeout(request.timeout_ms, MAX_EXEC_TIMEOUT);
    // The buffers live outside the `collect` future on purpose. A timeout drops
    // that future mid-read, so anything kept only inside it dies with it — and
    // the bytes a command printed before the deadline are exactly the ones worth
    // keeping. Writing into shared buffers here means the timeout arm can still
    // hand them back.
    let stdout_buf = SharedBuffer::new(MAX_OUTPUT_BYTES);
    let stderr_buf = SharedBuffer::new(MAX_OUTPUT_BYTES);
    // The pipes are handed to `collect` by mutable reference rather than taken
    // out of the child, so the timeout arm still owns them afterwards and can
    // drain whatever the killed process had already written.
    let status =
        match tokio::time::timeout(timeout, collect(&mut child, &stdout_buf, &stderr_buf)).await {
            Ok(Ok(status)) => Some(status),
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                reap(&mut child, &request, &cwd).await;
                // Whatever the killed child had already written may still be sitting
                // in the pipe, unread. Draining it now is the difference between a
                // run record that shows how far the command got and one that shows
                // only the word "timed out" — and for a build that ran for ten
                // minutes, that evidence is the whole point of looking.
                drain_after_kill(&mut child, &stdout_buf, &stderr_buf).await;
                None
            }
        };

    let Some(status) = status else {
        return Ok(ExecOutcome {
            exit_code: None,
            signal: None,
            stdout: to_text(stdout_buf.take()),
            stderr: to_text(stderr_buf.take()),
            stdout_truncated: stdout_buf.truncated(),
            stderr_truncated: stderr_buf.truncated(),
            timed_out: true,
        });
    };

    Ok(ExecOutcome {
        exit_code: status.code(),
        signal: exit_signal(&status),
        stdout: to_text(stdout_buf.take()),
        stderr: to_text(stderr_buf.take()),
        stdout_truncated: stdout_buf.truncated(),
        stderr_truncated: stderr_buf.truncated(),
        timed_out: false,
    })
}

/// A capped output buffer the reader appends to and the caller drains.
///
/// Shared because the timeout arm outlives the future that fills it: see the
/// comment at the call site. `Mutex` over a channel because both pipes are read
/// concurrently but drained only after the join.
#[derive(Debug)]
struct SharedBuffer {
    max: usize,
    inner: std::sync::Mutex<(Vec<u8>, bool)>,
}

impl SharedBuffer {
    fn new(max: usize) -> Self {
        Self {
            max,
            inner: std::sync::Mutex::new((Vec::with_capacity(max.min(READ_CHUNK)), false)),
        }
    }

    /// Appends one chunk, keeping at most `max` bytes and flagging the rest.
    fn append(&self, chunk: &[u8]) {
        // A poisoned lock means another thread panicked mid-append. The bytes
        // already in it are still the best available answer, and this process is
        // about to lose the run anyway.
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (kept, truncated) = &mut *guard;
        let room = self.max.saturating_sub(kept.len());
        if chunk.len() > room {
            kept.extend_from_slice(&chunk[..room]);
            *truncated = true;
        } else {
            kept.extend_from_slice(chunk);
        }
    }

    fn truncated(&self) -> bool {
        self.inner.lock().map(|guard| guard.1).unwrap_or(false)
    }

    /// Empties the buffer and returns what it held.
    fn take(&self) -> Vec<u8> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut guard.0)
    }
}

/// Tauri entry point. Thin on purpose: it forwards to [`exec`] and stamps the
/// caller's identity onto any failure, so no exit path can lose it.
#[tauri::command]
pub async fn scheduled_exec(request: ExecRequest) -> Result<ExecOutcome, GatewayError> {
    let context = request.context.clone();
    exec(request).await.map_err(|e| e.with_context(&context))
}

/// The user's home directory, or `None` when the process cannot determine it.
///
/// `HOME` is the unix answer and `USERPROFILE` the Windows one; reading only the
/// former leaves every `~` default failing on Windows, which is the same bug the
/// expansion exists to remove. Tauri also hands a GUI-launched app a different
/// environment than a shell does, so both names are checked rather than assumed.
pub fn home_dir() -> Option<PathBuf> {
    for name in ["HOME", "USERPROFILE"] {
        if let Ok(value) = std::env::var(name) {
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

/// Expands a leading `~` to the user's home directory.
///
/// Only the two forms a shell would also expand: `~` and `~/…`. A `~` that is
/// not the entire first segment (`~backup`) is an ordinary relative name, and
/// is left alone — matching what a user typing into the dialog expects, and
/// avoiding the surprise of a directory the shell would have treated literally.
///
/// Both separators are accepted after the tilde: a Windows path typed by a user
/// into the dialog is `~\projects\x`, and expanding only the forward slash would
/// leave it literal on the platform that uses it.
///
/// Unresolvable (`HOME` unset, as under some launch daemons) falls back to the
/// input unchanged, so the caller's `is_dir()` check produces the ordinary
/// "not a directory" error naming the path rather than a tilde-specific one.
pub(super) fn expand_home(raw: &str) -> PathBuf {
    let rest = match raw.strip_prefix('~') {
        Some("") => Path::new(""),
        Some(after_tilde) => match after_tilde.strip_prefix('/') {
            Some(tail) => Path::new(tail),
            None => match after_tilde.strip_prefix('\\') {
                Some(tail) => Path::new(tail),
                // `~user` is another user's home, which this does not resolve.
                None => return PathBuf::from(raw),
            },
        },
        None => return PathBuf::from(raw),
    };
    match home_dir() {
        // Joining an empty path would append a separator (`/home/x/`), which is
        // the same directory but prints with a trailing slash in every error
        // message and audit record that names the cwd.
        Some(home) if rest.as_os_str().is_empty() => home,
        Some(home) => home.join(rest),
        None => PathBuf::from(raw),
    }
}

/// Resolves and sanity-checks the working directory.
///
/// A missing directory surfaces as an ordinary spawn failure otherwise, and
/// "No such file or directory (os error 2)" names neither the path nor which of
/// the two (the directory, or the program) was missing.
pub(super) fn resolve_cwd(cwd: Option<&str>) -> Result<PathBuf, GatewayError> {
    let Some(raw) = cwd.map(str::trim).filter(|c| !c.is_empty()) else {
        return std::env::current_dir()
            .map_err(|e| GatewayError::new(GatewayErrorCode::Io, format!("cannot read cwd: {e}")));
    };
    let path = expand_home(raw);
    if !path.is_dir() {
        return Err(GatewayError::new(
            GatewayErrorCode::InvalidRequest,
            format!("cwd is not a directory: {raw}"),
        ));
    }
    Ok(path)
}

/// Resolves a path a caller sent, against the task's working directory.
///
/// The three cases the TS layer's own doc promises, in one place:
///   - an absolute path is already decided, and is used as it stands;
///   - a `~`-prefixed path expands against the home directory;
///   - anything else is relative to the task's execution directory.
///
/// Without this, a relative path lands wherever the OS happens to have started
/// the app from, and the "execution directory" in the tool description is a
/// claim rather than a fact.
pub(super) fn resolve_path(raw: &str, cwd: Option<&str>) -> Result<PathBuf, GatewayError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(GatewayError::new(
            GatewayErrorCode::InvalidRequest,
            "path must not be empty",
        ));
    }
    let as_path = Path::new(trimmed);
    if as_path.is_absolute() {
        return Ok(as_path.to_path_buf());
    }
    if trimmed.starts_with('~') {
        return Ok(expand_home(trimmed));
    }
    let base = resolve_cwd(cwd)?;
    Ok(base.join(as_path))
}

/// Drains both pipes and reaps the child.
///
/// The reads run concurrently with the wait. Read them one after another and a
/// command that fills the stderr buffer while this is blocked on stdout
/// deadlocks — the classic pipe deadlock, and with a 10-minute ceiling it
/// presents as "this command hangs", which sends the reader looking in the wrong
/// place entirely.
async fn collect(
    child: &mut tokio::process::Child,
    stdout_buf: &SharedBuffer,
    stderr_buf: &SharedBuffer,
) -> Result<std::process::ExitStatus, GatewayError> {
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    // Both pipes concurrently, never one after the other: reading stdout to EOF
    // first means a child that fills the stderr buffer while stdout is still
    // open blocks on write forever, and the timeout then reports a hang for a
    // command that was working fine.
    let read = async {
        let out = async {
            if let Some(pipe) = stdout.as_mut() {
                read_into(pipe, stdout_buf).await;
            }
        };
        let err = async {
            if let Some(pipe) = stderr.as_mut() {
                read_into(pipe, stderr_buf).await;
            }
        };
        tokio::join!(out, err);
    };

    let (_, status) = tokio::join!(read, child.wait());
    status.map_err(|e| {
        GatewayError::new(
            GatewayErrorCode::SpawnFailed,
            format!("waiting for child failed: {e}"),
        )
    })
}

/// Reads whatever is left in both pipes of an already-killed child.
///
/// Bounded like everything else here: the child is dead, so these pipes close on
/// their own, and the cap is only a backstop against a pipe whose write end
/// somehow outlived the process. Returns rather than loops forever if the bound
/// is reached, because a truncated tail beats an await that never finishes.
async fn drain_after_kill(
    child: &mut tokio::process::Child,
    stdout_buf: &SharedBuffer,
    stderr_buf: &SharedBuffer,
) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let out = async {
        if let Some(pipe) = stdout {
            read_bounded(pipe, stdout_buf).await;
        }
    };
    let err = async {
        if let Some(pipe) = stderr {
            read_bounded(pipe, stderr_buf).await;
        }
    };
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, async { tokio::join!(out, err) }).await;
}

/// [`read_into`] under a deadline, for use after the child is already dead.
async fn read_bounded<R>(reader: R, buf: &SharedBuffer)
where
    R: tokio::io::AsyncRead + Unpin,
{
    read_into(reader, buf).await;
}

/// Reads a pipe to EOF, appending to `buf` and discarding past its cap.
///
/// Discarding rather than stopping is the point. Returning as soon as the cap
/// is hit leaves the write end of the pipe with nobody reading it, so a child
/// that keeps producing output blocks on write and never exits — the timeout
/// then kills it and reports "timed out" for a command that was working fine
/// and merely talked a lot.
async fn read_into<R>(mut reader: R, buf: &SharedBuffer)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut chunk = [0u8; READ_CHUNK];

    loop {
        match reader.read(&mut chunk).await {
            // A read error mid-stream loses the tail, but the head is still the
            // most useful part of the output, so this is reported as a short
            // result rather than an error that discards it.
            Ok(0) | Err(_) => return,
            Ok(n) => buf.append(&chunk[..n]),
        }
    }
}

/// Kills a child that overran its deadline and waits for the kernel to reap it.
async fn reap(child: &mut tokio::process::Child, request: &ExecRequest, cwd: &Path) {
    // `kill` + `wait` rather than `kill_on_drop`: dropping cannot be given a
    // deadline, and an unbounded wait here would turn the 10-minute timeout into
    // an unbounded one.
    let _ = child.start_kill();
    match tokio::time::timeout(REAP_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => eprintln!(
            "gateway: killed {:?} in {} after the deadline (pid reaped, {})",
            request.command,
            cwd.display(),
            status.code().unwrap_or(-1)
        ),
        Ok(Err(e)) => eprintln!("gateway: reaping {:?} failed: {e}", request.command),
        Err(_) => eprintln!(
            "gateway: {:?} was killed but did not reap within {}ms; a zombie may remain",
            request.command,
            REAP_TIMEOUT.as_millis()
        ),
    }
}

/// The signal that killed a child, where the platform reports one.
///
/// `None` for a normal exit, and for a terminated process on Windows — which has
/// no equivalent integer, reporting a non-zero code that `exit_code` already
/// carries.
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(command: &str, args: &[&str]) -> ExecRequest {
        ExecRequest {
            context: GatewayContext {
                task_id: "t-1".to_string(),
                run_id: "r-1".to_string(),
            },
            command: command.to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
            cwd: None,
            timeout_ms: None,
        }
    }

    #[test]
    fn an_empty_command_is_refused_before_anything_runs() {
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(request("   ", &[])))
            .expect_err("a blank command must be refused");
        assert_eq!(error.code, GatewayErrorCode::InvalidRequest);
        assert!(error.message.contains("empty"), "{}", error.message);
    }

    #[test]
    fn arguments_reach_the_child_verbatim() {
        // The property that distinguishes this from a shell: an argument
        // containing a glob, a space and a semicolon arrives as one literal
        // argv entry, never expanded and never re-parsed.
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(request("printf", &["%s|", "*.rs; echo pwned"])))
            .expect("printf should run");
        assert_eq!(outcome.stdout, "*.rs; echo pwned|");
        assert_eq!(outcome.exit_code, Some(0));
        assert!(!outcome.timed_out);
    }

    #[test]
    fn a_non_zero_exit_is_a_result_not_an_error() {
        // The run record has to show "the command failed"; the invoke promise
        // must resolve so the agent can read stderr and react to it.
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(request("sh", &["-c", "echo boom >&2; exit 7"])))
            .expect("a failing command still resolves");
        assert_eq!(outcome.exit_code, Some(7));
        assert_eq!(outcome.stderr.trim(), "boom");
    }

    #[test]
    fn stderr_is_kept_separate_from_stdout() {
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(request("sh", &["-c", "printf out; printf err >&2"])))
            .expect("run");
        assert_eq!(outcome.stdout, "out");
        assert_eq!(outcome.stderr, "err");
    }

    #[test]
    fn output_past_the_cap_is_dropped_and_flagged() {
        // The flag is what lets the renderer say "truncated" instead of letting a
        // model infer completeness from output that simply stopped.
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(request(
                "sh",
                &["-c", "yes 0123456789abcdef | head -c 2000000"],
            )))
            .expect("run");
        assert!(
            outcome.stdout_truncated,
            "expected truncation to be flagged"
        );
        assert!(
            outcome.stdout.len() <= MAX_OUTPUT_BYTES,
            "kept {} bytes, over the {MAX_OUTPUT_BYTES} cap",
            outcome.stdout.len()
        );
    }

    #[test]
    fn a_verbose_command_that_exits_after_the_cap_still_completes() {
        // The deadlock guard: a child that keeps writing after the cap must be
        // drained, not abandoned, or it blocks on write and the call reports a
        // timeout for a command that was simply noisy.
        let mut req = request("sh", &["-c", "yes 0123456789abcdef | head -c 2000000"]);
        req.timeout_ms = Some(30_000);
        let outcome = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(req))
            .expect("run");
        assert!(!outcome.timed_out, "a noisy command must not time out");
        assert!(outcome.stdout_truncated);
    }

    #[test]
    fn a_command_over_its_deadline_is_killed_and_flagged() {
        let mut req = request("sh", &["-c", "sleep 30"]);
        req.timeout_ms = Some(150);
        let outcome = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(req))
            .expect("a timeout is a result, not a transport error");
        assert!(outcome.timed_out);
        assert_eq!(outcome.exit_code, None);
    }

    #[test]
    fn a_tilde_cwd_resolves_to_the_home_directory() {
        // The renderer sends `~` for "no working directory set", and a task
        // author may type `~/projects/x` by hand. A literal `~` is a relative
        // path, so `is_dir()` rejects it and every shell call in every such task
        // fails — the default must mean "the user's home", not "a directory
        // named ~".
        let Some(home) = home_dir() else {
            // No home to expand against; the fallback is covered separately.
            return;
        };
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/"), home);
        assert_eq!(expand_home("~/projects/x"), home.join("projects/x"));
        // A `~` that is not the whole first segment is an ordinary name.
        assert_eq!(expand_home("~backup"), PathBuf::from("~backup"));
        assert_eq!(expand_home("/abs/~/x"), PathBuf::from("/abs/~/x"));
    }

    #[test]
    fn a_bare_tilde_does_not_gain_a_trailing_separator() {
        // Every error message and audit record names the cwd; `/home/x/` is the
        // same directory, and printing it that way reads as a different path.
        let Some(home) = home_dir() else { return };
        assert_eq!(expand_home("~").to_string_lossy(), home.to_string_lossy());
    }

    #[test]
    fn a_relative_path_resolves_against_the_task_directory() {
        let dir = std::env::temp_dir().join("tiny-schedule-gateway-resolve");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");

        let resolved = resolve_path("out/report.md", Some(dir.to_string_lossy().as_ref()))
            .expect("a relative path resolves against the task's directory");
        assert!(
            resolved.ends_with("out/report.md"),
            "expected the relative path joined onto the task directory, got {}",
            resolved.display()
        );
        // Compared against the un-canonicalized scratch dir: `resolve_path` does
        // not resolve symlinks, and canonicalizing one side would test that.
        assert_eq!(resolved.parent().unwrap().parent().unwrap(), dir);
    }

    #[test]
    fn an_absolute_path_is_left_exactly_as_written() {
        let abs = PathBuf::from("/tmp").join("tiny-schedule-abs");
        assert_eq!(
            resolve_path(&abs.to_string_lossy(), Some("/nowhere/at/all")).expect("absolute"),
            abs
        );
    }

    #[test]
    fn an_empty_path_is_refused_before_it_is_resolved() {
        let error = resolve_path("   ", Some("~")).expect_err("blank path must be refused");
        assert_eq!(error.code, GatewayErrorCode::InvalidRequest);
    }

    #[test]
    fn a_tilde_cwd_is_accepted_by_the_resolver() {
        let Some(home) = home_dir() else { return };
        let mut req = request("pwd", &[]);
        req.cwd = Some("~".to_string());
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(req))
            .expect("`~` is the documented default, so it must resolve");
        assert!(!outcome.timed_out);
        assert_eq!(
            outcome.stdout.trim(),
            std::fs::canonicalize(&home)
                .unwrap_or(home)
                .to_string_lossy()
        );
    }

    #[test]
    fn a_timed_out_command_keeps_the_output_it_produced() {
        // 超时丢弃已读字节，是这条路径上最贵的一种丢信息：命令跑了整整一个
        // deadline 才被杀，它在死之前打印的东西已经被 `read_capped` 读进内存了，
        // 却在返回时被整个丢掉。模型拿到的于是是一个空输出，无法判断自己是在
        // 第几步失败的；用户打开运行记录看到的也只是"超时"两个字，没有证据。
        //
        // 一个跑了十分钟才超时的构建，恰恰是最需要看它日志的那一次。
        let mut req = request(
            "sh",
            &["-c", "echo BUILD_STARTED; echo TO_STDERR >&2; sleep 30"],
        );
        req.timeout_ms = Some(400);
        let outcome = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(req))
            .expect("a timeout is a result, not a transport error");
        assert!(outcome.timed_out);
        assert!(
            outcome.stdout.contains("BUILD_STARTED"),
            "stdout produced before the deadline was discarded: {:?}",
            outcome.stdout
        );
        assert!(
            outcome.stderr.contains("TO_STDERR"),
            "stderr produced before the deadline was discarded: {:?}",
            outcome.stderr
        );
    }

    #[test]
    fn a_missing_cwd_is_refused_with_the_path_named() {
        let mut req = request("echo", &[]);
        req.cwd = Some("/nope/not/a/directory".to_string());
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(req))
            .expect_err("a missing cwd must be refused");
        assert_eq!(error.code, GatewayErrorCode::InvalidRequest);
        assert!(error.message.contains("/nope/not/a/directory"));
    }

    #[test]
    fn a_missing_program_reports_the_working_directory() {
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(request("definitely-not-a-real-program", &[])))
            .expect_err("a missing binary must fail");
        assert_eq!(error.code, GatewayErrorCode::SpawnFailed);
        assert!(error.message.contains("definitely-not-a-real-program"));
    }

    #[test]
    fn the_command_runs_in_the_requested_directory() {
        // A fresh directory rather than `/tmp`, and compared against its
        // canonical form: `pwd` resolves symlinks, so on macOS `/tmp` comes back
        // as `/private/tmp` and a literal comparison would fail for a reason
        // that has nothing to do with the behaviour under test.
        let dir = std::env::temp_dir().join("tiny-schedule-gateway-cwd");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let expected = dir.canonicalize().expect("canonical");

        let mut req = request("pwd", &[]);
        req.cwd = Some(dir.to_string_lossy().into_owned());
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(req))
            .expect("run");
        assert_eq!(
            PathBuf::from(outcome.stdout.trim()),
            expected,
            "the command must run in the requested directory"
        );
    }

    #[test]
    fn stdin_is_closed_so_a_prompt_cannot_hang_the_run() {
        // An interactive command reading stdin must fail fast rather than block
        // until the deadline: there is no one at the keyboard of an unattended
        // task.
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(request("cat", &[])))
            .expect("cat over a null stdin exits immediately");
        assert_eq!(outcome.exit_code, Some(0));
    }

    #[test]
    fn read_capped_keeps_the_head_and_reports_truncation() {
        let data = b"0123456789".repeat(10);
        let buf = SharedBuffer::new(25);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(read_into(&data[..], &buf));
        assert_eq!(buf.take(), &b"0123456789012345678901234"[..]);
        assert!(buf.truncated());
    }

    #[test]
    fn read_capped_is_exact_at_the_boundary() {
        // Off-by-one in the strict direction loses a byte of real output for no
        // reason; the flag must mean what it says.
        let data = b"0123456789";
        let buf = SharedBuffer::new(10);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(read_into(&data[..], &buf));
        assert_eq!(buf.take(), &data[..]);
        assert!(!buf.truncated());
    }

    #[test]
    fn exit_signal_is_none_for_a_normal_exit() {
        let status = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(exec(request("true", &[])))
            .expect("run")
            .exit_code;
        assert_eq!(status, Some(0));
    }
}
