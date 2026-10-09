import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { type CheckUpdateResult, compareSemver, normalizeVersion } from '@tiny-schedule/shared';

/**
 * Update check, ported from packages/app/src/main/updater.ts.
 *
 * Two things changed and one did not.
 *
 * The ported part is the whole decision: query the GitHub releases API, strip
 * the `v` prefix, compare numerically per segment, truncate the notes, and
 * report every failure through `error` on the result rather than throwing. That
 * matrix is covered by the unit tests and must not drift.
 *
 * The first change is transport. `electron.net.fetch` routed through the
 * system proxy; the webview's bare `fetch` does not, so tauri-plugin-http
 * takes its place and {@link FetchImpl} stays the seam the tests inject at.
 *
 * The second is the event channel. The original pushed `Ipc.uiUpdateAvailable`
 * to the renderer over IPC; with no main process there is no peer to push to,
 * so the push became a local emitter ({@link subscribeUpdateAvailable}) and
 * `onUpdateAvailable` in `src/api/system.ts` is a plain subscription to it.
 * The signature the UI sees is unchanged: `(cb) => () => void`.
 */

const UPDATE_URL = 'https://api.github.com/repos/dkisser/Tiny-Schedule/releases/latest';
const NOTES_MAX = 4000;
const TIMEOUT_MS = 10_000;

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return tauriFetch(url, init);
}

export interface CheckForUpdateOpts {
  url?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/** Never throws: any failure is reported through `error` on the result. */
export async function checkForUpdate(
  currentVersion: string,
  opts: CheckForUpdateOpts = {},
): Promise<CheckUpdateResult> {
  const result: CheckUpdateResult = {
    current: currentVersion,
    hasUpdate: false,
    latest: null,
    url: null,
    notes: null,
  };
  try {
    const res = await (opts.fetchImpl ?? defaultFetch)(opts.url ?? UPDATE_URL, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    if (!res.ok) {
      result.error = `HTTP ${res.status}`;
      return result;
    }
    const release = (await res.json()) as GitHubRelease;
    const latest = release.tag_name ? normalizeVersion(release.tag_name) : null;
    if (!latest) {
      result.error = 'NO_TAG';
      return result;
    }
    result.latest = latest;
    result.url = release.html_url ?? null;
    result.notes = (release.body ?? '').slice(0, NOTES_MAX) || null;
    result.hasUpdate = compareSemver(latest, currentVersion) > 0;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

type UpdateListener = (result: CheckUpdateResult) => void;

const listeners = new Set<UpdateListener>();

/** Subscribes to the local update-available push. Returns an unsubscribe. */
export function subscribeUpdateAvailable(cb: UpdateListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Startup background check: push only when an update exists, swallow every
 * other outcome. Mirrors the original's `startupUpdateCheck`, minus the logger
 * — the webview has no pino, and a silent no-update check is not worth a
 * console line.
 */
export async function startupUpdateCheck(
  currentVersion: string,
  opts: CheckForUpdateOpts = {},
): Promise<void> {
  const result = await checkForUpdate(currentVersion, opts);
  if (result.error || !result.hasUpdate) return;
  for (const listener of listeners) listener(result);
}
