import {
  type ActiveTimer,
  type AppData,
  advancePomodoroPhase,
  applySettlement,
  computeElapsed,
  computeFocusElapsed,
  dropStaleTiming,
  isPhaseComplete,
  isPomodoro,
  POMODORO_FOCUS_MS,
  type PomodoroPhase,
  pauseTimer,
  resumeTimer,
  settleTimer,
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
  restore: (data: AppData) => () => void;
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
 * Settle `cur` on its way out to being replaced by `next`.
 *
 * Returns false when the host refused the write, in which case the caller must
 * abandon the swap and leave the old timer running: it is still the truth on
 * disk, and its elapsed time has not been recorded anywhere else.
 */
async function settleOutgoing(cur: ActiveTimer | null): Promise<boolean> {
  if (!cur) return true;
  const stopped = await api().timingStop({ taskId: cur.taskId });
  if (!stopped.ok && stopped.error === 'WRITE_REFUSED') return false;
  useDataStore.setState({ data: stopped.data });
  return true;
}

export const useTimerStore = create<TimerState>((set, get) => ({
  timer: null,
  now: Date.now(),
  phasePendingAdvance: null,

  /**
   * Adopts the persisted timer and installs the runtime plumbing around it.
   * Returns a teardown.
   *
   * The teardown is what makes this safe under React StrictMode, which mounts,
   * unmounts and remounts every effect in development: without it the first
   * mount's two intervals and its `onTimerChanged` subscription stay live
   * alongside the second mount's, so a dev session ran two 30s heartbeats (two
   * writes per tick) and two clock intervals. `App.tsx` returns this from its
   * effect.
   */
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
    // Auto-pauses (sleep/idle) are authoritative; apply them immediately so
    // the heartbeat never resyncs a stale running timer.
    //
    // The payload is a union, not a bare timer, because "the host stopped the
    // clock" and "the host could not save your clock" are different events. On a
    // refusal the timer is left exactly as it is: the host did not drop it, and
    // clearing it here would stop a session that is still accruing time the
    // user never ended. The banner (store mode) is what tells them the save is
    // not landing.
    const offTimerChanged = api().onTimerChanged((payload) => {
      if (payload.kind === 'refused') return;
      set({ timer: payload.timer, now: Date.now() });
    });
    return () => {
      clearInterval(heartbeat);
      clearInterval(clock);
      offTimerChanged();
    };
  },

  start: async (taskId) => {
    const cur = get().timer;
    // Same task already running: ignore instead of restarting (which would
    // silently discard the elapsed time accumulated so far).
    if (cur && cur.taskId === taskId && !cur.isPaused) return;
    const now = Date.now();
    const next = startTimer(taskId, now);
    // Settle the outgoing timer through the host, so billing and clearing land
    // in one transition and never leave "task settled, timer still points at
    // it" for recovery to misread. A refusal means nothing was written, so the
    // swap is abandoned rather than half-applied: continuing would start the
    // new timer while the old one's elapsed time was never recorded.
    if (!(await settleOutgoing(cur))) return;
    set({ timer: next, now, phasePendingAdvance: null });
    await sync(next);
  },

  startPomodoro: async (taskId) => {
    const cur = get().timer;
    if (cur && cur.taskId === taskId && !cur.isPaused) return;
    const now = Date.now();
    const next = startPomodoroFocus(taskId, now);
    if (!(await settleOutgoing(cur))) return;
    set({ timer: next, now, phasePendingAdvance: null });
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

  /**
   * Stop the clock, in one host-side transition.
   *
   * This used to settle the session in the renderer and clear the timer in a
   * second write — the settle-then-clear pair ADR-0002 rejected for a concrete
   * reason. An interruption between the two writes left "the task is settled
   * and `activeTimer` still points at it" on disk, which recovery cannot tell
   * from an already-billed write; guessing wrong billed the session twice (a
   * 90s stop that reopened as 180s with two identical entries). The host also
   * has to be the one computing the settlement, so the recorded amount is what
   * it actually wrote rather than what the renderer predicted.
   *
   * The three outcomes stay distinct. A refused write means nothing happened,
   * so the clock keeps running — clearing it here would bill an interval the
   * user stopped hours later. A domain rejection means the host *did* drop the
   * timer and persisted that, so we adopt its dataset and stop.
   */
  stop: async () => {
    const cur = get().timer;
    if (!cur) {
      set({ timer: null, phasePendingAdvance: null });
      return;
    }
    const result = await api().timingStop({ taskId: cur.taskId });
    if (!result.ok && result.error === 'WRITE_REFUSED') return;

    set({ timer: null, phasePendingAdvance: null, now: Date.now() });
    // Every branch that reaches here carries the dataset the host now holds —
    // including a rejection that dropped the timer — so adopt it rather than
    // clearing on our own.
    useDataStore.setState({ data: result.data });
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
