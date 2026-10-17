//! Capability gateway: the only way out of the sandbox for a scheduled task.
//!
//! ADR-0008 records the permission model — every tool is allowed by default,
//! because an unattended LLM agent picks its arguments at runtime, so a
//! per-task allowlist cannot be authored up front. That decision is only
//! acceptable while the escape hatches stay *few and named*: this module is
//! them. Four entry points, [`exec::exec`], [`http::http_request`],
//! [`files::write_file`] and [`files::read_file`], and nothing else in the
//! shell reaches the shell, the network or an arbitrary path.
//!
//! The thin-shell rule from ADR-0005 still holds — there is no business logic
//! here, no state, and no data store. What this module adds to it is *shape*:
//!
//!   - Every request carries a [`GatewayContext`] (`taskId` / `runId`), even
//!     though nothing reads it today. That is deliberate: when a restricted
//!     mode comes back (ADR-0008, Consequences), the allowlist check reads those
//!     two fields and nothing else has to move.
//!   - Each capability is one request type, one outcome type and one entry
//!     function. The `#[tauri::command]` wrapper around each entry does nothing
//!     but forward, so a future hook is added in one obvious place.
//!
//! # What is *not* defended against
//!
//! Same trust model as [`crate::sse`]: the webview is as trusted as the
//! application code running in it, and anything executing here is the user's
//! own prompt driving their own machine with no human present. The caps below
//! (10 minutes, 1 MB) exist to keep a runaway from exhausting the process, not
//! to stop an attacker — a caller who can reach these commands can already run
//! `rm`. Where a check *is* warranted regardless of trust (a scheme that would
//! hand the request to a different transport, an unreadable body) it is done,
//! and it lives in the entry function next to the work it guards.
//!
//! # These commands are not in `capabilities/default.json`, and cannot be
//!
//! ADR-0008 asks for the gateway to be the one opening in the capability layer,
//! and the honest answer is that the capability layer cannot express it. A
//! `#[tauri::command]` defined by the app itself has no ACL scope: the file's
//! identifier grammar is `plugin:permission`, and there is no plugin to name.
//! Declaring the commands through `tauri_build::AppManifest` does generate
//! `allow-scheduled-exec`-style permissions, but under the prefix `__app-acl__`
//! — which that same grammar rejects, so a capability referencing one fails the
//! build rather than granting it. (Verified against tauri-build 2.7 / tauri
//! 2.12; the identical limitation already applies to `sse_request` and the rest
//! of this shell's own commands, which is why none of them appear there either.)
//!
//! So the boundary is real but it lives here: these four entry functions, and
//! the review rule ADR-0008 sets for new capabilities — does it bypass the
//! gateway. Making it machine-enforced means moving the gateway behind a
//! Tauri plugin (which does get real scopes) or into the `sse.rs` shape of a
//! single audited bridge, and that is a v2 question.

pub mod exec;
pub mod files;
pub mod http;

use serde::{Deserialize, Serialize};

/// Who is calling. Carried on every request so enforcement has an anchor.
///
/// Unused while permissions are open (ADR-0008) — it is here because the moment
/// a restricted mode exists, "may this task run this command" is the whole
/// question, and the answer needs the identity of the caller, not just the
/// payload.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayContext {
    pub task_id: String,
    pub run_id: String,
}

impl GatewayContext {
    /// Single-line label for the process log. Every failure this module emits
    /// carries it, so a bad run can be traced to a task without the renderer
    /// having to thread the ids through its own error handling.
    pub fn describe(&self) -> String {
        format!("task={} run={}", self.task_id, self.run_id)
    }
}

/// Failure classification, kept closed so the renderer can branch on it.
///
/// Mirrors the kebab-case convention of [`crate::calendar::CalendarErrorCode`]:
/// the wire shape is a discriminated union there and a field here, but both
/// avoid the "every failure is a string" shape where a typo in a comparison is
/// indistinguishable from a real failure mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GatewayErrorCode {
    /// The request was malformed before anything was executed.
    InvalidRequest,
    /// The child process could not be started.
    SpawnFailed,
    /// The child ran past its deadline and was killed.
    Timeout,
    /// A filesystem operation failed.
    Io,
    /// An HTTP request could not be completed.
    Http,
}

impl GatewayErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::SpawnFailed => "spawn-failed",
            Self::Timeout => "timeout",
            Self::Io => "io",
            Self::Http => "http",
        }
    }
}

/// Every failure a gateway call can produce.
///
/// Structured rather than a bare `String` (the rest of the shell's convention)
/// because these errors surface in the run record, where a human reads them
/// without the surrounding tool call to give them context. `message` keeps the
/// detail; `code` keeps it machine-sortable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayError {
    pub code: GatewayErrorCode,
    pub message: String,
}

impl GatewayError {
    pub fn new(code: GatewayErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Prefixes the message with the caller's identity. Applied at the entry
    /// boundary rather than at each throw site, so no path can forget it.
    pub fn with_context(self, context: &GatewayContext) -> Self {
        Self {
            code: self.code,
            message: format!("[{}] {}", context.describe(), self.message),
        }
    }
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

/// Clamps a caller-supplied timeout to the hard ceiling.
///
/// Every entry point takes an optional deadline because "a build step" and "a
/// quick `git status`" differ by two orders of magnitude, but the ceiling is
/// not negotiable: a request that never returns holds a child process, a task
/// slot and a webview invoke promise for as long as it lives.
pub fn clamp_timeout(
    requested_ms: Option<u64>,
    ceiling: std::time::Duration,
) -> std::time::Duration {
    match requested_ms {
        // Zero is treated as "no opinion" rather than "kill immediately": a
        // `timeoutMs: 0` is far more likely to be an unset field than a
        // deliberate instant kill, and silently applying it would produce a
        // timeout error with no cause.
        None | Some(0) => ceiling,
        Some(ms) => std::time::Duration::from_millis(ms).min(ceiling),
    }
}

/// A bounded, char-safe rendering of bytes that may not be UTF-8.
///
/// A shell tool's output is arbitrary bytes, so `from_utf8` would fail on a
/// perfectly ordinary `grep` over a mixed-encoding log. Lossy conversion keeps
/// the call succeeding and leaves the U+FFFD marker visible, which is more
/// useful to a model reading a run record than a hard error.
pub fn to_text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn an_omitted_timeout_falls_back_to_the_ceiling() {
        let ceiling = Duration::from_secs(600);
        assert_eq!(clamp_timeout(None, ceiling), ceiling);
        assert_eq!(clamp_timeout(Some(0), ceiling), ceiling);
    }

    #[test]
    fn a_requested_timeout_is_honoured_when_it_fits() {
        let ceiling = Duration::from_secs(600);
        assert_eq!(
            clamp_timeout(Some(1_500), ceiling),
            Duration::from_millis(1_500)
        );
    }

    #[test]
    fn a_requested_timeout_cannot_exceed_the_ceiling() {
        // The whole point of the clamp: a caller cannot ask for an unbounded
        // run, which is the failure mode that leaves a child alive forever.
        let ceiling = Duration::from_secs(600);
        assert_eq!(clamp_timeout(Some(u64::MAX / 1_000), ceiling), ceiling);
    }

    #[test]
    fn context_is_kept_in_the_error_message() {
        let context = GatewayContext {
            task_id: "t-1".to_string(),
            run_id: "r-1".to_string(),
        };
        let error = GatewayError::new(GatewayErrorCode::Timeout, "killed after 600s")
            .with_context(&context);
        assert!(
            error.message.contains("task=t-1 run=r-1"),
            "{}",
            error.message
        );
        assert_eq!(error.code, GatewayErrorCode::Timeout);
    }

    #[test]
    fn context_deserialises_from_camel_case() {
        let context: GatewayContext =
            serde_json::from_str(r#"{"taskId":"t-1","runId":"r-1"}"#).expect("parse");
        assert_eq!(context.task_id, "t-1");
        assert_eq!(context.run_id, "r-1");
    }

    #[test]
    fn error_codes_serialise_kebab_case() {
        // The renderer branches on these strings; changing one is a wire break.
        let json = serde_json::to_value(GatewayError::new(GatewayErrorCode::SpawnFailed, "boom"))
            .expect("serialise");
        assert_eq!(json["code"], serde_json::json!("spawn-failed"));
        assert_eq!(json["message"], serde_json::json!("boom"));
    }

    #[test]
    fn untrusted_bytes_become_text_rather_than_an_error() {
        // A shell tool emits whatever the command emitted; refusing the whole
        // call because of one invalid byte would lose the useful output.
        let text = to_text(vec![b'o', b'k', 0xff, b'!']);
        assert!(text.starts_with("ok"), "{text}");
        assert!(text.ends_with('!'), "{text}");
    }
}
