import {
  type ActiveTimer,
  type AppData,
  advancePomodoroPhase,
  computeElapsed,
  computeFocusElapsed,
  dropStaleTiming,
  isPhaseComplete,
  isPomodoro,
  POMODORO_FOCUS_MS,
  type PomodoroPhase,
  pauseTimer,
  resumeTimer,
  startPomodoroFocus,
  startTimer,
} from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';
import { useDataStore } from './data';

export interface PhasePendingAdvance {
  finishedPhase: PomodoroPhase;
  setComplete: boolean;
}

interface TimerState {
  timer: ActiveTimer | null;
  now: number;
  phasePendingAdvance: PhasePendingAdvance | null;
  restore: (data: AppData) => void;
  start: (taskId: string) => Promise<void>;
  startPomodoro: (taskId: string) => Promise<void>;
  /**
   * Mark a task done and settle the timing session running on it. The invariant
   * is enforced by the main process on write, so this only has to stay in step
   * with the returned dataset — no second timer write, hence no window in which
   * a done task could still be timed. Resolves to the ms recorded (0 if none).
   */
  completeFor: (taskId: string) => Promise<number>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
  tick: () => void;
  /** Move a pomodoro timer to its next phase. No-op for free timers. */
  advancePhase: () => Promise<void>;
  /** Start a fresh pomodoro set after the user confirms "another set?". */
  startNextPomodoroSet: () => Promise<void>;
  /** Drop any pending phase-advance dialog (e.g. user navigated away). */
  dismissPhaseAdvance: () => void;
}

async function sync(timer: ActiveTimer | null) {
  await api().timerSync({ timer });
}

/**
 * 结算由主进程做（ADR-0003）：渲染进程不再自己算时长再写回去。
 * 调用方先乐观地停表，所以这里只负责采纳主进程的答案——返回它记录的 ms。
 *
 * `expectedTaskId` 钉住要结算的是哪一次：换表与心跳 sync() 是异步的，不钉住的话
 * 主进程可能结算到刚起步的新表，把旧任务的时长记错地方。拒绝时也采纳返回的
 * 数据集——主进程可能已经丢弃了 activeTimer，渲染进程必须跟着收敛。
 *
 * 返回码区分"主进程那边已经没有表了"和"主进程跑的不是我指定的那次"：后者
 * 必须留着,调用方要拿它来决定还要不要补一次清空。两种情况都返回 0。
 */
async function settleOnMain(
  expectedTaskId?: string,
): Promise<{ settledMs: number; cleared: boolean }> {
  const result = await api().timingStop({ taskId: expectedTaskId });
  useDataStore.setState({ data: result.data });
  if (result.ok) return { settledMs: result.settledMs, cleared: true };
  // TIMER_MISMATCH means a *different* session is running on the main side and
  // was deliberately left alone. Reporting "cleared" here would have the
  // caller wipe that session's accumulated time with no TimeEntry, no log and
  // no toast.
  return { settledMs: 0, cleared: result.error !== 'TIMER_MISMATCH' };
}

export const useTimerStore = create<TimerState>((set, get) => ({
  timer: null,
  now: Date.now(),
  phasePendingAdvance: null,

  restore: (data) => {
    // Drop rather than settle: a done task holding a timer is ambiguous, and
    // settling on that guess would bill already-recorded time a second time.
    const clean = dropStaleTiming(data);
    const dropped = clean !== data;
    set({ timer: clean.activeTimer ?? null });
    if (dropped) void sync(null).catch(() => {});
    const heartbeat = setInterval(() => {
      const t = get().timer;
      if (t) void sync(t);
    }, 30_000);
    const clock = setInterval(() => {
      const now = Date.now();
      set({ now });
      // Detect a freshly-completed pomodoro phase and surface a one-shot
      // prompt. The flag prevents repeated firing while the dialog is up.
      const t = get().timer;
      if (t && isPomodoro(t) && !t.isPaused && isPhaseComplete(t, now)) {
        if (!get().phasePendingAdvance) {
          set({ phasePendingAdvance: { finishedPhase: t.phase ?? 'focus', setComplete: false } });
        }
      }
    }, 1_000);
    // Main-process auto-pauses (sleep/idle) are authoritative; apply them
    // immediately so the heartbeat never resyncs a stale running timer.
    const timerChanged = api().onTimerChanged((timer) => {
      set({ timer, now: Date.now() });
    });
    void heartbeat;
    void clock; // intervals live for app lifetime
    void timerChanged;
  },

  start: async (taskId) => {
    const cur = get().timer;
    // Same task already running: ignore instead of restarting (which would
    // silently discard the elapsed time accumulated so far).
    if (cur && cur.taskId === taskId && !cur.isPaused) return;
    const now = Date.now();
    const next = startTimer(taskId, now);
    // Swap synchronously first so rapid clicks can't race, then settle the
    // previous timer so its elapsed time isn't lost. The settle is pinned to
    // the previous task: without the pin, a concurrent sync() landing first
    // would make the main process settle `next` instead and leave the old
    // task's elapsed time unbilled.
    set({ timer: next, now, phasePendingAdvance: null });
    if (cur) await settleOnMain(cur.taskId);
    await sync(next);
  },

  startPomodoro: async (taskId) => {
    const cur = get().timer;
    if (cur && cur.taskId === taskId && !cur.isPaused) return;
    const now = Date.now();
    const next = startPomodoroFocus(taskId, now);
    set({ timer: next, now, phasePendingAdvance: null });
    if (cur) await settleOnMain(cur.taskId);
    await sync(next);
  },

  completeFor: async (taskId) => {
    const task = useDataStore.getState().data?.tasks[taskId];
    if (!task || task.isDone) return 0;
    // One write settles the task and clears the timer together, and the main
    // process is what decides how much that was — so report its number rather
    // than predicting one here. doneAt is left to the main process too, so a
    // task that was already done keeps the day it was done on.
    const { data, settledMs } = await useDataStore.getState().upsertTask({ ...task, isDone: true });
    set({ timer: data.activeTimer ?? null, now: Date.now(), phasePendingAdvance: null });
    return settledMs;
  },

  pause: () => {
    const cur = get().timer;
    if (!cur) return;
    const t = pauseTimer(cur, Date.now());
    set({ timer: t });
    void sync(t);
  },

  resume: () => {
    const cur = get().timer;
    if (!cur) return;
    const t = resumeTimer(cur, Date.now());
    set({ timer: t });
    void sync(t);
  },

  stop: async () => {
    const cur = get().timer;
    // Optimistic: the clock stops on this frame; the recorded duration is
    // whatever the main process settles, adopted in settleOnMain.
    set({ timer: null, phasePendingAdvance: null });
    // Clear the main-side timer unless the settle *declined* it. A decline
    // (TIMER_MISMATCH) means another session is running over there and the pin
    // deliberately left it alone — clearing it anyway would destroy that
    // session's accumulated time with no TimeEntry and no log. The finally
    // still clears when the settle throws, or main would keep a timer the UI
    // already shows as stopped.
    //
    // With no local timer there is nothing to pin to, so settle whatever main
    // holds: recording that time on its own task beats discarding it, and
    // beats leaving a ghost that a later start() would bill somewhere else.
    // Default to clearing: a throwing settle leaves `cleared` untouched, and
    // main keeping a timer the UI shows as stopped is the worse of the two
    // failures. Only an explicit decline turns the clear off.
    let cleared = true;
    let settled = false;
    try {
      ({ cleared } = await settleOnMain(cur?.taskId));
      settled = true;
    } finally {
      if (cleared) {
        // Best effort: a failing clear must not replace the settle error that
        // explains why we are here. With no settle error to preserve, it is
        // the only failure there is, so it propagates like any other.
        await sync(null).catch((err: unknown) => {
          if (settled) throw err;
        });
      }
    }
  },

  tick: () => set({ now: Date.now() }),

  advancePhase: async () => {
    const cur = get().timer;
    if (!cur || !isPomodoro(cur)) {
      set({ phasePendingAdvance: null });
      return;
    }
    const { next, setComplete } = advancePomodoroPhase(cur, Date.now());
    // If setComplete, advancePomodoroPhase already paused the timer at
    // `now` with cyclesCompleted = POMODORO_CYCLES_PER_SET. The renderer
    // needs to confirm before starting a new set, so we keep
    // phasePendingAdvance set with the latest finishedPhase to drive the
    // confirmation dialog.
    if (setComplete) {
      set({ timer: next, phasePendingAdvance: { finishedPhase: 'focus', setComplete: true } });
    } else {
      set({ timer: next, phasePendingAdvance: null });
    }
    await sync(next);
  },

  startNextPomodoroSet: async () => {
    const cur = get().timer;
    if (!cur || !isPomodoro(cur)) {
      set({ phasePendingAdvance: null });
      return;
    }
    const now = Date.now();
    // Reset the cycle counter and the phase clock, but keep the session
    // clock (startedAt/accumulatedMs) so subsequent stops commit the whole
    // multi-set span as one TimeEntry.
    const next: ActiveTimer = {
      ...cur,
      phase: 'focus',
      phaseStartedAt: now,
      phaseAccumulatedMs: 0,
      phaseDurationMs: POMODORO_FOCUS_MS,
      cyclesCompleted: 0,
      isPaused: false,
      pausedAt: undefined,
      autoPausedBy: undefined,
    };
    set({ timer: next, phasePendingAdvance: null });
    await sync(next);
  },

  dismissPhaseAdvance: () => set({ phasePendingAdvance: null }),
}));

export function elapsedOf(timer: ActiveTimer | null, now: number): number {
  if (!timer) return 0;
  // Pomodoro timers report focus-only time so the running display freezes
  // during breaks (matches the value that will be settled into the
  // TimeEntry). Free-mode timers keep the full session elapsed.
  return isPomodoro(timer) ? computeFocusElapsed(timer, now) : computeElapsed(timer, now);
}
