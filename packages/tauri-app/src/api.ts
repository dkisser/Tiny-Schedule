import {
  type ActiveTimer,
  IpcInvokeContract,
  type IpcInvokeKey,
  type RendererApi,
} from '@tiny-schedule/shared';
import { type AiLogger } from '@/ai/logger';
import { type CreateAiApiOptions, createAiApi } from '@/api/ai';
import { createDataApi } from '@/api/data';
import { createFilesApi } from '@/api/files';
import { createSystemApi, type SystemApiDeps } from '@/api/system';
import { createTimerApi } from '@/api/timer';
import { createWindowApi } from '@/api/window';
import type { DataStore } from '@/bridge/dataStore';

/**
 * The renderer-facing API: every one of the 35 invokes and 5 subscriptions in
 * {@link IpcInvokeContract} / {@link RendererApi}, assembled from the slices
 * under `src/api/`.
 *
 * Each slice is a transcription of its counterpart in
 * packages/app/src/main/ipcHandlers.ts and owns one domain; this file's only
 * job is to compose them and to own the two pieces of cross-slice wiring that
 * no single slice can do alone:
 *
 *  1. **The local timer-changed channel.** In Electron the main process pushed
 *     `Ipc.timerChanged` whenever it changed the timer on its own — dropping
 *     stale timing, auto-pausing on idle, settling on quit. There is no second
 *     process now, so the paths that *write* the timer (this file's
 *     `timerSync` wrapper and the import sweep in `api/files.ts`) announce the
 *     drop through a local bus, and `onTimerChanged` fans that out. Sleep and
 *     idle auto-pauses used to arrive over a Rust `timer:changed` event, but
 *     the host never emitted it and the decision now lives in
 *     `bridge/systemEvents.ts`, which writes through `api()` and so reaches
 *     subscribers by the same bus.
 *  2. **Ordering.** The store must be open before the slices close over it,
 *     which is why assembly is a separate step from `installApi` and why
 *     `bootstrap()` runs first.
 */

export interface CreateApiOptions {
  store: DataStore;
  /** Injected in tests; production lets each system slice reach Tauri itself. */
  system?: SystemApiDeps;
  /** Injected in tests; production uses the console logger. */
  logger?: AiLogger;
  /** Test seam: replaces the SSE bridge so the AI slice needs no Tauri host. */
  fetchImpl?: CreateAiApiOptions['fetchImpl'];
  /** Test seam: replaces the chat agent's provider connection. */
  chatDeps?: CreateAiApiOptions['chatDeps'];
}

/**
 * Local push channel for timer changes this process decided on.
 *
 * Same shape as the host event's payload, because both reach the same
 * subscriber. Listener errors are contained per-callback: a throwing
 * subscriber is a renderer bug, and it must not stop the other subscribers
 * from being told the timer changed.
 */
function createTimerChangedBus(): {
  emit: (timer: ActiveTimer | null) => void;
  subscribe: (cb: (timer: ActiveTimer | null) => void) => () => void;
} {
  const listeners = new Set<(timer: ActiveTimer | null) => void>();
  return {
    emit(timer) {
      for (const cb of [...listeners]) {
        try {
          cb(timer);
        } catch (error) {
          console.error('timer: onTimerChanged listener threw', error);
        }
      }
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/**
 * Builds the complete API object. Every slice contributes a disjoint set of
 * contract keys, so the spread below is a partition rather than a merge — the
 * contract-completeness test in `./api.test.ts` is what keeps it one.
 */
export function createApi(options: CreateApiOptions): RendererApi {
  const { store } = options;
  const timerChanged = createTimerChangedBus();
  const data = createDataApi(store);
  const ai = createAiApi({
    store,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.chatDeps ? { chatDeps: options.chatDeps } : {}),
  });
  const files = createFilesApi(store, {
    onTimerChanged: () => timerChanged.emit(null),
  });
  const system = createSystemApi(store, options.system ?? {});
  const timer = createTimerApi();
  const window = createWindowApi();

  /**
   * `onTimerChanged` reaches subscribers from this process alone: the stale-
   * timer sweeps in `api/files.ts` (an import can hand us a done task that is
   * still being timed) and in the `timerSync` wrapper below (the store refused
   * to keep a timer whose task is already done).
   *
   * There used to be a second source — a `listen` on the Rust host's
   * `timer:changed` event — because the Electron original's main process
   * pushed there whenever *it* changed the timer. No Rust code emits it (the
   * only emit targets are `sse://…`, `app:close-requested`, `ui:new-task` and
   * `system:idle`), and the auto-pause that used to motivate it now lives in
   * `bridge/systemEvents.ts`, which writes through `api()` and reaches
   * subscribers through this same bus. So that listener could never fire, and
   * the auto-pause's authority is exercised by the other tests in this file
   * rather than by a subscription to a channel with no producer.
   */
  const combined = {
    ...data,
    ...ai,
    ...files,
    ...system,
    ...timer,
    ...window,
    // Owned here rather than by the timer slice: the slice's version knew only
    // the Rust host channel, which no longer exists. See above.
    onTimerChanged: timerChanged.subscribe,
  } as unknown as RendererApi;

  /**
   * The data slice persists a corrected timer but cannot announce it — it has
   * no event channel. The announcement belongs here, where the bus lives, so
   * that a sync asked for a timer and the store refused to keep it (the task
   * it belonged to is already done) reaches the renderer's clock instead of
   * leaving it running against a timer nothing persisted.
   */
  const requested = (req: { timer: ActiveTimer | null } | undefined) => req?.timer ?? null;
  const dataTimerSync = data.timerSync;
  const timerSync: RendererApi['timerSync'] = async (req) => {
    const wanted = requested(req as { timer: ActiveTimer | null });
    const result = await dataTimerSync(req);
    const persisted = (await store.get()).activeTimer ?? null;
    if (wanted && !persisted) timerChanged.emit(null);
    return result;
  };

  return { ...combined, timerSync };
}

let active: RendererApi | null = null;

/**
 * Installs the assembled API. Called once from `bootstrap()` after the store
 * has opened, because every slice closes over the store instance.
 */
export function installApi(api: RendererApi): void {
  active = api;
}

export function api(): RendererApi {
  if (active) return active;
  // Not a per-method stub: there is no partial API any more, so a call before
  // bootstrap is a wiring bug in the startup order rather than an unimplemented
  // feature, and one error naming the cause beats 35 identical ones.
  throw new Error('api() called before installApi() — bootstrap() must run first');
}

/**
 * Contract keys, exported so tests can walk the same set the renderer is
 * typed against instead of restating it.
 */
export const CONTRACT_INVOKE_KEYS = Object.keys(IpcInvokeContract) as IpcInvokeKey[];

/** The 5 `on*` methods of {@link RendererApi}, by name. */
export const CONTRACT_SUBSCRIPTION_KEYS = [
  'onAiEvent',
  'onChatEvent',
  'onNewTask',
  'onUpdateAvailable',
  'onTimerChanged',
] as const satisfies ReadonlyArray<keyof RendererApi>;
