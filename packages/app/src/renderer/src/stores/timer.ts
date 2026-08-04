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
  start: (taskId: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
  tick: () => void;
}

async function sync(timer: ActiveTimer | null) {
  await api().timerSync({ timer });
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
    void heartbeat;
    void clock; // intervals live for app lifetime
  },

  start: (taskId) => {
    const t = startTimer(taskId, Date.now());
    set({ timer: t, now: Date.now() });
    void sync(t);
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
    const now = Date.now();
    const settlement = settleTimer(cur, now);
    const data = useDataStore.getState().data;
    const task = data?.tasks[cur.taskId];
    if (task && settlement.ms > 0) {
      await useDataStore.getState().upsertTask(applySettlement(task, settlement));
    }
    set({ timer: null });
    await sync(null);
  },

  tick: () => set({ now: Date.now() }),
}));

export function elapsedOf(timer: ActiveTimer | null, now: number): number {
  return timer ? computeElapsed(timer, now) : 0;
}
