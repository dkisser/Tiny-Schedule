import { mock } from 'bun:test';
import * as realApp from '@tauri-apps/api/app';
import * as realCore from '@tauri-apps/api/core';
import * as realEvent from '@tauri-apps/api/event';
import * as realDialog from '@tauri-apps/plugin-dialog';
import * as realFs from '@tauri-apps/plugin-fs';
import * as realHttp from '@tauri-apps/plugin-http';
import * as realNotification from '@tauri-apps/plugin-notification';
import * as realOpener from '@tauri-apps/plugin-opener';

/**
 * Tauri module stubs that keep the real module's surface.
 *
 * `mock.module` is global to a bun test run. A test that replaced a Tauri
 * module with a hand-written literal published *only* the exports it happened
 * to name, so any other test file in the run that imported the same module
 * transitively — `@tauri-apps/api/app` wants `Resource`, `plugin-opener` and
 * `plugin-fs` want it too — would fail on `Export named 'Resource' not found`
 * depending on which file the runner happened to load first.
 *
 * Every stub here is therefore `{ ...real, ...overrides }`, so overriding one
 * function cannot remove the others. The real namespaces are captured by
 * *static* import at the top of this file, which is the part that matters: a
 * spread of `await import('@tauri-apps/api/core')` written *inside* the
 * factory resolves to the mock itself once the mock is registered, so the
 * spread silently becomes a no-op and the file is back to the original bug.
 *
 * Call {@link installTauriMocks} from a test file, then import the module under
 * test dynamically — `mock.module` is not hoisted above static imports.
 */

/** The `invoke` replacement: resolves to a value the caller chose. */
export type InvokeStub = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * The override maps are deliberately typed by *shape we care about*, not as
 * `Partial<typeof realModule>`. The real signatures are narrower than a test
 * wants to write — `invoke` is generic over its return type, `readTextFile`
 * takes `string | URL` plus options — and a test that stubs a path-shaped
 * argument should not have to restate the whole production signature to
 * satisfy the compiler. Spreading still replaces the real export wholesale, so
 * the looseness is in what a test may write, not in what the app sees.
 */
type Fn = (...args: never[]) => unknown;

export interface TauriMockOptions {
  core?: { invoke?: Fn; [key: string]: unknown };
  event?: { listen?: Fn; emit?: Fn; [key: string]: unknown };
  app?: { getVersion?: Fn; [key: string]: unknown };
  opener?: { openUrl?: Fn; [key: string]: unknown };
  http?: { fetch?: Fn; [key: string]: unknown };
  dialog?: {
    open?: Fn;
    save?: Fn;
    ask?: Fn;
    confirm?: Fn;
    message?: Fn;
    [key: string]: unknown;
  };
  fs?: {
    readTextFile?: Fn;
    writeTextFile?: Fn;
    readFile?: Fn;
    exists?: Fn;
    [key: string]: unknown;
  };
  notification?: {
    isPermissionGranted?: Fn;
    requestPermission?: Fn;
    sendNotification?: Fn;
    [key: string]: unknown;
  };
}

/** Defaults: every host call resolves to "nothing to do", so no test hangs. */
const DEFAULTS: Required<TauriMockOptions> = {
  core: { invoke: async () => undefined },
  event: { listen: async () => () => undefined, emit: async () => undefined },
  app: { getVersion: async () => '0.0.0' },
  opener: { openUrl: async () => undefined },
  http: { fetch: async () => new Response() },
  dialog: {
    open: async () => null,
    save: async () => null,
    ask: async () => false,
    confirm: async () => false,
    message: async () => undefined,
  },
  fs: {
    readTextFile: async () => '',
    writeTextFile: async () => undefined,
    readFile: async () => new Uint8Array(),
    exists: async () => false,
  },
  notification: {
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
    sendNotification: async () => undefined,
  },
};

export function installTauriMocks(options: TauriMockOptions = {}): void {
  // A caller that names one function in a group replaces only that function;
  // the rest of the group's defaults survive, which is what makes the spread
  // below safe to apply per-module.
  const merged = { ...DEFAULTS, ...options } as TauriMockOptions;
  mock.module('@tauri-apps/api/core', () => ({ ...realCore, ...merged.core }));
  mock.module('@tauri-apps/api/event', () => ({ ...realEvent, ...merged.event }));
  mock.module('@tauri-apps/api/app', () => ({ ...realApp, ...merged.app }));
  mock.module('@tauri-apps/plugin-opener', () => ({ ...realOpener, ...merged.opener }));
  mock.module('@tauri-apps/plugin-http', () => ({ ...realHttp, ...merged.http }));
  mock.module('@tauri-apps/plugin-dialog', () => ({ ...realDialog, ...merged.dialog }));
  mock.module('@tauri-apps/plugin-fs', () => ({ ...realFs, ...merged.fs }));
  mock.module('@tauri-apps/plugin-notification', () => ({
    ...realNotification,
    ...merged.notification,
  }));
}
