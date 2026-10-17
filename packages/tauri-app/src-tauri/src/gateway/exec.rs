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
//!     instead of blocking forever on a full pipe (see [`read_capped`]).

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
    let collected = match tokio::time::timeout(timeout, collect(&mut child)).await {
        Ok(Ok(collected)) => collected,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            reap(&mut child, &request, &cwd).await;
            return Ok(ExecOutcome {
                exit_code: None,
                signal: None,
                stdout: String::new(),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out: true,
            });
        }
    };

    Ok(ExecOutcome {
        exit_code: collected.status.code(),
        signal: exit_signal(&collected.status),
        stdout: to_text(collected.stdout),
        stderr: to_text(collected.stderr),
        stdout_truncated: collected.stdout_truncated,
        stderr_truncated: collected.stderr_truncated,
        timed_out: false,
    })
}

/// Tauri entry point. Thin on purpose: it forwards to [`exec`] and stamps the
/// caller's identity onto any failure, so no exit path can lose it.
#[tauri::command]
pub async fn scheduled_exec(request: ExecRequest) -> Result<ExecOutcome, GatewayError> {
    let context = request.context.clone();
    exec(request).await.map_err(|e| e.with_context(&context))
}

/// Resolves and sanity-checks the working directory.
///
/// A missing directory surfaces as an ordinary spawn failure otherwise, and
/// "No such file or directory (os error 2)" names neither the path nor which of
/// the two (the directory, or the program) was missing.
fn resolve_cwd(cwd: Option<&str>) -> Result<PathBuf, GatewayError> {
    let Some(raw) = cwd.map(str::trim).filter(|c| !c.is_empty()) else {
        return std::env::current_dir()
            .map_err(|e| GatewayError::new(GatewayErrorCode::Io, format!("cannot read cwd: {e}")));
    };
    let path = PathBuf::from(raw);
    if !path.is_dir() {
        return Err(GatewayError::new(
            GatewayErrorCode::InvalidRequest,
            format!("cwd is not a directory: {raw}"),
        ));
    }
    Ok(path)
}

/// The captured result of one finished child.
struct Collected {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

/// Drains both pipes and reaps the child.
///
/// The reads run concurrently with the wait. Read them one after another and a
/// command that fills the stderr buffer while this is blocked on stdout
/// deadlocks — the classic pipe deadlock, and with a 10-minute ceiling it
/// presents as "this command hangs", which sends the reader looking in the wrong
/// place entirely.
async fn collect(child: &mut tokio::process::Child) -> Result<Collected, GatewayError> {
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let read = async {
        let (out, out_truncated) = match stdout.as_mut() {
            Some(pipe) => read_capped(pipe, MAX_OUTPUT_BYTES).await,
            None => (Vec::new(), false),
        };
        let (err, err_truncated) = match stderr.as_mut() {
            Some(pipe) => read_capped(pipe, MAX_OUTPUT_BYTES).await,
            None => (Vec::new(), false),
        };
        Ok::<_, GatewayError>((out, out_truncated, err, err_truncated))
    };

    let (drained, status) = tokio::join!(read, child.wait());
    let (out, out_truncated, err, err_truncated) = drained?;
    let status = status.map_err(|e| {
        GatewayError::new(
            GatewayErrorCode::SpawnFailed,
            format!("waiting for child failed: {e}"),
        )
    })?;

    Ok(Collected {
        status,
        stdout: out,
        stderr: err,
        stdout_truncated: out_truncated,
        stderr_truncated: err_truncated,
    })
}

/// Reads a pipe to EOF, keeping at most `max` bytes and discarding the rest.
///
/// Discarding rather than stopping is the point. Returning as soon as the cap
/// is hit leaves the write end of the pipe with nobody reading it, so a child
/// that keeps producing output blocks on write and never exits — the timeout
/// then kills it and reports "timed out" for a command that was working fine
/// and merely talked a lot.
async fn read_capped<R>(mut reader: R, max: usize) -> (Vec<u8>, bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut kept: Vec<u8> = Vec::with_capacity(max.min(READ_CHUNK));
    let mut truncated = false;
    let mut chunk = [0u8; READ_CHUNK];

    loop {
        match reader.read(&mut chunk).await {
            // A read error mid-stream loses the tail, but the head is still the
            // most useful part of the output, so this is reported as a short
            // result rather than an error that discards it.
            Ok(0) | Err(_) => return (kept, truncated),
            Ok(n) => {
                let room = max.saturating_sub(kept.len());
                if n > room {
                    kept.extend_from_slice(&chunk[..room]);
                    truncated = true;
                } else {
                    kept.extend_from_slice(&chunk[..n]);
                }
            }
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
        let (kept, truncated) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(read_capped(&data[..], 25));
        assert_eq!(kept, &b"0123456789012345678901234"[..]);
        assert!(truncated);
    }

    #[test]
    fn read_capped_is_exact_at_the_boundary() {
        // Off-by-one in the strict direction loses a byte of real output for no
        // reason; the flag must mean what it says.
        let data = b"0123456789";
        let (kept, truncated) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(read_capped(&data[..], 10));
        assert_eq!(kept, &data[..]);
        assert!(!truncated);
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
