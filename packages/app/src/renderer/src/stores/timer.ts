import {
  type ActiveTimer,
  type AppData,
  applySettlement,
  computeElapsed,
  pauseTimer,
  resumeTimer,
  settleTimer,
  startTimer,
} from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';
import { useDataStore } from './data';

interface TimerState {
  timer: ActiveTimer | null;
  now: number;
  restore: (data: AppData) => void;
  start: (taskId: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
  tick: () => void;
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

  restore: (data) => {
    set({ timer: data.activeTimer });
    const heartbeat = setInterval(() => {
      const t = get().timer;
      if (t) void sync(t);
    }, 30_000);
    const clock = setInterval(() => set({ now: Date.now() }), 1_000);
    // Main-process auto-pauses (sleep/idle) are authoritative; apply them
    // immediately so the heartbeat never resyncs a stale running timer.
    const timerChanged = api().onTimerChanged((timer) => set({ timer, now: Date.now() }));
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
    set({ timer: next, now });
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
    if (!cur) return;
    set({ timer: null }); // clear first: prevents re-entrant double settlement
    await settleInto(cur, Date.now());
    await sync(null);
  },

  tick: () => set({ now: Date.now() }),
}));

export function elapsedOf(timer: ActiveTimer | null, now: number): number {
  return timer ? computeElapsed(timer, now) : 0;
}
