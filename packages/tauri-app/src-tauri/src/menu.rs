//! The application menu, ported from `packages/app/src/main/main.ts:114`.
//!
//! Tauri's menus are native and, unlike Electron's, are not event-driven
//! callbacks with a `click` handler per item: every item is identified by a
//! `MenuId`, and the app reacts to a single `MenuEvent`. So the Electron shape
//! "a submenu whose `新建任务` entry has `accelerator` + `click`" becomes "an
//! item with id `ui:new-task` and accelerator `CmdOrCtrl+N`", and the click
//! itself is [`emit_new_task`].
//!
//! Only the one accelerator the app defines is wired. The rest are Tauri's
//! predefined items (`copy`, `paste`, `minimize`, …), which are handled by the
//! OS and must not be forwarded.
//!
//! # Why 退出 is a custom item and not `.quit()`
//!
//! [`QUIT_MENU_ID`] looks like an odd way to write `PredefinedMenuItem::quit`,
//! and it is: the predefined item skips the one interception this app depends
//! on. tao (through Tauri) does not implement
//! `applicationShouldTerminate:`, so macOS routes both Cmd+Q and 退出 straight
//! to `LoopDestroyed` → `RunEvent::Exit` without ever raising
//! `RunEvent::ExitRequested`. The quit veto in [`crate::close`] therefore never
//! ran, and a quit with a running timer dropped the elapsed time on the floor
//! (tauri#9198, open since 2024-03-16; the fixing PR tao#1003 adds the missing
//! delegate method and is still unmerged, so there is no version to upgrade to).
//!
//! A custom item with an explicit `CmdOrCtrl+Q` accelerator does raise
//! `ExitRequested`, because the click goes through `AppHandle::exit` instead of
//! the OS's terminate action. The handler then asks the renderer to confirm.
//!
//! **Known gap — Dock 退出 is still unconfirmed.** Right-clicking the Dock icon
//! and choosing 退出 is the same `applicationShouldTerminate:` path as Cmd+Q
//! and is therefore *not* covered by the workaround. Closing the same gap needs
//! an `applicationShouldTerminate:` override on the `NSApplication` delegate,
//! which is not reachable through Tauri's safe API and would mean `unsafe`
//! objc2 code (or a fork of tao). This app is macOS-only and does not claim
//! parity for Dock 退出; see `close.rs` for the consequences.

use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Menu id of the "新建任务" item.
pub const NEW_TASK_MENU_ID: &str = "ui:new-task";

/// Menu id of the custom "退出" item.
///
/// Deliberately *not* `PredefinedMenuItem::quit`; see the module docs for why
/// that one bypasses the quit veto.
pub const QUIT_MENU_ID: &str = "app:quit";

/// Event channel the "新建任务" accelerator pushes on.
///
/// Note this is *not* `Ipc.uiNewTask` (`ui:newTask`) from
/// `@tiny-schedule/shared`. That constant names an Electron IPC channel; the
/// Tauri host pushes a webview event instead, and the event name is part of
/// this wave's pinned contract. The frontend subscribes to this string.
pub const UI_NEW_TASK_EVENT: &str = "ui:new-task";

/// Pushes the new-task request to the renderer.
///
/// The Electron original checked `win.isDestroyed()` before sending; Tauri
/// emits app-wide, and a payload with no listener is dropped rather than
/// queued, so there is nothing to guard against here.
pub fn emit_new_task<R: Runtime>(app: &AppHandle<R>) {
    if let Err(e) = app.emit(UI_NEW_TASK_EVENT, ()) {
        eprintln!("menu: emit {UI_NEW_TASK_EVENT} failed: {e}");
    }
}

/// Builds and installs the application menu.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let manager = app;
    let new_task = MenuItemBuilder::with_id(NEW_TASK_MENU_ID, "新建任务")
        .accelerator("CmdOrCtrl+N")
        .build(manager)?;

    let file = SubmenuBuilder::new(manager, "文件")
        .close_window()
        .build()?;
    let tasks = SubmenuBuilder::new(manager, "任务")
        .item(&new_task)
        .build()?;
    let edit = SubmenuBuilder::new(manager, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(manager, "视图").fullscreen().build()?;
    let window = SubmenuBuilder::new(manager, "窗口")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    // The app menu is macOS-only by convention: it is what gives the app
    // Cmd+Q (quit) and Cmd+H (hide). Windows/Linux get no equivalent, matching
    // Electron's `...(isMac ? [{ role: 'appMenu' }] : [])`. It also has to
    // lead the bar on macOS, or the system menu buttons have nowhere to live.
    let mut builder = MenuBuilder::new(manager);
    if cfg!(target_os = "macos") {
        let about = AboutMetadataBuilder::new()
            .name(Some("Tiny Schedule"))
            .version(Some(env!("CARGO_PKG_VERSION")))
            .build();
        let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, "退出")
            .accelerator("CmdOrCtrl+Q")
            .build(manager)?;
        let app_menu = SubmenuBuilder::new(manager, "Tiny Schedule")
            .about(Some(about))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&quit)
            .build()?;
        builder = builder.item(&app_menu);
    }
    let menu = builder
        .items(&[&file, &tasks, &edit, &view, &window])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// Routes menu events. Every other id belongs to a predefined item the OS
/// handles, and must not be forwarded.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        NEW_TASK_MENU_ID => emit_new_task(app),
        // `exit` rather than a direct emit, so the quit goes back through the
        // single interception point in `close.rs` and reuses its
        // already-approved latch. Calling `on_exit_requested` from here instead
        // would duplicate that decision in a second place.
        QUIT_MENU_ID => app.exit(0),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_task_item_id_is_the_event_channel() {
        // The frontend subscribes to whatever this constant is; keeping them
        // one value is what stops the accelerator from silently doing nothing.
        assert_eq!(NEW_TASK_MENU_ID, UI_NEW_TASK_EVENT);
    }

    #[test]
    fn quit_id_is_distinct_from_the_predefined_item() {
        // The whole point of QUIT_MENU_ID is that it is NOT the predefined quit
        // item, so it must not collide with any id Tauri routes internally. If
        // a future Tauri release starts emitting this id itself, the collision
        // would silently make Cmd+Q quit unconfirmed again.
        assert_ne!(QUIT_MENU_ID, "quit");
        assert_ne!(QUIT_MENU_ID, NEW_TASK_MENU_ID);
    }
}
