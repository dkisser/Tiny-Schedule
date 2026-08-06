import type { ActiveTimer, Task, TimeEntry } from './models';

export function startTimer(taskId: string, now: number): ActiveTimer {
  return { taskId, startedAt: now, accumulatedMs: 0, isPaused: false };
}

export function pauseTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (t.isPaused) return t;
  return {
    ...t,
    accumulatedMs: t.accumulatedMs + Math.max(0, now - t.startedAt),
    isPaused: true,
    pausedAt: now,
  };
}

export function resumeTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (!t.isPaused) return t;
  return { ...t, startedAt: now, isPaused: false, pausedAt: undefined };
}

export function computeElapsed(t: ActiveTimer, now: number): number {
  return t.accumulatedMs + (t.isPaused ? 0 : Math.max(0, now - t.startedAt));
}

export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** Add n days to a YYYY-MM-DD string, computed in local time. */
export function addDays(date: string, n: number): string {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n).getTime());
}

export interface Settlement {
  ms: number;
  entry: TimeEntry;
}

export function settleTimer(t: ActiveTimer, now: number): Settlement {
  const ms = computeElapsed(t, now);
  const end = t.isPaused ? (t.pausedAt ?? now) : now;
  return { ms, entry: { date: localDate(end), start: t.startedAt, end, ms } };
}

export function applySettlement(task: Task, settlement: Settlement): Task {
  const day = settlement.entry.date;
  return {
    ...task,
    timeSpent: task.timeSpent + settlement.ms,
    timeSpentOnDay: {
      ...task.timeSpentOnDay,
      [day]: (task.timeSpentOnDay[day] ?? 0) + settlement.ms,
    },
    timeEntries: [...task.timeEntries, settlement.entry],
  };
}
