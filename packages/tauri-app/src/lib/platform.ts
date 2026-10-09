import { type as osType } from '@tauri-apps/plugin-os';

/**
 * Whether the app is running on macOS.
 *
 * Gating one behaviour today: `TaskDetail`'s "添加到日历" button, which writes
 * to the macOS calendar through the `event-helper` binary.
 *
 * # Why this cannot ask the webview
 *
 * The previous implementation guessed, and the guess was wrong in the only
 * environment that matters. It tried `process.platform` first — fine under
 * Node/Electron, but a WKWebView has no `process` — and fell back to
 * `navigator.userAgentData`, which Safari and WKWebView do not implement
 * either. So both branches missed and the function returned `false` on macOS
 * itself, hiding the calendar button on the one platform that has a calendar.
 *
 * The port removed the environment that made guessing work. What replaced it
 * is an actual answer from the host: `tauri-plugin-os` reports the platform it
 * was compiled for and exposes it synchronously, so this stays a plain
 * predicate that a render body can call.
 *
 * # Outside Tauri
 *
 * `osType()` reads an object the host injects at startup, so it throws where
 * that object does not exist — a browser, or a unit test that has not stubbed
 * it. Callers treat a missing host as "not a known desktop", which is the safe
 * direction: the calendar button stays hidden rather than appearing over a
 * button that cannot work.
 */
export function isMacOS(): boolean {
  try {
    return osType() === 'macos';
  } catch {
    return false;
  }
}
