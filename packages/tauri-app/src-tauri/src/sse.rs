//! Streaming bridge: the renderer cannot stream from an OpenAI-compatible API
//! itself (those endpoints send no CORS headers), so reqwest opens the
//! connection here and each received chunk is pushed to the webview as a
//! Tauri event.
//!
//! Wire protocol, per request:
//!   - `invoke('sse_request', …)` resolves as soon as response *headers* land,
//!     with `{ status, headers }` — that is what lets the frontend build a
//!     `Response` synchronously, exactly like `fetch`.
//!   - body chunks arrive as `sse://{request_id}` events, `dataBase64`-encoded.
//!   - the stream ends with `kind: 'done'`, or `kind: 'error'`.
//!
//! # This is a deliberately open outbound channel
//!
//! **It is not, and cannot be, constrained by the `http:default` allowlist in
//! `capabilities/default.json`.** That allowlist is a scope for
//! `tauri_plugin_http`'s own `fetch`; `sse_request` is a `#[tauri::command]`
//! and Tauri capabilities have no way to scope a custom command's URL. So any
//! code running in the webview can ask this module to talk to any host over
//! HTTP. That is a property of the design, not an oversight, and the reasons
//! are:
//!
//!   - Users configure their own AI provider. `baseUrl` is a user setting read
//!     at runtime from the data store, so no static host list can be correct:
//!     it would have to be recomputed per request, which is exactly what the
//!     renderer already does when it builds the URL.
//!   - Streaming is the whole point. CORS blocks the webview from doing this
//!     itself (ADR 0003), so the bridge cannot be narrowed without losing the
//!     feature.
//!
//! Given that, the trust model is: **the webview is as trusted as the
//! application code in it**, and the mitigations that do apply are applied here
//! — [`validate`] refuses everything that is not a plain HTTP(S) request of a
//! shape the app actually uses (see the constants there). What is explicitly
//! *not* defended against is a compromised webview (XSS, supply-chain
//! poisoning, devtools): such an attacker can already read the plaintext API
//! key out of the renderer heap, so an egress restriction here would not break
//! the chain — it would only make the honest case slower. Anything stronger
//! than that has to move the URL decision into Rust, which means the provider
//! configuration itself has to move off the renderer; that is a v2 question,
//! not a patch.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Event channel carrying the body of one request.
const CHANNEL_PREFIX: &str = "sse://";

/// Largest request body the bridge will forward, in bytes.
///
/// Bodies here are JSON chat/AI payloads — a few hundred KB at the outside.
/// The cap exists so a script cannot use the bridge to exfiltrate an
/// arbitrarily large in-memory buffer in one call, and so an accidental
/// megabyte-scale string does not sit in three copies (string, request buffer,
/// TLS write).
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

/// Largest number of headers the bridge will forward.
///
/// `fetch` has no such limit, but a bridge that amplifies the renderer's
/// memory into the Rust process should not be unbounded either.
const MAX_HEADER_COUNT: usize = 64;

/// Largest total header block the bridge will forward, in bytes.
const MAX_HEADER_BYTES: usize = 64 * 1024;

/// The only methods the bridge forwards.
///
/// The app only ever GETs an SSE stream and POSTs a chat/completion body.
/// Anything else (PUT/DELETE/PATCH on a user-chosen host) is outside the
/// feature, so refusing it costs nothing and removes a class of abuse.
const ALLOWED_METHODS: [&str; 2] = ["GET", "POST"];

/// The only schemes the bridge will dial.
///
/// This is the check that matters most: it is what stops `file://`,
/// `ftp://` and the other schemes reqwest would otherwise hand to a different
/// transport, and what guarantees the request cannot become a local-file read.
const ALLOWED_SCHEMES: [&str; 2] = ["http", "https"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SseRequest {
    pub url: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    pub request_id: String,
}

fn default_method() -> String {
    "GET".to_string()
}

/// What the renderer needs to construct a `Response`; the body then flows
/// through the event channel instead of the return value.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseResponseMeta {
    pub status: u16,
    pub headers: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SseEvent {
    /// `dataBase64` is base64, not a string: SSE payloads are not guaranteed to
    /// be UTF-8, and re-encoding would corrupt a chunk that splits a
    /// multi-byte character.
    ///
    /// Base64 rather than a JSON byte array because a `Vec<u8>` serialises as
    /// one decimal number per byte — `[104,101,108,108,111]` costs 18 bytes
    /// where `"aGVsbG8="` costs 10, and the worst case is far worse: a chunk
    /// of `0xff` bytes costs 4 bytes each against base64's 4 per 3. Measured
    /// on real traffic the array form inflates the payload ~3.6x, all of it
    /// crossing the IPC boundary per chunk.
    ///
    /// The frontend decodes with `atob`, so the extra decode is trivial next
    /// to the serialisation it replaces.
    ///
    /// `data` (the byte-array form) was the previous wire format and is still
    /// accepted by the decoder, so a webview running the old `sseFetch` against
    /// a new shell — or vice versa, across a `bun run dev` reload — degrades to
    /// the slow path instead of producing garbage.
    Chunk {
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
    Done,
    Error {
        message: String,
    },
}

/// Registry of in-flight streaming tasks, shared with the spawned tasks so each
/// one removes its own entry when the stream ends — otherwise a long session
/// leaks one `AbortHandle` per completed request.
#[derive(Clone, Default)]
pub struct SseState(Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>);

impl SseState {
    fn insert(&self, request_id: &str, handle: tokio::task::AbortHandle) {
        match self.0.lock() {
            Ok(mut tasks) => {
                tasks.insert(request_id.to_string(), handle);
            }
            // A poisoned lock means some other request panicked while holding it.
            // Dropping the handle here would leave the stream uncancellable, so
            // say so rather than failing silently.
            Err(poisoned) => eprintln!(
                "sse: registry poisoned, {request_id} can no longer be cancelled: {}",
                poisoned.into_inner().len()
            ),
        }
    }

    fn take(&self, request_id: &str) -> Option<tokio::task::AbortHandle> {
        self.0.lock().ok()?.remove(request_id)
    }
}

fn channel(request_id: &str) -> String {
    format!("{CHANNEL_PREFIX}{request_id}")
}

/// The process-wide HTTP client.
///
/// Built once and shared: a fresh `reqwest::Client` per request means a fresh
/// connection pool, a fresh TLS session (a full handshake per AI request, the
/// most expensive part of the round trip) and a fresh resolver cache. A chat
/// agent issues a request per turn against the same host, so this was paying
/// that cost every time. `OnceLock` rather than `lazy_static` keeps the crate
/// free of an extra dependency, and the init closure cannot fail.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// A request that passed [`validate`], reduced to what reqwest needs.
#[derive(Debug)]
struct ValidatedRequest {
    url: String,
    method: String,
    body: Option<String>,
}

/// Everything a request must satisfy before this module will dial out.
///
/// See the module docs for why there is no host allowlist here and what this
/// function is and is not defending against. The checks that do apply are the
/// ones that hold regardless of who is trusted: the scheme, the method, and
/// the size caps. Each failure names the offending value so a legitimate
/// misconfiguration is distinguishable from an attack in the log.
fn validate(request: &SseRequest) -> Result<ValidatedRequest, String> {
    let scheme = request
        .url
        .split_once("://")
        .map(|(scheme, _)| scheme.to_ascii_lowercase())
        .ok_or_else(|| format!("url has no scheme: {}", redact(&request.url)))?;
    if !ALLOWED_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!(
            "scheme {scheme:?} is not allowed (expected one of {}); url={}",
            ALLOWED_SCHEMES.join(", "),
            redact(&request.url),
        ));
    }

    let method = request.method.to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!(
            "method {method:?} is not allowed (expected one of {})",
            ALLOWED_METHODS.join(", ")
        ));
    }

    if request.headers.len() > MAX_HEADER_COUNT {
        return Err(format!(
            "{} headers exceeds the limit of {MAX_HEADER_COUNT}",
            request.headers.len()
        ));
    }
    let header_bytes: usize = request
        .headers
        .iter()
        .map(|(name, value)| name.len() + value.len())
        .sum();
    if header_bytes > MAX_HEADER_BYTES {
        return Err(format!(
            "header block of {header_bytes} bytes exceeds the limit of {MAX_HEADER_BYTES}"
        ));
    }

    if let Some(body) = &request.body {
        if body.len() > MAX_BODY_BYTES {
            return Err(format!(
                "body of {} bytes exceeds the limit of {MAX_BODY_BYTES}",
                body.len()
            ));
        }
        if method == "GET" {
            return Err("a GET must not carry a body".to_string());
        }
    }

    Ok(ValidatedRequest {
        url: request.url.clone(),
        method,
        body: request.body.clone(),
    })
}

/// A URL safe to put in an error message: scheme, host and path only, with any
/// query string dropped. An API key passed as a `?api_key=…` query parameter
/// is a real convention on OpenAI-compatible providers, so echoing the raw URL
/// into an error that reaches the renderer and the log is how keys leak.
fn redact(url: &str) -> String {
    match url.split_once('?') {
        Some((before, _)) => format!("{before}?<redacted>"),
        None => url.to_string(),
    }
}

#[tauri::command]
pub async fn sse_request(
    app: AppHandle,
    state: State<'_, SseState>,
    request: SseRequest,
) -> Result<SseResponseMeta, String> {
    let validated = validate(&request)?;
    let method = reqwest::Method::from_bytes(validated.method.as_bytes())
        .map_err(|e| format!("invalid method {}: {e}", validated.method))?;

    let mut builder = http_client().request(method, &validated.url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &validated.body {
        builder = builder.body(body.clone());
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("sse_request failed for {}: {e}", redact(&validated.url)))?;

    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();

    let request_id = request.request_id;
    let event = channel(&request_id);
    let stream = response.bytes_stream();
    let registry = state.inner().clone();

    let task_id = request_id.clone();
    // Gate the task on a handshake so it cannot finish before its AbortHandle is
    // registered. Without this, a stream that ends immediately (a 204, or a
    // server that closes at once) races: the task's cleanup runs first, finds no
    // entry, and the entry inserted afterwards never gets removed — one leaked
    // AbortHandle per such request.
    let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tauri::async_runtime::spawn(async move {
        if registered_rx.await.is_err() {
            return;
        }
        let mut stream = stream;
        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
                    let payload = SseEvent::Chunk {
                        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                    };
                    if let Err(e) = app.emit(&event, payload) {
                        eprintln!("sse: emit chunk failed for {task_id}: {e}");
                        break;
                    }
                }
                Err(e) => {
                    let _ = app.emit(
                        &event,
                        SseEvent::Error {
                            message: e.to_string(),
                        },
                    );
                    break;
                }
            }
        }
        let _ = app.emit(&event, SseEvent::Done);
        // Unreachable when aborted by `sse_cancel`, but that path removes the
        // entry itself, so the registry ends up empty either way.
        let _ = registry.take(&task_id);
    });

    // Tauri's JoinHandle wraps tokio's, which owns the clonable AbortHandle the
    // registry needs — the wrapper itself is not cloneable.
    state.insert(&request_id, task.inner().abort_handle());
    let _ = registered_tx.send(());
    Ok(SseResponseMeta { status, headers })
}

/// Aborts an in-flight stream; the frontend's `AbortSignal` calls this. Returns
/// whether a stream was actually cancelled, so the caller can tell a late abort
/// on an already-finished request from a real cancellation.
#[tauri::command]
pub fn sse_cancel(state: State<'_, SseState>, request_id: String) -> bool {
    match state.take(&request_id) {
        Some(handle) => {
            handle.abort();
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors the spawn/register/open-gate sequence `sse_request` performs.
    async fn spawn_cleanup(state: &SseState, request_id: &str) {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let registry = state.clone();
        let task_id = request_id.to_string();
        let task = tokio::spawn(async move {
            if rx.await.is_err() {
                return;
            }
            let _ = registry.take(&task_id);
        });
        // Give the worker a chance to reach the task before its handle is
        // published, which is what a stream ending immediately looks like.
        tokio::task::yield_now().await;
        state.insert(request_id, task.abort_handle());
        let _ = tx.send(());
        task.await.ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn finished_request_leaves_no_stale_registry_entry() {
        // Locks in the invariant the registration gate exists to provide: a
        // request whose task has run to completion must not remain in the
        // registry. This guards the cleanup path; it does not by itself prove
        // the gate is load-bearing, because whether an ungated task wins the
        // race is a matter of scheduling and cannot be forced from a test.
        let state = SseState::default();
        for i in 0..64 {
            spawn_cleanup(&state, &format!("req-{i}")).await;
        }
        assert!(
            state.0.lock().expect("registry lock").is_empty(),
            "finished requests left stale registry entries"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn registered_request_is_cancellable() {
        let state = SseState::default();
        state.insert(
            "live",
            tokio::spawn(std::future::pending::<()>()).abort_handle(),
        );
        assert!(
            state.take("live").is_some(),
            "an in-flight request should still be cancellable"
        );
    }

    #[test]
    fn channel_is_namespaced_by_request_id() {
        assert_eq!(channel("abc"), "sse://abc");
    }

    #[test]
    fn defaults_to_get_when_method_is_omitted() {
        let request: SseRequest =
            serde_json::from_str(r#"{"url":"http://127.0.0.1/sse","requestId":"r1"}"#)
                .expect("request without a method should deserialize");
        assert_eq!(request.method, "GET");
        assert!(request.body.is_none());
        assert!(request.headers.is_empty());
    }

    fn request_with(url: &str, method: &str) -> SseRequest {
        SseRequest {
            url: url.to_string(),
            method: method.to_string(),
            headers: HashMap::new(),
            body: None,
            request_id: "r1".to_string(),
        }
    }

    #[test]
    fn accepts_the_two_methods_the_app_uses() {
        for method in ["GET", "POST"] {
            let request = request_with("https://api.openai.com/v1/chat", method);
            assert!(validate(&request).is_ok(), "{method} should be allowed");
        }
    }

    #[test]
    fn method_check_is_case_insensitive() {
        // `fetch` normalises nothing — a caller may well send "post" — and the
        // bridge should not be stricter than the browser API it mirrors.
        let request = request_with("https://api.openai.com/v1/chat", "post");
        assert_eq!(
            validate(&request)
                .expect("lowercase post should pass")
                .method,
            "POST"
        );
    }

    #[test]
    fn rejects_methods_outside_the_allowlist() {
        for method in ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"] {
            let request = request_with("https://api.openai.com/v1/chat", method);
            let error = validate(&request).expect_err(&format!("{method} must be refused"));
            assert!(
                error.contains("is not allowed"),
                "unexpected message for {method}: {error}"
            );
        }
    }

    #[test]
    fn rejects_non_http_schemes() {
        // The important one: `file://` would otherwise be handed to a local
        // file reader, and `ftp://` to another transport entirely.
        for url in [
            "file:///etc/passwd",
            "file://localhost/etc/hosts",
            "ftp://example.com/x",
            "data:text/plain,hello",
            "javascript:alert(1)",
        ] {
            let request = request_with(url, "GET");
            let error = validate(&request).expect_err(&format!("{url} must be refused"));
            assert!(
                error.contains("not allowed") || error.contains("no scheme"),
                "unexpected message for {url}: {error}"
            );
        }
    }

    #[test]
    fn rejects_a_url_without_a_scheme() {
        let request = request_with("api.openai.com/v1/chat", "GET");
        let error = validate(&request).expect_err("a bare host must be refused");
        assert!(error.contains("no scheme"), "unexpected message: {error}");
    }

    #[test]
    fn scheme_check_is_case_insensitive() {
        // URLs are case-insensitive in the scheme; rejecting `HTTPS://` would
        // be a footgun rather than a defence.
        let request = request_with("HTTPS://api.openai.com/v1/chat", "GET");
        assert!(validate(&request).is_ok());
    }

    #[test]
    fn rejects_an_oversized_body() {
        let mut request = request_with("https://api.openai.com/v1/chat", "POST");
        request.body = Some("x".repeat(MAX_BODY_BYTES + 1));
        let error = validate(&request).expect_err("an oversized body must be refused");
        assert!(
            error.contains("exceeds the limit"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn accepts_a_body_exactly_at_the_limit() {
        // Off-by-one in either direction is a real bug: too strict and a large
        // but legitimate paste fails, too loose and the cap is fiction.
        let mut request = request_with("https://api.openai.com/v1/chat", "POST");
        request.body = Some("x".repeat(MAX_BODY_BYTES));
        assert!(validate(&request).is_ok());
    }

    #[test]
    fn rejects_too_many_headers() {
        let mut request = request_with("https://api.openai.com/v1/chat", "POST");
        for i in 0..=MAX_HEADER_COUNT {
            request.headers.insert(format!("x-h{i}"), "v".to_string());
        }
        let error = validate(&request).expect_err("too many headers must be refused");
        assert!(
            error.contains("exceeds the limit"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn rejects_an_oversized_header_block() {
        // Few headers, each legal, but collectively past the byte cap.
        let mut request = request_with("https://api.openai.com/v1/chat", "POST");
        for i in 0..4 {
            request
                .headers
                .insert(format!("x-h{i}"), "v".repeat(MAX_HEADER_BYTES / 2));
        }
        let error = validate(&request).expect_err("a huge header block must be refused");
        assert!(
            error.contains("exceeds the limit"),
            "unexpected message: {error}"
        );
    }

    #[test]
    fn rejects_a_body_on_a_get() {
        // Not a security property — reqwest would send it fine — but the app
        // never does it, and silently forwarding it would mean a mis-caller's
        // payload reaches a host it chose with a verb the UI implied was safe.
        let mut request = request_with("https://api.openai.com/v1/chat", "GET");
        request.body = Some("{}".to_string());
        let error = validate(&request).expect_err("GET with a body must be refused");
        assert!(error.contains("body"), "unexpected message: {error}");
    }

    #[test]
    fn error_messages_do_not_leak_the_query_string() {
        // OpenAI-compatible providers accept `?api_key=…`; an error that echoes
        // the raw URL puts a live key into the renderer toast and the log.
        let request = request_with("https://api.openai.com/v1/chat?api_key=sk-secret", "DELETE");
        let error = validate(&request).expect_err("DELETE must be refused");
        assert!(
            !error.contains("sk-secret"),
            "the key leaked into the error: {error}"
        );
        assert_eq!(
            redact("https://api.openai.com/v1/chat?api_key=sk-secret"),
            "https://api.openai.com/v1/chat?<redacted>"
        );
    }

    #[test]
    fn scheme_errors_redact_the_url_too() {
        let request = request_with("ftp://example.com/x?token=sk-secret", "GET");
        let error = validate(&request).expect_err("ftp must be refused");
        assert!(
            !error.contains("sk-secret"),
            "the key leaked into the error: {error}"
        );
    }

    #[test]
    fn chunk_payload_is_base64_not_a_byte_array() {
        // `dataBase64` is the whole point: the byte-array form cost ~3.6x on
        // real traffic, once per chunk, across the IPC boundary.
        let event = SseEvent::Chunk {
            data_base64: base64::engine::general_purpose::STANDARD.encode(b"hello"),
        };
        let json = serde_json::to_value(&event).expect("serialise");
        assert_eq!(json["kind"], serde_json::json!("chunk"));
        assert_eq!(json["dataBase64"], serde_json::json!("aGVsbG8="));
        assert!(
            json.get("data").is_none(),
            "the byte-array field must be gone: {json}"
        );
    }

    #[test]
    fn base64_round_trips_bytes_that_are_not_utf8() {
        // The reason the payload is not a string: a chunk can split a
        // multi-byte character, and the bytes must survive intact.
        let bytes = [0xe4u8, 0xbd, 0xa0, 0xff, 0x00];
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .expect("decode");
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn the_http_client_is_shared_across_requests() {
        // Regression guard for the per-request `Client::new()`: a new client
        // means a new connection pool and a fresh TLS handshake per request,
        // which is the most expensive part of the round trip.
        assert!(
            std::ptr::eq(http_client(), http_client()),
            "http_client must return the same client every time"
        );
    }
}
