//! Path and window helpers the renderer cannot do on its own.
//!
//! The webview has no `process.env` and no `os.homedir()`, so the data
//! directory — the zero-migration contract — has to come from the host. Window
//! control is the other half of "system glue": it is a property of the native
//! window, not something the DOM can express.

use tauri::{Manager, WebviewWindow};

/// The user's home directory, or the reason there isn't one.
///
/// `HOME` is what a unix GUI launch populates and `USERPROFILE` the Windows
/// equivalent; reading only the first leaves every path that needs a home
/// directory failing on Windows. Tauri also hands a GUI-launched app a
/// different environment than a shell does, so both names are checked rather
/// than assumed.
///
/// One implementation, not one per caller: the data directory and the gateway's
/// `~` expansion both need this, and two copies of "where is home" drift apart
/// the moment one of them is fixed.
#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    for name in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(name) {
            if !home.is_empty() {
                return Ok(home);
            }
        }
    }
    Err("neither HOME nor USERPROFILE is set; cannot resolve the data directory".to_string())
}

/// Float the main window above other applications, or stop doing so.
///
/// `always_on_top` is the whole contract; the Electron original also passed a
/// per-platform level ('screen-saver' on macOS vs 'floating' elsewhere) and
/// called `show()` when enabling. Tauri has no equivalent level knob, so this
/// uses the plain flag and shows the window when raising it — a hidden window
/// that is "always on top" is not what the user asked for.
#[tauri::command]
pub fn set_always_on_top(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_always_on_top(enabled)
        .map_err(|e| format!("set_always_on_top failed: {e}"))?;
    if enabled {
        window.show().map_err(|e| format!("show failed: {e}"))?;
    }
    Ok(())
}

/// Bring the main window back, creating nothing.
///
/// Also un-hides: [`crate::close::on_window_event`] hides the window instead
/// of destroying it, because destroying the last window ends the process on
/// macOS. So this is what the Dock icon and `applicationShouldHandleReopen`
/// route to — the "reopen" the Electron `activate` handler used to implement
/// by building a fresh window.
#[tauri::command]
pub fn focus_main(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.show().map_err(|e| format!("show failed: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("set_focus failed: {e}"))
}
