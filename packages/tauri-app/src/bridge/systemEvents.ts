import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { confirm } from '@tauri-apps/plugin-dialog';
import {
  autoPauseTimer,
  dropStaleTiming,
  maskDataForRenderer,
  settleActiveTimer,
} from '@tiny-schedule/shared';
import { toast } from 'sonner';
import { api } from '../api';
import { HOST_EVENTS } from '../api/timer';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';
import type { DataStore } from './dataStore';
import {
  isSuspendGap,
  SLEEP_POLL_MS,
  shouldAutoPauseForIdle,
  suspendBackdateMs,
} from './systemEventsLogic';

/**
 * The system-event bridge: idle auto-pause, sleep detection, and the
 * quit-with-a-running-timer flow.
 *
 * The Electron original ran all three in the main process
 * (`packages/app/src/main/powerTimer.ts` plus the `before-quit` handler in
 * `main.ts`), because the renderer is frozen during sleep and cannot observe
 * idleness or a quit request by itself. That is still true of *observation*,
 * which is why the idle reading comes from the Rust host — but the *decision*
 * moved to the renderer, because everything the decision needs (the user's
 * `idlePauseMinutes`, the running `ActiveTimer`, the data store) lives here
 * now. That split is what ADR 0003 asks for: the host observes, the renderer
 * decides.
 *
 * The two judgements that can be wrong without anyone noticing — "is this idle
 * long enough?" and "was that a sleep?" — live in `./systemEventsLogic`,
 * which imports no Tauri module and is therefore testable without an IPC
 * layer. This file is the wiring around them.
 */

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * A pause is in flight. Re-entrancy is not hypothetical: a sleep wake and an
 * idle tick can land in the same frame, and a second auto-pause would backdate
 * from an already-paused timer and move the pause point backwards.
 */
let pauseInFlight = false;

/**
 * The same latch the Electron original called `quitConfirmOpen`: a second
 * close request while the dialog is up must not stack another one.
 */
let closeConfirmOpen = false;

/**
 * The store the quit settlement writes through, set by
 * {@link startSystemEvents}. Module scope because the settlement is reached
 * from a host event listener, which closes over nothing.
 */
let activeStore: DataStore | null = null;

/**
 * Applies an auto-pause and persists it.
 *
 * Returns without persisting when the loaded dataset is not there yet, which
 * is the window between app start and the first `dataLoad`. Auto-pausing into
 * a store that has not been populated would write `activeTimer` against an
 * empty `tasks` map.
 *
 * Exported for the wiring tests, which drive it directly: both callers are
 * private closures otherwise, and the pause point it computes is the whole
 * thing under test (see {@link startSleepWatcher}).
 */
export async function applyAutoPause(
  reason: 'sleep' | 'idle',
  backdateMs = 0,
  now: number = Date.now(),
): Promise<void> {
  if (pauseInFlight) return;
  const timer = useTimerStore.getState().timer;
  if (!timer || timer.isPaused) return;
  const data = useDataStore.getState().data;
  if (!data) return;

  // `autoPauseTimer` is the shared state transition the Electron original
  // used; `backdateMs` is what separates idle (measured) from sleep (not).
  //
  // `now` is the caller's reading rather than a fresh `Date.now()`. The sleep
  // watcher has to pair the two: the gap it measured and the instant it
  // subtracts that gap from have to be the same sample, or the pause point
  // lands somewhere the watcher never actually observed.
  const paused = autoPauseTimer(timer, now, reason, backdateMs);

  pauseInFlight = true;
  try {
    // Same invariant as every other write path: a timer may never be
    // persisted for a task that is already done.
    const next = dropStaleTiming({ ...data, activeTimer: paused });
    useDataStore.setState({ data: next });
    useTimerStore.setState({ timer: next.activeTimer, now });
    await api().timerSync({ timer: next.activeTimer });

    if (next.activeTimer) {
      console.info(`timer: auto-paused (${reason}) task=${next.activeTimer.taskId}`);
    } else {
      console.info(`timer: dropped stale timing on ${reason} (task=${paused.taskId})`);
    }
  } finally {
    pauseInFlight = false;
  }
}

/**
 * One sleep-detection sample.
 *
 * The webview has no suspend/resume event, and the renderer genuinely cannot
 * run during sleep — the poll interval simply stops firing and resumes
 * afterwards. The gap between samples *is* the signal.
 *
 * The gap is also handed to {@link applyAutoPause} as a backdate. The suspend
 * is only ever *observed* at wake, so a zero backdate would pin the pause
 * point to the wake instant and bill the entire offline stretch as work — an
 * overnight nap becoming an eight-hour time entry. See
 * {@link suspendBackdateMs} for why the whole excess is attributed to sleep.
 *
 * Split out from the interval so a test can sample a clock it controls. The
 * only interesting case is a jump in `Date.now()` that no amount of real
 * waiting produces.
 */
export function createSleepSampler(now: () => number = Date.now): () => void {
  let last = now();
  return () => {
    const current = now();
    const elapsed = current - last;
    last = current;
    if (isSuspendGap(elapsed, SLEEP_POLL_MS)) {
      void applyAutoPause('sleep', suspendBackdateMs(elapsed, SLEEP_POLL_MS), current);
    }
  };
}

function startSleepWatcher(): () => void {
  const sample = createSleepSampler();
  const handle = setInterval(sample, SLEEP_POLL_MS);
  return () => clearInterval(handle);
}

/**
 * Settles the running timer into its task before quitting, the way
 * `settleActiveTimer` did in the Electron main process.
 *
 * Writes through the store directly, which is what the original did too —
 * `settleActiveTimer` was a main-process function over `dataStore`, not an IPC
 * handler, so there is no contract channel to route it through. Going through
 * `stop()` instead would be two writes (settle the task, then clear the timer),
 * and ADR 0002 rejected that exact pair: an interruption in between leaves a
 * settled task whose `activeTimer` still points at it, which recovery cannot
 * tell apart from "the task was recorded and the clear never landed" — and
 * guessing wrong bills the session twice. One `store.update` removes the
 * window instead of trying to detect it afterwards.
 *
 * The dataset is masked on the way into the renderer stores, as every other
 * write path does: the store holds the unredacted `apiKeyEncrypted`, and
 * pushing that into renderer state would undo the masking the contract exists
 * to provide.
 */
async function settleRunningTimer(): Promise<void> {
  const timer = useTimerStore.getState().timer;
  if (!timer || !activeStore) return;

  // `settledMs` comes back out of the same pure transition that produced the
  // data, captured in the closure rather than recomputed — a second
  // `settleTimer` call could disagree with the write that actually landed.
  let settledMs = 0;
  const settled = await activeStore.update((d) => {
    const result = settleActiveTimer(d, timer, Date.now());
    settledMs = result.settledMs;
    return result.data;
  });
  useDataStore.setState({ data: maskDataForRenderer(settled.data) });
  useTimerStore.setState({ timer: null, now: Date.now() });

  if (settledMs > 0) {
    console.info(`timer: settled on quit (${timer.taskId}) ms=${settledMs}`);
  } else {
    // The done-task and unknown-task cases: cleared without recording, because
    // the time may already have been settled and a second pass would bill it
    // again.
    console.info(`timer: dropped timing on quit (${timer.taskId})`);
  }
}

/** Ends the process for real — the only path that actually quits the app. */
async function invokeConfirmClose(): Promise<void> {
  try {
    await invoke('confirm_close');
  } catch (e) {
    // The app stays open when this fails, so the user can try again rather
    // than being left with an app that ignored their quit.
    console.error('close: confirm_close failed', e);
    toast.error('退出失败，请重试');
  }
}

/**
 * Handles a quit the host intercepted.
 *
 * Mirrors `app.on('before-quit')` in `packages/app/src/main/main.ts:117-131`:
 * with a running timer, confirm before discarding the elapsed time; without
 * one, quit straight away.
 *
 * Note this fires for *quitting* only. Closing the window (Cmd+W, the red
 * button) is handled entirely in Rust — on macOS that hides the window and
 * leaves the app running, so there is nothing to settle and nothing to ask
 * about. See `src-tauri/src/close.rs`.
 */
async function handleQuitRequested(): Promise<void> {
  if (closeConfirmOpen) return;
  const timer = useTimerStore.getState().timer;
  if (!timer) {
    await invokeConfirmClose();
    return;
  }

  closeConfirmOpen = true;
  try {
    const confirmed = await confirm('退出将中断计时，已消耗的时间会结算到任务耗时。', {
      title: '计时器正在运行',
      kind: 'warning',
      okLabel: '结算并退出',
      cancelLabel: '取消',
    });
    if (!confirmed) return;
    await settleRunningTimer();
    await invokeConfirmClose();
  } finally {
    closeConfirmOpen = false;
  }
}

/**
 * Starts the bridge. Idempotent: the startup path and React StrictMode's
 * double-invoked effects can both reach it, and two sleep watchers would each
 * fire a pause.
 *
 * `store` is passed rather than reached for through `api()` because the quit
 * settlement is a single-write domain action, not a contract channel — see
 * {@link settleRunningTimer}.
 */
let started = false;

export function startSystemEvents(store: DataStore): void {
  if (started) return;
  started = true;
  activeStore = store;

  void listen<{ seconds: number }>(HOST_EVENTS.systemIdle, (event) => {
    const settings = useDataStore.getState().data?.settings;
    if (!settings) return;
    const { seconds } = event.payload;
    if (shouldAutoPauseForIdle(useTimerStore.getState().timer, settings, seconds)) {
      void applyAutoPause('idle', seconds * 1000);
    }
  });

  void listen(HOST_EVENTS.closeRequested, () => {
    void handleQuitRequested();
  });

  startSleepWatcher();
}

/** Test seam: clears the idempotence and re-entrancy latches. */
export function resetSystemEventsForTest(): void {
  started = false;
  pauseInFlight = false;
  closeConfirmOpen = false;
  // Cleared too: a stale store would let one test's quit settlement write
  // through another test's filesystem.
  activeStore = null;
}
