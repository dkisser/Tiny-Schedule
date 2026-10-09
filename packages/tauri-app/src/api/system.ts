import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  CalendarAddTaskInputSchema,
  type CalendarAddTaskOutput,
  type CheckUpdateResult,
  OpenExternalReqSchema,
  type RendererApi,
} from '@tiny-schedule/shared';
import type { DataStore } from '@/bridge/dataStore';
import { checkForUpdate, type FetchImpl, subscribeUpdateAvailable } from '@/bridge/updater';

/**
 * The system slice: external links, update checks, calendar writes.
 *
 * The three behaviours that must not drift are the https-only allowlist, the
 * "prompt but never download" update semantics, and the calendar contract with
 * the Rust shell (see {@link calendarAddTask}).
 */

/**
 * Only `https:` reaches the opener. The original's `shell.openExternal` would
 * happily launch `file:`, `javascript:` or an app bundle URL, which turns this
 * channel into a way to run local code from a link in a task title.
 */
export function isAllowedExternalUrl(url: string): boolean {
  return url.startsWith('https://');
}

/**
 * `formatCalendarTitle` from packages/app/src/main/macos/calendar.ts.
 *
 * The task title is snapshotted with its project prefix *before* crossing into
 * Rust, because the Rust side receives plain strings and has no data store to
 * resolve `projectId` from. It is duplicated rather than moved: `packages/shared`
 * is shared with the Electron build and is not this package's to change.
 */
function formatCalendarTitle(taskTitle: string, projectTitle?: string): string {
  const proj = projectTitle?.trim();
  if (!proj) return taskTitle;
  return `[${proj}] ${taskTitle}`;
}

export interface SystemApiDeps {
  /** Injected in tests; production reads the version Tauri was built with. */
  getVersion?: () => Promise<string>;
  /** Injected in tests; production opens the URL with the system handler. */
  openExternal?: (url: string) => Promise<void>;
  /** Injected in tests; production goes through tauri-plugin-http. */
  fetchImpl?: FetchImpl;
  /**
   * Injected in tests. This slice is where the Tauri command names and their
   * argument names are the contract, so the tests assert against a recorded
   * call rather than a module mock.
   */
  invokeFn?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

export function createSystemApi(
  store: DataStore,
  deps: SystemApiDeps = {},
): Pick<
  RendererApi,
  'appOpenExternal' | 'appCheckUpdate' | 'onUpdateAvailable' | 'calendarAddTask'
> {
  const openExternal = deps.openExternal ?? ((url: string) => openUrl(url));
  const invokeCommand = deps.invokeFn ?? invoke;

  return {
    appOpenExternal: async (raw): Promise<void> => {
      // Contract parse, as `api/data.ts` does per call: with the ipcMain loop
      // gone the zod guard lives at the call site. The whitelist below is a UX
      // guard, not a permission boundary — see `isAllowedExternalUrl` — so the
      // shape check is what keeps a non-URL from reaching the opener at all.
      const { url } = OpenExternalReqSchema.parse(raw);
      if (!isAllowedExternalUrl(url)) return;
      await openExternal(url);
    },

    appCheckUpdate: async (): Promise<CheckUpdateResult> => {
      // Electron's `app.getVersion()` reads the same packaged version string
      // Tauri bakes into the bundle, so the comparison baseline is unchanged.
      const current = deps.getVersion ? await deps.getVersion() : await getVersion();
      return checkForUpdate(current, { fetchImpl: deps.fetchImpl });
    },

    // The Electron preload pushed `Ipc.uiUpdateAvailable` from the main
    // process. With no main process the push is local, so this is a plain
    // subscription to the emitter the startup check fires; the signature the UI
    // sees is identical.
    onUpdateAvailable: (cb) => subscribeUpdateAvailable(cb),

    calendarAddTask: async (raw): Promise<CalendarAddTaskOutput> => {
      // Contract parse, so an empty or missing `taskId` is a rejected call
      // rather than a lookup for a task that cannot exist — the original
      // rejected it in the ipcMain loop before the handler ran.
      const { taskId } = CalendarAddTaskInputSchema.parse(raw);
      const snapshot = await store.get();
      const task = snapshot.tasks[taskId];
      if (!task) return { ok: false, code: 'unknown', message: '任务不存在' };
      // Checked here rather than in Rust so the reason code stays the one the
      // renderer already renders, and so no process is spawned to be told
      // nothing can happen.
      if (!task.dueDay) return { ok: false, code: 'no-dueDay', message: '任务没有截止日期' };
      const project = snapshot.projects[task.projectId];
      try {
        // Nested under `request`, because `calendar_add_task` takes a named
        // struct parameter and Tauri v2 binds command arguments by name: a
        // flat payload has no `request` key, so the invoke rejects and the
        // button silently did nothing. `sse_request` sends the same shape.
        return await invokeCommand<CalendarAddTaskOutput>('calendar_add_task', {
          request: {
            title: formatCalendarTitle(task.title, project?.title),
            dueDay: task.dueDay,
            notes: task.notes,
          },
        });
      } catch (err) {
        // A rejected invoke means the helper binary could not be run or spoke
        // nonsense; the original collapsed its equivalent spawn failure into
        // the same `unknown` code.
        return {
          ok: false,
          code: 'unknown',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
