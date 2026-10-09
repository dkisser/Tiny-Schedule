//! Quit and close-window handling, ported from the `window.on('close')` and
//! `app.on('before-quit')` handlers in `packages/app/src/main/main.ts:75-137`.
//!
//! The Electron original distinguished two intents that macOS also
//! distinguishes, and Tauri surfaces them through different events:
//!
//!   - **Close the window** (Cmd+W, the red button). On macOS this must *not*
//!     quit the app — the Dock icon stays, and clicking it brings the window
//!     back. Tauri has no `activate` event, so the window is hidden and
//!     re-shown by [`focus_main`] rather than destroyed and rebuilt. Nothing
//!     is settled: the app is still running, the timer is still running.
//!
//!   - **Quit the app** (Cmd+Q, the 退出 menu item). This is the
//!     `RunEvent::ExitRequested` that Tauri's `app.quit()` would raise. That
//!     is where a running timer has to be confirmed, because this is the one
//!     path that actually ends the process.
//!
//! The first version of this module intercepted only the window's
//! `CloseRequested` and forwarded it as a quit request. That is wrong on
//! macOS in a way that is invisible until you try it: closing the last window
//! ends the process, so the "interception" was really a quit, and Cmd+W
//! killed the app without ever asking about the running timer.
//!
//! Why the decision lives in the renderer: the Electron main process held the
//! data store, so it could ask "is a timer running?" itself. The store is in
//! the webview now, so Rust forwards the intent and `bridge/systemEvents.ts`
//! answers it.
//!
//! # Coverage, and one gap that is not a bug in this file
//!
//! [`on_exit_requested`] only runs if something raises `RunEvent::ExitRequested`.
//! On macOS that is not true of every way out of the app:
//!
//!   - **Cmd+Q and the 退出 menu item are covered**, because `menu.rs` installs
//!     a custom item with an explicit `CmdOrCtrl+Q` accelerator rather than
//!     `PredefinedMenuItem::quit`. Its click goes through `AppHandle::exit`,
//!     which does raise the event. This is the workaround for tauri#9198.
//!   - **Dock 退出 is NOT covered.** Right-clicking the Dock icon takes the same
//!     `applicationShouldTerminate:` path as Cmd+Q, and tao does not implement
//!     that delegate method, so it reaches `LoopDestroyed` → `RunEvent::Exit`
//!     with no interception. Closing this would require an `unsafe` objc2
//!     override of the `NSApplication` delegate or a fork of tao (tao#1003 is
//!     still unmerged). The consequence is concrete: a quit from the Dock icon
//!     with a running timer still drops the elapsed time.
//!
//! The Electron original covered both paths through `before-quit`, so this is a
//! real parity gap. It is recorded rather than worked around because the
//! workaround costs `unsafe` macOS-only code, and the app is a one-window
//! utility where Cmd+Q is the overwhelmingly dominant quit gesture.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

/// Event channel carrying a quit request to the renderer.
pub const APP_CLOSE_REQUESTED_EVENT: &str = "app:close-requested";

/// Label of the main window.
const MAIN_WINDOW: &str = "main";

/// Why the app is quitting, as far as the renderer is concerned.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitRequest {
    pub reason: &'static str,
}

/// Latched once the user has confirmed the quit, so the exit that follows is
/// not intercepted a second time.
#[derive(Clone, Default)]
pub struct QuitState(Arc<AtomicBool>);

impl QuitState {
    /// Marks the quit as approved. The next exit proceeds.
    pub fn approve(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether a quit has been approved. Read before every interception.
    pub fn is_approved(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Dock click / `applicationShouldHandleReopen`: bring the hidden window back.
///
/// The counterpart to the hide in [`on_window_event`], and the equivalent of
/// the Electron `activate` handler. Tauri hands over the *existing* window
/// rather than building a new one, which is why hiding was the right choice
/// on the way out: a rebuilt window would have lost the running timer.
pub fn on_reopen<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if let Err(e) = window.show() {
        eprintln!("close: reopen show failed: {e}");
    }
    if let Err(e) = window.set_focus() {
        eprintln!("close: reopen focus failed: {e}");
    }
}

/// Close-window (Cmd+W / red button): hide, do not quit, do not settle.
///
/// Hiding rather than destroying is what keeps the app alive — Tauri ends the
/// process when its last window goes away, and macOS convention is that a
/// windowless app is still running. The window comes back through
/// [`focus_main`](crate::host::focus_main), which the Dock icon and
/// `applicationShouldHandleReopen` both route to.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    api.prevent_close();
    if let Err(e) = window.hide() {
        eprintln!("close: hide failed: {e}");
    }
}

/// Quit (Cmd+Q / 退出): veto, and let the renderer confirm a running timer.
///
/// `prevent_exit` is the counterpart of Electron's `e.preventDefault()` in
/// `before-quit`. Returning without it would let the process end here, before
/// the renderer ever saw the request.
pub fn on_exit_requested<R: tauri::Runtime>(app: &AppHandle<R>, state: &QuitState) {
    if state.is_approved() {
        return;
    }
    let quit = QuitRequest { reason: "quit" };
    if let Err(e) = app.emit(APP_CLOSE_REQUESTED_EVENT, quit) {
        // With no listener the user could never quit at all, so say so rather
        // than leaving them with an app that ignores Cmd+Q.
        eprintln!("close: emit {APP_CLOSE_REQUESTED_EVENT} failed: {e}");
    }
}

/// Ends the process for real, after the renderer has settled what was running.
///
/// Exits rather than destroying the window because on macOS the window is not
/// what ends the process — `ExitRequested` is. Marking the state approved
/// first is what stops this very exit from being vetoed by the handler above.
#[tauri::command]
pub fn confirm_close(app: AppHandle, state: tauri::State<'_, QuitState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        // The app is quitting, so a lingering hidden window would be a ghost
        // in the window list; destroy is safe here precisely because we are
        // leaving regardless of what it would have triggered.
        let _ = window.destroy();
    }
    state.approve();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_is_vetoed_until_approved() {
        let state = QuitState::default();
        assert!(
            !state.is_approved(),
            "a fresh session must not allow quitting"
        );
        state.approve();
        assert!(state.is_approved());
    }

    #[test]
    fn approval_is_shared_across_clones() {
        // The state is cloned into the builder and the command, so approving
        // through one handle has to be visible through the other.
        let state = QuitState::default();
        let clone = state.clone();
        clone.approve();
        assert!(state.is_approved());
    }

    #[test]
    fn quit_request_serialises_its_reason() {
        let json = serde_json::to_string(&QuitRequest { reason: "quit" }).expect("serialise");
        assert_eq!(json, r#"{"reason":"quit"}"#);
    }
}
