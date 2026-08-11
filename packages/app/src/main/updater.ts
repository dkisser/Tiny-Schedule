import {
  type CheckUpdateResult,
  compareSemver,
  Ipc,
  normalizeVersion,
} from '@tiny-schedule/shared';
import type { BrowserWindow } from 'electron';
import type { Logger } from 'pino';

const UPDATE_URL = 'https://api.github.com/repos/dkisser/Tiny-Schedule/releases/latest';
const NOTES_MAX = 4000;
const TIMEOUT_MS = 10_000;

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

// net.fetch routes through the system proxy; plain global fetch does not.
async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  const { net } = await import('electron');
  return net.fetch(url, init);
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

export interface StartupUpdateCheckOpts {
  getVersion: () => string;
  getWindow: () => BrowserWindow | null;
  logger: Logger;
  fetchImpl?: FetchImpl;
}

function sendSafe(win: BrowserWindow | null, channel: string, payload: unknown): void {
  // check-ipc: ok — channel is an Ipc.* constant passed by callers
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Startup background check: push only when an update exists, log everything else. */
export async function startupUpdateCheck({
  getVersion,
  getWindow,
  logger,
  fetchImpl,
}: StartupUpdateCheckOpts): Promise<void> {
  const result = await checkForUpdate(getVersion(), { fetchImpl });
  if (result.error) {
    logger.info({ action: 'update:check', error: result.error });
    return;
  }
  if (result.hasUpdate) {
    logger.info({ action: 'update:available', latest: result.latest });
    sendSafe(getWindow(), Ipc.uiUpdateAvailable, result);
  }
}
