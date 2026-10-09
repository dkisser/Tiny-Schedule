//! Thin Rust shell for Tiny Schedule.
//!
//! Business logic lives in the renderer (TypeScript); this crate only does
//! system glue — windows, menus, notifications, file dialogs, the macOS idle
//! reading, spawning `event-helper` — plus the SSE bridge in [`sse`], which
//! exists because an OpenAI-compatible API sends no CORS headers and the
//! webview's own `fetch` therefore cannot stream from it.
//!
//! What survives from the Electron main process is only what genuinely needs a
//! native API or a process boundary. Anything that needed the data store went
//! to the renderer, which is where the data now lives — see
//! `docs/adr/0003-tauri-thin-rust-shell.md`.

pub mod calendar;
pub mod close;
pub mod host;
pub mod idle;
pub mod menu;
pub mod sse;

use tauri::Manager;

use close::QuitState;
use sse::SseState;

/// Permissions stay broad until each domain lands; the fs scopes are already
/// narrowed to the data directories.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        // Backs `isMacOS()` in src/lib/platform.ts, which gates the
        // "添加到日历" button. Without it there is no way for the webview to
        // learn the platform at all — see that file for what it replaced.
        .plugin(tauri_plugin_os::init())
        .manage(SseState::default())
        .manage(QuitState::default())
        .invoke_handler(tauri::generate_handler![
            host::home_dir,
            host::set_always_on_top,
            host::focus_main,
            sse::sse_request,
            sse::sse_cancel,
            close::confirm_close,
            calendar::calendar_add_task,
        ])
        .on_menu_event(|app, event| menu::on_menu_event(app, event.id().as_ref()))
        .on_window_event(close::on_window_event)
        .setup(|app| {
            menu::install(app.handle())?;
            idle::start_idle_watcher(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                // The quit veto lives here rather than on the window event: macOS
                // ends the process when its last window closes, so intercepting
                // `WindowEvent::CloseRequested` cannot tell "close this window"
                // apart from "quit", and conflating them let Cmd+W kill the app
                // without ever asking about a running timer. See `close.rs`.
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let state = app.state::<QuitState>();
                    if state.is_approved() {
                        return;
                    }
                    api.prevent_exit();
                    close::on_exit_requested(app, &state);
                }
                // Dock click, the macOS equivalent of Electron's `activate`.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => close::on_reopen(app),
                _ => {}
            }
        });
}
