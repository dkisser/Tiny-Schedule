import type { ActiveTimer, AppSettings, Task, TimeEntry } from './models';

export function startTimer(taskId: string, now: number): ActiveTimer {
  return { taskId, startedAt: now, accumulatedMs: 0, isPaused: false, sessionStartedAt: now };
}

export function pauseTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (t.isPaused) return t;
  return {
    ...t,
    accumulatedMs: t.accumulatedMs + Math.max(0, now - t.startedAt),
    isPaused: true,
    pausedAt: now,
    autoPausedBy: undefined,
  };
}

export function resumeTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (!t.isPaused) return t;
  return { ...t, startedAt: now, isPaused: false, pausedAt: undefined, autoPausedBy: undefined };
}

/**
 * Pause triggered by system sleep or idle detection. backdateMs moves the
 * pause point into the past so unattended time is not counted.
 */
export function autoPauseTimer(
  t: ActiveTimer,
  now: number,
  reason: 'sleep' | 'idle',
  backdateMs = 0,
): ActiveTimer {
  if (t.isPaused) return t;
  const paused = pauseTimer(t, Math.max(t.startedAt, now - backdateMs));
  return { ...paused, autoPausedBy: reason };
}

export function computeElapsed(t: ActiveTimer, now: number): number {
  return t.accumulatedMs + (t.isPaused ? 0 : Math.max(0, now - t.startedAt));
}

export function idleThresholdReached(
  settings: Pick<AppSettings, 'idlePauseEnabled' | 'idlePauseMinutes'>,
  idleMs: number,
): boolean {
  return settings.idlePauseEnabled && idleMs >= settings.idlePauseMinutes * 60_000;
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
  return { ms, entry: { date: localDate(end), start: t.sessionStartedAt ?? t.startedAt, end, ms } };
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

/**
 * Edit or delete a settled history entry, adjusting totals by the delta
 * instead of recomputing them: imported legacy tasks may carry timeSpent
 * that has no backing entry. newEntry === null deletes oldEntry.
 */
export function applyEntryChange(
  task: Task,
  oldEntry: TimeEntry | null,
  newEntry: TimeEntry | null,
): Task {
  let entries = task.timeEntries;
  if (oldEntry) {
    const idx = entries.findIndex(
      (e) => e.start === oldEntry.start && e.end === oldEntry.end && e.ms === oldEntry.ms,
    );
    entries = idx === -1 ? entries : [...entries.slice(0, idx), ...entries.slice(idx + 1)];
  }
  if (newEntry) entries = [...entries, newEntry];

  const perDay = { ...task.timeSpentOnDay };
  if (oldEntry) {
    const left = Math.max(0, (perDay[oldEntry.date] ?? 0) - oldEntry.ms);
    if (left === 0) delete perDay[oldEntry.date];
    else perDay[oldEntry.date] = left;
  }
  if (newEntry) perDay[newEntry.date] = (perDay[newEntry.date] ?? 0) + newEntry.ms;

  const delta = (newEntry?.ms ?? 0) - (oldEntry?.ms ?? 0);
  return {
    ...task,
    timeSpent: Math.max(0, task.timeSpent + delta),
    timeSpentOnDay: perDay,
    timeEntries: entries,
  };
}
