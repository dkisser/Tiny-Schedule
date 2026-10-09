//! System idleness polling.
//!
//! The Electron original read this from `powerMonitor.getSystemIdleTime()` in
//! the main process, because the renderer is frozen while the machine sleeps
//! and could not observe it. That reasoning still holds, but the *number* now
//! travels as a Tauri event instead of staying in Rust: the auto-pause decision
//! needs the user's `idlePauseMinutes` setting and the running `ActiveTimer`,
//! and both live in the webview where the data store is.
//!
//! So Rust owns only the part it is uniquely good at — asking CoreGraphics how
//! long the HID system has been quiet — and pushes the answer every
//! [`IDLE_POLL_INTERVAL`]. The renderer decides what it means
//! (`bridge/systemEvents.ts`).

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// Event channel carrying the idle reading.
pub const SYSTEM_IDLE_EVENT: &str = "system:idle";

/// Poll faster than any sensible threshold so the pause point — which is
/// backdated by the measured idle time — stays accurate. Matches the
/// Electron original's `IDLE_POLL_MS`.
pub const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(20);

/// Payload of [`SYSTEM_IDLE_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleEvent {
    /// Seconds since the last user input event, as CoreGraphics reports it.
    pub seconds: f64,
}

/// Reads the current system idle time in seconds.
///
/// `kCGEventAny` is not exposed as a `CGEventType` constant, so it is
/// constructed from its documented value (`~0` widened to the u32 the type
/// wraps) — the same trick the C headers use.
#[cfg(target_os = "macos")]
pub fn system_idle_seconds() -> Option<f64> {
    use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType};

    /// `kCGEventAny`. The generated bindings omit it because it is `~0` rather
    /// than a named enumerator, so it is reconstructed from its documented
    /// value — the same thing the C header does.
    const HID_ANY: CGEventType = CGEventType(u32::MAX);

    let seconds =
        CGEventSource::seconds_since_last_event_type(CGEventSourceStateID::HIDSystemState, HID_ANY);
    if seconds.is_finite() && seconds >= 0.0 {
        Some(seconds)
    } else {
        None
    }
}

/// Non-macOS stub. The platform is macOS-only today (ADR 0003), but returning
/// `None` rather than failing to compile keeps the watcher honest if that
/// ever changes: an unreadable idle time must not look like "never idle".
#[cfg(not(target_os = "macos"))]
pub fn system_idle_seconds() -> Option<f64> {
    None
}

/// Starts the idle poller. Failures to read are logged and skipped: a dropped
/// sample only means the pause point is less precise, never that the timer
/// should be left running.
pub fn start_idle_watcher<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(IDLE_POLL_INTERVAL);
        // Without this, tokio's default (`Burst`) fires once per *missed* tick
        // to catch up: an hour of sleep is 180 ticks, so the app wakes to a
        // burst of 180 identical readings in a row, each one an IPC crossing
        // into the webview. `Skip` collapses them into a single catch-up tick,
        // which is what this poller wants — the value it emits is "how long
        // has the HID system been quiet", a level, not a per-interval delta,
        // so intermediate samples carry no information that the next one
        // lacks.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // The first tick completes immediately; skipping it means the reading
        // is "time since this process started", which is never meaningful.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            match system_idle_seconds() {
                Some(seconds) => {
                    let payload = IdleEvent { seconds };
                    if let Err(e) = app.emit(SYSTEM_IDLE_EVENT, payload) {
                        eprintln!("idle: emit {SYSTEM_IDLE_EVENT} failed: {e}");
                    }
                }
                None => eprintln!("idle: system idle time unavailable"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_payload_serialises_seconds_in_camel_case() {
        let json = serde_json::to_string(&IdleEvent { seconds: 42.5 }).expect("serialise");
        assert_eq!(json, r#"{"seconds":42.5}"#);
    }

    #[test]
    fn poll_interval_matches_the_electron_original() {
        assert_eq!(IDLE_POLL_INTERVAL, Duration::from_secs(20));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_idle_seconds_is_readable_and_plausible() {
        // A fresh process has had no input, so the reading must exist and be
        // finite. A `None` here means the CoreGraphics call stopped working,
        // which would silently disable idle auto-pause.
        let seconds = system_idle_seconds().expect("idle time should be readable on macOS");
        assert!(seconds >= 0.0, "idle time must not be negative: {seconds}");
    }
}
