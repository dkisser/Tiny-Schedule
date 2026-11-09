/**
 * Timer rules.
 *
 * dsh has no sleep/idle watcher, so nothing pauses the timer automatically:
 * a session that spans a nap keeps counting until it is stopped. That is a
 * deliberate degradation of the retired desktop app and is surfaced in the UI.
 */
import type { ActiveTimerRecord, TimeEntryRecord } from './schema.ts';
import { localDate } from './time.ts';

export function isPomodoro(t: ActiveTimerRecord): boolean {
  return t.mode === 'pomodoro';
}

/** Elapsed ms, accounting for a paused timer. */
export function computeElapsed(t: ActiveTimerRecord, now: number): number {
  return t.accumulatedMs + (t.isPaused ? 0 : Math.max(0, now - t.startedAt));
}

/** Elapsed ms inside focus phases only; break time is excluded. */
export function computeFocusElapsed(t: ActiveTimerRecord, now: number): number {
  if (t.mode !== 'pomodoro') return computeElapsed(t, now);
  const acc = t.focusAccumulatedMs ?? 0;
  if (t.isPaused || t.phase !== 'focus') return acc;
  return acc + Math.max(0, now - (t.phaseStartedAt ?? now));
}

/** Elapsed ms within the current pomodoro phase. */
export function computePhaseElapsed(t: ActiveTimerRecord, now: number): number {
  if (t.mode !== 'pomodoro' || t.phaseStartedAt === undefined) return 0;
  const acc = t.phaseAccumulatedMs ?? 0;
  if (t.isPaused) return acc;
  return acc + Math.max(0, now - t.phaseStartedAt);
}

/** A freshly started timer. */
export function startTimer(taskId: string, now: number): ActiveTimerRecord {
  return { taskId, startedAt: now, accumulatedMs: 0, isPaused: false, sessionStartedAt: now };
}

/** Pause the timer, remembering the moment it stopped counting. */
export function pauseTimer(t: ActiveTimerRecord, now: number): ActiveTimerRecord {
  if (t.isPaused) return t;
  return {
    ...t,
    accumulatedMs: computeElapsed(t, now),
    isPaused: true,
    pausedAt: now,
  };
}

/** Resume a paused timer; the next session starts counting from now. */
export function resumeTimer(t: ActiveTimerRecord, now: number): ActiveTimerRecord {
  if (!t.isPaused) return t;
  return {
    ...t,
    startedAt: now,
    sessionStartedAt: now,
    isPaused: false,
    pausedAt: undefined,
  };
}

export interface Settlement {
  ms: number;
  entry: Omit<TimeEntryRecord, 'id' | 'taskId'>;
}

/**
 * Close the timer and produce the work interval it measured.
 * Pomodoro timers settle with focus-only time; break is excluded.
 */
export function settleTimer(t: ActiveTimerRecord, now: number): Settlement {
  const ms = isPomodoro(t) ? computeFocusElapsed(t, now) : computeElapsed(t, now);
  const end = t.isPaused ? (t.pausedAt ?? now) : now;
  return { ms, entry: { date: localDate(end), start: t.sessionStartedAt ?? t.startedAt, end, ms } };
}
