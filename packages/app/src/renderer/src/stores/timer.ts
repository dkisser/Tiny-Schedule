import {
  type ActiveTimer,
  type AppData,
  advancePomodoroPhase,
  applySettlement,
  computeElapsed,
  computeFocusElapsed,
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
  restore: (data: AppData) => void;
  start: (taskId: string) => Promise<void>;
  startPomodoro: (taskId: string) => Promise<void>;
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

async function settleInto(cur: ActiveTimer, now: number): Promise<void> {
  const settlement = settleTimer(cur, now);
  const task = useDataStore.getState().data?.tasks[cur.taskId];
  if (task && settlement.ms > 0) {
    await useDataStore.getState().upsertTask(applySettlement(task, settlement));
  }
}

export const useTimerStore = create<TimerState>((set, get) => ({
  timer: null,
  now: Date.now(),
  phasePendingAdvance: null,

  restore: (data) => {
    set({ timer: data.activeTimer });
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
    // previous timer so its elapsed time isn't lost.
    set({ timer: next, now, phasePendingAdvance: null });
    if (cur) await settleInto(cur, now);
    await sync(next);
  },

  startPomodoro: async (taskId) => {
    const cur = get().timer;
    if (cur && cur.taskId === taskId && !cur.isPaused) return;
    const now = Date.now();
    const next = startPomodoroFocus(taskId, now);
    set({ timer: next, now, phasePendingAdvance: null });
    if (cur) await settleInto(cur, now);
    await sync(next);
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
    set({ timer: null, phasePendingAdvance: null });
    if (!cur) return;
    await settleInto(cur, Date.now());
    await sync(null);
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
