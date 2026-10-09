//! Calendar writes via the `event-helper` Swift binary.
//!
//! EventKit has no Rust binding, and the Swift CLI already existed for the
//! Electron build (ADR 0003 keeps it verbatim), so the migration is "spawn the
//! same binary" rather than "write the same integration twice". The stdin/stdout
//! JSON protocol is unchanged; only the spawner moved from Node to
//! [`tokio::process::Command`].
//!
//! Path resolution follows the Electron original's candidate-plus-exists rule
//! (`packages/app/src/main/macos/calendar.ts`): an env override wins, then the
//! bundled resource, then the dev-tree location. Guessing from the bundle id
//! would break in dev, where `resource_dir()` is the target directory.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The helper asks for calendar access, which shows a system prompt; 15s is
/// the Electron original's budget for it.
const HELPER_TIMEOUT: Duration = Duration::from_secs(15);

/// How long to wait for a killed helper to actually be reaped.
///
/// Generous for a process that has already been SIGKILLed — the wait is on
/// the kernel finishing teardown, not on the helper cooperating.
const REAP_TIMEOUT: Duration = Duration::from_secs(2);

/// How much of an unparseable reply to quote back. Enough to identify the
/// failure, short enough not to dump a whole calendar payload into a toast.
const OUTPUT_EXCERPT: usize = 200;

/// The failure codes, mirroring the `code` enum in
/// `CalendarAddTaskOutputSchema` exactly.
///
/// Deliberately no extra variant for "the helper could not be run". The
/// renderer keys a `Record<code, string>` off this enum, so a code outside it
/// would fall through to the raw message — and the Electron original already
/// answered the question: a spawn failure there was `unknown` too
/// (`packages/app/src/main/macos/calendar.ts`). The distinction is kept in the
/// message text, which is what the log and the fallback toast both show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CalendarErrorCode {
    PermissionDenied,
    CalendarAppUnavailable,
    Unknown,
}

impl CalendarErrorCode {
    /// Narrows a code that arrived over the wire. An unrecognised string
    /// becomes `Unknown` rather than failing the whole call: the helper is a
    /// separate binary that may be older than this shell.
    fn from_wire(raw: &str) -> Self {
        match raw {
            "permission-denied" => Self::PermissionDenied,
            "calendar-app-unavailable" => Self::CalendarAppUnavailable,
            _ => Self::Unknown,
        }
    }
}

/// Success arm. `ok` is a real boolean, not serde's internal-tag string, which
/// is why this is a struct behind an untagged enum rather than a tagged enum.
#[derive(Debug, Serialize)]
struct CalendarOk {
    ok: bool,
    #[serde(rename = "eventId")]
    event_id: String,
}

/// Failure arm, matching the `z.discriminatedUnion` in
/// `CalendarAddTaskOutputSchema`.
#[derive(Debug, Serialize)]
struct CalendarFailure {
    ok: bool,
    code: CalendarErrorCode,
    message: String,
}

/// What the renderer receives.
#[derive(Debug, Clone)]
pub enum CalendarOutput {
    Ok {
        event_id: String,
    },
    Err {
        code: CalendarErrorCode,
        message: String,
    },
}

impl CalendarOutput {
    fn success(event_id: String) -> Self {
        Self::Ok { event_id }
    }

    /// Every failure this layer originates — a missing binary, a hang, a
    /// non-zero exit, unparseable output — reported as `Unknown`, matching the
    /// contract's closed enum and the Electron original's treatment of a spawn
    /// failure. The message is what distinguishes them for the reader.
    fn helper_unavailable(message: impl Into<String>) -> Self {
        Self::Err {
            code: CalendarErrorCode::Unknown,
            message: message.into(),
        }
    }
}

/// Serialises the union the way the zod contract parses it.
fn to_json(output: &CalendarOutput) -> serde_json::Value {
    match output {
        CalendarOutput::Ok { event_id } => serde_json::to_value(CalendarOk {
            ok: true,
            event_id: event_id.clone(),
        }),
        CalendarOutput::Err { code, message } => serde_json::to_value(CalendarFailure {
            ok: false,
            code: *code,
            message: message.clone(),
        }),
    }
    .unwrap_or_else(
        |e| serde_json::json!({ "ok": false, "code": "unknown", "message": e.to_string() }),
    )
}

/// What the Swift helper writes to stdout. The two arms have disjoint fields,
/// so an untagged match resolves them unambiguously.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum HelperOutput {
    Ok {
        #[serde(rename = "eventId")]
        event_id: String,
    },
    Err {
        code: String,
        message: String,
    },
}

/// Request payload, matching the Swift `Input` struct. `Serialize` as well as
/// `Deserialize` because the same struct is the stdin body handed to the
/// helper — one definition, so the two cannot drift.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRequest {
    pub title: String,
    pub due_day: String,
    #[serde(default)]
    pub notes: String,
}

/// Candidate locations for `event-helper`, most specific first.
///
/// Ordered like the Electron original: an explicit env override (tests, CI),
/// then the bundled resource (`Contents/Resources/bin/event-helper`), then the
/// dev tree. The dev path is resolved from `CARGO_MANIFEST_DIR` rather than
/// `current_exe`, because in dev the exe lives under `target/debug` while the
/// crate directory is where the relative walk is defined.
pub fn event_helper_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(explicit) = std::env::var("TINY_SCHEDULE_EVENT_HELPER") {
        if !explicit.is_empty() {
            candidates.push(PathBuf::from(explicit));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("bin").join("event-helper"));
    }
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        // src-tauri -> packages/tauri-app -> bin (the Swift helper now lives
        // inside this package, not in a sibling one)
        candidates.push(PathBuf::from(manifest).join("../bin/event-helper"));
    }
    candidates
}

/// First candidate that exists on disk, or the last one as a best-effort
/// default so the spawn error names a concrete path instead of nothing.
pub fn resolve_event_helper(app: &AppHandle) -> PathBuf {
    let candidates = event_helper_candidates(app);
    candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .or_else(|| candidates.last().cloned())
        .unwrap_or_default()
}

/// Everything one helper run produced.
struct Collected {
    status_ok: bool,
    status_code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Drains both pipes and reaps the child.
///
/// The two reads run concurrently: a helper that filled the stderr pipe buffer
/// while this was blocked on stdout would otherwise deadlock, which is exactly
/// the hang the timeout exists to catch.
async fn collect_output(child: &mut tokio::process::Child) -> Result<Collected, String> {
    use tokio::io::AsyncReadExt;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let read = async {
        let mut stdout = String::new();
        let mut stderr = String::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            pipe.read_to_string(&mut stdout)
                .await
                .map_err(|e| format!("reading event-helper stdout failed: {e}"))?;
        }
        if let Some(pipe) = stderr_pipe.as_mut() {
            pipe.read_to_string(&mut stderr)
                .await
                .map_err(|e| format!("reading event-helper stderr failed: {e}"))?;
        }
        Ok::<_, String>((stdout, stderr))
    };

    let (drained, status) = tokio::join!(read, child.wait());
    let (stdout, stderr) = drained?;
    let status = status.map_err(|e| format!("waiting for event-helper failed: {e}"))?;

    Ok(Collected {
        status_ok: status.success(),
        status_code: status.code(),
        stdout,
        stderr,
    })
}

/// Spawns the helper and parses its single-line JSON reply.
///
/// The command itself always resolves: a helper that fails is an expected
/// outcome the renderer has to render, not a transport error. Only a malformed
/// *request* (which the deserializer rejects before this runs) is an `Err`.
#[tauri::command]
pub async fn calendar_add_task(
    app: AppHandle,
    request: CalendarRequest,
) -> Result<serde_json::Value, String> {
    use tokio::io::AsyncWriteExt;

    let bin = resolve_event_helper(&app);
    let payload = serde_json::to_string(&request).map_err(|e| format!("cannot serialise: {e}"))?;

    let mut child = match tokio::process::Command::new(&bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return Ok(to_json(&CalendarOutput::helper_unavailable(format!(
                "cannot spawn {}: {e}",
                bin.display()
            ))))
        }
    };

    // The helper reads stdin to EOF before doing anything. A failed write is
    // deliberately not fatal here: the reply (or its absence) is the authority
    // on whether the request landed.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    let outcome = match tokio::time::timeout(HELPER_TIMEOUT, collect_output(&mut child)).await {
        Ok(Ok(collected)) => interpret(collected),
        Ok(Err(e)) => CalendarOutput::helper_unavailable(e),
        Err(_) => {
            // `start_kill` sends SIGKILL but does not reap: the child stays a
            // zombie until someone `wait`s on it, and dropping the `Child`
            // without a `wait` means nobody ever does. Reaping matters beyond
            // tidiness — this runs on a path the user can trigger repeatedly
            // (every "add to calendar" that hits the timeout), and a long
            // session would accumulate one zombie per attempt.
            //
            // `wait` is bounded rather than bare: SIGKILL is not catchable, so
            // the process is gone by the time the signal lands, but a `wait`
            // that could hang would turn a 15s timeout into an unbounded one.
            // `kill` + `wait` rather than `kill_on_drop` for the same reason:
            // drop-time waiting cannot be given a deadline.
            let _ = child.start_kill();
            match tokio::time::timeout(REAP_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) => eprintln!(
                    "calendar: killed hung event-helper (pid reaped, {})",
                    status.code().unwrap_or(-1)
                ),
                Ok(Err(e)) => eprintln!("calendar: reaping event-helper failed: {e}"),
                Err(_) => eprintln!(
                    "calendar: event-helper was killed but did not reap within {}ms; \
                     a zombie may remain",
                    REAP_TIMEOUT.as_millis()
                ),
            }
            CalendarOutput::helper_unavailable(format!(
                "event-helper did not answer within {}s",
                HELPER_TIMEOUT.as_secs()
            ))
        }
    };

    Ok(to_json(&outcome))
}

/// Turns one completed helper run into the contract's union.
fn interpret(collected: Collected) -> CalendarOutput {
    if !collected.status_ok {
        return CalendarOutput::helper_unavailable(format!(
            "event-helper exited {}: {}",
            collected.status_code.unwrap_or(-1),
            collected.stderr.trim()
        ));
    }

    let stdout = collected.stdout.trim();
    if stdout.is_empty() {
        return CalendarOutput::helper_unavailable(format!(
            "event-helper produced no output; stderr: {}",
            collected.stderr.trim()
        ));
    }

    match serde_json::from_str::<HelperOutput>(stdout) {
        Ok(HelperOutput::Ok { event_id }) => CalendarOutput::success(event_id),
        Ok(HelperOutput::Err { code, message }) => CalendarOutput::Err {
            code: CalendarErrorCode::from_wire(&code),
            message,
        },
        Err(e) => CalendarOutput::helper_unavailable(format!(
            "event-helper output is not the expected JSON ({e}): {}",
            excerpt(stdout)
        )),
    }
}

/// A bounded, char-safe prefix of untrusted helper output.
fn excerpt(raw: &str) -> String {
    raw.chars().take(OUTPUT_EXCERPT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_serialises_booleans_the_way_the_contract_parses() {
        let json = to_json(&CalendarOutput::success("ABC-123".to_string()));
        assert_eq!(json["ok"], serde_json::json!(true));
        assert_eq!(json["eventId"], serde_json::json!("ABC-123"));
        assert!(
            json.get("code").is_none(),
            "the success arm must not carry a code"
        );
    }

    #[test]
    fn failure_serialises_the_kebab_case_code() {
        let json = to_json(&CalendarOutput::Err {
            code: CalendarErrorCode::PermissionDenied,
            message: "用户未授权日历访问".to_string(),
        });
        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["code"], serde_json::json!("permission-denied"));
        assert_eq!(json["message"], serde_json::json!("用户未授权日历访问"));
    }

    #[test]
    fn helper_unavailable_is_reported_as_a_structured_error() {
        // A missing binary is the "permission/missing" path the acceptance
        // criteria call out: structured, not a transport exception. The code
        // is `unknown` — the only value the renderer's `Record<code, string>`
        // can render — and the message keeps the detail.
        let json = to_json(&CalendarOutput::helper_unavailable(
            "cannot spawn /nope/event-helper",
        ));
        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["code"], serde_json::json!("unknown"));
        assert!(json["message"]
            .as_str()
            .expect("message is a string")
            .contains("cannot spawn"));
    }

    #[test]
    fn helper_success_is_parsed() {
        let parsed: HelperOutput =
            serde_json::from_str(r#"{"ok":true,"eventId":"ABC-123"}"#).expect("parse");
        let HelperOutput::Ok { event_id } = parsed else {
            panic!("expected the success arm");
        };
        assert_eq!(event_id, "ABC-123");
    }

    #[test]
    fn helper_failure_is_parsed_and_the_code_narrowed() {
        let parsed: HelperOutput = serde_json::from_str(
            r#"{"ok":false,"code":"permission-denied","message":"用户未授权"}"#,
        )
        .expect("parse");
        let HelperOutput::Err { code, message } = parsed else {
            panic!("expected the failure arm");
        };
        assert_eq!(
            CalendarErrorCode::from_wire(&code),
            CalendarErrorCode::PermissionDenied
        );
        assert_eq!(message, "用户未授权");
    }

    #[test]
    fn unrecognised_helper_code_degrades_to_unknown() {
        // The helper is a separate binary and may predate this shell; a code
        // it grows later must not take the whole command down.
        assert_eq!(
            CalendarErrorCode::from_wire("something-new"),
            CalendarErrorCode::Unknown
        );
    }

    #[test]
    fn non_zero_exit_becomes_a_structured_helper_error() {
        let output = interpret(Collected {
            status_ok: false,
            status_code: Some(3),
            stdout: String::new(),
            stderr: "boom".to_string(),
        });
        let json = to_json(&output);
        assert_eq!(json["code"], serde_json::json!("unknown"));
        assert!(json["message"]
            .as_str()
            .unwrap_or_default()
            .contains("boom"));
    }

    #[test]
    fn empty_stdout_becomes_a_structured_helper_error() {
        let output = interpret(Collected {
            status_ok: true,
            status_code: Some(0),
            stdout: "   \n".to_string(),
            stderr: "no calendar".to_string(),
        });
        let json = to_json(&output);
        assert_eq!(json["code"], serde_json::json!("unknown"));
        assert!(json["message"]
            .as_str()
            .unwrap_or_default()
            .contains("no calendar"));
    }

    #[test]
    fn unparseable_stdout_is_quoted_but_bounded() {
        let output = interpret(Collected {
            status_ok: true,
            status_code: Some(0),
            stdout: "x".repeat(10_000),
            stderr: String::new(),
        });
        let json = to_json(&output);
        let message = json["message"].as_str().unwrap_or_default();
        assert!(
            message.len() < OUTPUT_EXCERPT + 200,
            "excerpt must stay bounded, got {} chars",
            message.len()
        );
    }

    #[test]
    fn request_accepts_a_camel_case_payload() {
        let request: CalendarRequest =
            serde_json::from_str(r#"{"title":"写周报","dueDay":"2026-10-09","notes":"备注"}"#)
                .expect("parse");
        assert_eq!(request.due_day, "2026-10-09");
        assert_eq!(request.notes, "备注");
    }

    #[test]
    fn request_notes_default_when_absent() {
        let request: CalendarRequest =
            serde_json::from_str(r#"{"title":"t","dueDay":"2026-10-09"}"#).expect("parse");
        assert_eq!(request.notes, "");
    }

    #[test]
    fn excerpt_does_not_split_a_multibyte_character() {
        // Slicing bytes here would panic on a boundary; the helper echoes
        // user-supplied titles, so a CJK title is the ordinary case.
        let excerpted = excerpt("写周报写周报写");
        assert_eq!(excerpted, "写周报写周报写");
    }
}
