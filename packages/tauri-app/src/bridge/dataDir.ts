/**
 * Where the app keeps `data.json`, `.key` and friends.
 *
 * This path is the zero-migration contract: it must resolve to exactly the
 * directory the Electron build wrote, or every existing user opens the Tauri
 * app to an empty slate.
 *
 * Verified against the shipped Electron build rather than assumed. Electron's
 * `app.getPath('userData')` is derived from the packaged `package.json`
 * `name` field — `@tiny-schedule/app` — and *not* from electron-builder's
 * `productName` ("Tiny Schedule"), which only names the .app bundle. Extracting
 * /Applications/Tiny Schedule.app/Contents/Resources/app.asar confirms the
 * packaged package.json carries `name: "@tiny-schedule/app"` and no
 * productName, so Electron's userData was:
 *
 *   ~/Library/Application Support/@tiny-schedule/app/
 *
 * Dev gets a separate directory. Electron's own dev run shares the release
 * directory, which meant a dev session could scribble on real data; the split
 * here is a deliberate improvement, not a parity bug.
 */

export function dataDirFor(env: { dev: boolean; home: string }): string {
  const appSupport = `${env.home}/Library/Application Support`;
  return env.dev ? `${appSupport}/@tiny-schedule/app-dev` : `${appSupport}/@tiny-schedule/app`;
}
