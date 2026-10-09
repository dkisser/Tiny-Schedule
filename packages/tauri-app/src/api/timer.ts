import { listen } from '@tauri-apps/api/event';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import {
  type ActiveTimer,
  IpcInvokeContract,
  type IpcInvokeFn,
  type IpcInvokeKey,
  type NotifyPhaseCompleteReq,
  type RendererApi,
} from '@tiny-schedule/shared';

/**
 * The timer slice: the notification that fires when a pomodoro phase ends,
 * plus the events the host pushes at the renderer.
 *
 * The Electron original ran all of these in the main process — the
 * notification through Electron's `Notification` class, the events over
 * `webContents.send`. Only the notification is a genuine host capability;
 * `ui:new-task` and `timer:changed` are webview events now, so the renderer
 * subscribes to them rather than being sent them.
 *
 * Window control (`setAlwaysOnTopWindow`) is deliberately *not* here: it is
 * native-window state rather than timer state, and it already has a home in
 * `api/window.ts` from wave 2.
 */

/** Contract keys this slice owns. */
export type TimerInvokeKey = Extract<IpcInvokeKey, 'notifyPhaseComplete'>;

export type TimerApi = {
  [K in TimerInvokeKey]: IpcInvokeFn<K>;
};

/**
 * The push channels a timer can arrive on.
 *
 * `onTimerChanged` is declared by the contract but built in `api.ts`, not
 * here: its producer is the local bus (the stale-timer sweeps in `api/files.ts`
 * and the `timerSync` wrapper), and this slice has no channel left to listen
 * on. The host event it used to also subscribe to has no Rust producer at all,
 * so that listener could never fire.
 */
export type TimerSubscriptions = Pick<RendererApi, 'onNewTask'>;

/**
 * Event channel names pushed by the Rust host.
 *
 * These are Tauri event names, not `Ipc.*` constants. The shared contract
 * describes Electron IPC channels, which have no Tauri equivalent — the
 * nearest of them, `Ipc.uiNewTask` (`ui:newTask`), becomes `ui:new-task` here.
 * `src-tauri/src/menu.rs` keeps its menu item id equal to
 * {@link HOST_EVENTS}.newTask, so the accelerator and the subscription cannot
 * drift apart silently.
 */
export const HOST_EVENTS = {
  /** The macOS idle reading, emitted every 20s. Consumed by systemEvents.ts. */
  systemIdle: 'system:idle',
  /** A close was requested; the renderer must confirm before it happens. */
  closeRequested: 'app:close-requested',
  /** "新建任务" in the application menu, or its CmdOrCtrl+N accelerator. */
  newTask: 'ui:new-task',
} as const;

/**
 * Notification permission, requested at most once.
 *
 * macOS treats the notification prompt as one-shot: a denied app cannot ask
 * again and the API reports `denied` from then on. Caching keeps a burst of
 * phase changes from stacking prompts, and caching the in-flight `Promise`
 * collapses the concurrent callers a burst produces.
 */
let permissionOnce: Promise<boolean> | null = null;

async function ensureNotificationPermission(): Promise<boolean> {
  permissionOnce ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === 'granted';
  })();
  return permissionOnce;
}

/**
 * Shows the phase-complete banner.
 *
 * A denied permission is logged and swallowed rather than thrown: the dialog
 * that triggered this is on screen regardless, so failing the call would only
 * produce an unhandled rejection for a cosmetic feature.
 */
async function showNotification(req: NotifyPhaseCompleteReq): Promise<void> {
  if (!(await ensureNotificationPermission())) {
    console.warn('notify: phase-complete notification permission denied');
    return;
  }
  sendNotification({ title: req.title, body: req.body });
}

/**
 * Subscribes to a host event, returning the unsubscribe the API contract wants.
 *
 * `listen` resolves asynchronously, so a caller that unsubscribed first (React
 * StrictMode double-invokes effects) would otherwise leak a live listener with
 * no handle left to remove it.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  void listen<T>(channel, (event) => cb(event.payload)).then((fn) => {
    if (disposed) {
      fn();
      return;
    }
    unlisten = fn;
  });

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

export function createTimerApi(): TimerApi & TimerSubscriptions {
  // Parsed here for the reason `api/data.ts` parses per call: with the
  // ipcMain loop gone, the zod guard has to live at the call site.
  const { req } = IpcInvokeContract.notifyPhaseComplete;

  return {
    notifyPhaseComplete: async (raw) => {
      await showNotification(req.parse(raw));
    },
    onNewTask: (cb) => subscribe<void>(HOST_EVENTS.newTask, () => cb()),
  };
}
