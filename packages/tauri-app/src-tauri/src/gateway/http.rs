//! Outbound HTTP for a scheduled task.
//!
//! A second, non-streaming counterpart to the [`crate::sse`] bridge: that one
//! exists because a chat stream cannot be read from the webview at all, this one
//! exists because a tool call is a question and an answer, and an answer fits in
//! a return value. Both are open channels to arbitrary hosts for the same
//! reason — the AI provider is a user setting, so no static host list could
//! ever be right — and both carry the same documented trust model: **the
//! webview is as trusted as the application code inside it.**
//!
//! The difference from `sse_request` is worth stating, because it looks like a
//! missing check: `sse_request` refuses every method but GET/POST and every
//! scheme but HTTP(S), and this module does not restrict the method at all. The
//! restriction there was about what *AI streaming* legitimately needs — an
//! unauthenticated GET, or a POST to a chat endpoint — and refusing the rest
//! cost nothing. Here the caller is an arbitrary tool, and a tool that cannot
//! PUT cannot do its job; the method is whatever the task author wrote.
//!
//! What is still enforced, because it holds regardless of trust: the scheme is
//! HTTP(S) — which is also all reqwest implements, so the check names the
//! problem instead of surfacing it as a transport error — and the response body
//! is capped at [`MAX_BODY_BYTES`].

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::{clamp_timeout, to_text, GatewayContext, GatewayError, GatewayErrorCode};

/// Hard ceiling on one request, whatever the caller asks for.
pub const MAX_HTTP_TIMEOUT: Duration = Duration::from_secs(600);

/// Largest response body the app will hold and hand back, in bytes.
///
/// One megabyte is comfortably more than a model's context can consume, so the
/// cap costs nothing useful; what it buys is that a `GET` of a multi-gigabyte
/// artifact cannot turn an unattended run into an out-of-memory kill of the app
/// itself. The overflow is dropped and `bodyTruncated` says so.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// The schemes this module will dial.
///
/// Not a permission decision — it is what reqwest speaks, and matching it here
/// turns "URL scheme is not allowed" (a transport error the caller learns
/// nothing from) into a message that names the URL. Checking it explicitly is
/// also what guarantees the request cannot quietly become something other than
/// a network request.
const ALLOWED_SCHEMES: [&str; 2] = ["http", "https"];

/// A single `httpRequest` call from the agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    /// Who is asking. Unused today, load-bearing the day permissions tighten.
    #[serde(flatten)]
    pub context: GatewayContext,
    /// Any HTTP method. Not restricted to the pair `sse_request` allows, for the
    /// reason given in the module docs.
    #[serde(default = "default_method")]
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    /// Optional deadline in milliseconds, clamped to [`MAX_HTTP_TIMEOUT`].
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

fn default_method() -> String {
    "GET".to_string()
}

/// Everything one request produced.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpOutcome {
    pub status: u16,
    /// Response headers, flattened to strings. Multi-valued headers keep their
    /// first value; a tool asking "what did the server say" is served by that,
    /// and keeping the full multi-map would put a shape the renderer has no use
    /// for on the wire.
    pub headers: HashMap<String, String>,
    pub body: String,
    /// Bytes actually returned, after the cap.
    pub body_bytes: usize,
    pub body_truncated: bool,
}

/// The process-wide client for gateway traffic.
///
/// Separate from [`crate::sse`]'s on purpose. That one must never carry a
/// request timeout — it exists to hold a stream open for as long as the model
/// keeps talking — and a shared client could only have one timeout. Both are
/// `OnceLock`-held so each is built once and keeps its connection pool and TLS
/// session across calls, rather than paying a full handshake per tool call.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// The gateway entry point for `httpRequest`.
pub async fn http_request(request: HttpRequest) -> Result<HttpOutcome, GatewayError> {
    let scheme = request
        .url
        .split_once("://")
        .map(|(scheme, _)| scheme.to_ascii_lowercase())
        .ok_or_else(|| {
            GatewayError::new(
                GatewayErrorCode::InvalidRequest,
                format!("url has no scheme: {}", redact(&request.url)),
            )
        })?;
    if !ALLOWED_SCHEMES.contains(&scheme.as_str()) {
        return Err(GatewayError::new(
            GatewayErrorCode::InvalidRequest,
            format!(
                "scheme {scheme:?} is not supported (expected one of {})",
                ALLOWED_SCHEMES.join(", ")
            ),
        ));
    }

    let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .map_err(|e| {
            GatewayError::new(
                GatewayErrorCode::InvalidRequest,
                format!("invalid method {:?}: {e}", request.method),
            )
        })?;

    let timeout = clamp_timeout(request.timeout_ms, MAX_HTTP_TIMEOUT);
    let mut builder = http_client().request(method, &request.url).timeout(timeout);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }

    let response = builder.send().await.map_err(|e| {
        GatewayError::new(
            GatewayErrorCode::Http,
            format!("request to {} failed: {e}", redact(&request.url)),
        )
    })?;

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

    let (bytes, truncated) = read_capped_body(response).await;
    let body_bytes = bytes.len();

    Ok(HttpOutcome {
        status,
        headers,
        body: to_text(bytes),
        body_bytes,
        body_truncated: truncated,
    })
}

/// Tauri entry point. Forwards to [`http_request`] and stamps the caller's
/// identity onto any failure.
#[tauri::command]
pub async fn scheduled_http_request(request: HttpRequest) -> Result<HttpOutcome, GatewayError> {
    let context = request.context.clone();
    http_request(request)
        .await
        .map_err(|e| e.with_context(&context))
}

/// A URL safe to put in an error message: scheme, host and path only.
///
/// Query strings are dropped because they carry credentials by convention —
/// `?api_key=…` and `?token=…` are ordinary on the APIs a tool would be pointed
/// at — and these errors reach both the renderer and the process log. Same rule
/// as [`crate::sse::redact`].
fn redact(url: &str) -> String {
    match url.split_once('?') {
        Some((before, _)) => format!("{before}?<redacted>"),
        None => url.to_string(),
    }
}

/// Accumulates the response body, stopping at [`MAX_BODY_BYTES`].
///
/// Unlike the exec pipes there is no need to drain: dropping the response
/// closes the connection, which is the correct outcome for a body nobody asked
/// for the rest of. A non-success status is *not* short-circuited — a 404 with
/// a JSON error body is more useful to a model than a 404 with no explanation,
/// and the body is what tells it whether to retry.
async fn read_capped_body(response: reqwest::Response) -> (Vec<u8>, bool) {
    let mut stream = response.bytes_stream();
    let mut kept: Vec<u8> = Vec::new();
    let mut truncated = false;

    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                let room = MAX_BODY_BYTES.saturating_sub(kept.len());
                if bytes.len() > room {
                    kept.extend_from_slice(&bytes[..room]);
                    truncated = true;
                    break;
                }
                kept.extend_from_slice(&bytes);
            }
            // Headers already arrived, so this is a truncated *body*, not a
            // failed request. Returning what landed beats discarding the whole
            // call; the renderer cannot tell the difference from `truncated`,
            // which is why both cases set the flag.
            Err(_) => return (kept, true),
        }
    }

    (kept, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str, method: &str) -> HttpRequest {
        HttpRequest {
            context: GatewayContext {
                task_id: "t-1".to_string(),
                run_id: "r-1".to_string(),
            },
            method: method.to_string(),
            url: url.to_string(),
            headers: HashMap::new(),
            body: None,
            timeout_ms: None,
        }
    }

    #[test]
    fn a_non_http_scheme_is_refused_with_the_url_named() {
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(http_request(request("file:///etc/passwd", "GET")))
            .expect_err("file:// must be refused");
        assert_eq!(error.code, GatewayErrorCode::InvalidRequest);
        assert!(error.message.contains("not supported"), "{}", error.message);
    }

    #[test]
    fn a_bare_host_is_refused_before_any_request() {
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(http_request(request("example.com/x", "GET")))
            .expect_err("a scheme-less url must be refused");
        assert!(error.message.contains("no scheme"), "{}", error.message);
    }

    #[test]
    fn the_scheme_check_is_case_insensitive() {
        // URLs are case-insensitive in the scheme; rejecting `HTTPS://` would be
        // a footgun rather than a defence.
        // Nothing is listening there, so the assertion is that the failure is a
        // transport error rather than a scheme rejection.
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(http_request(request("HTTPS://127.0.0.1:9/x", "GET")))
            .expect_err("nothing is listening on port 9");
        assert_eq!(error.code, GatewayErrorCode::Http);
    }

    #[test]
    fn an_unknown_method_is_refused_before_any_request() {
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(http_request(request("https://example.com", "BAD METHOD")))
            .expect_err("an invalid verb must be refused");
        assert_eq!(error.code, GatewayErrorCode::InvalidRequest);
        assert!(
            error.message.contains("invalid method"),
            "{}",
            error.message
        );
    }

    #[test]
    fn methods_outside_the_sse_allowlist_are_accepted() {
        // The deliberate difference from `sse_request`: a tool needs PUT/DELETE.
        // Asserted through validation only — nothing is dialled, because the
        // point is that the request is built rather than refused.
        for method in ["PUT", "DELETE", "PATCH", "HEAD"] {
            assert!(
                reqwest::Method::from_bytes(method.as_bytes()).is_ok(),
                "{method} should be a valid method"
            );
        }
    }

    #[test]
    fn errors_do_not_leak_the_query_string() {
        // `?api_key=…` is a real convention on the APIs a tool is pointed at,
        // and these strings reach both the renderer and the log.
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(http_request(request(
                "file:///etc/passwd?token=sk-secret",
                "GET",
            )))
            .expect_err("file:// must be refused");
        assert!(
            !error.message.contains("sk-secret"),
            "the token leaked: {}",
            error.message
        );
        assert_eq!(
            redact("https://api.example.com/v1/x?api_key=sk-secret"),
            "https://api.example.com/v1/x?<redacted>"
        );
    }

    #[test]
    fn the_client_is_shared_across_calls() {
        // Regression guard: a per-request `Client::new()` would pay a full TLS
        // handshake for every tool call, which is the most expensive part of the
        // round trip.
        assert!(
            std::ptr::eq(http_client(), http_client()),
            "http_client must return the same client every time"
        );
    }

    #[test]
    fn request_defaults_to_get() {
        let request: HttpRequest =
            serde_json::from_str(r#"{"taskId":"t-1","runId":"r-1","url":"https://example.com"}"#)
                .expect("parse");
        assert_eq!(request.method, "GET");
        assert!(request.headers.is_empty());
        assert!(request.body.is_none());
    }
}
