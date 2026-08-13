import type { ActiveTimer, AppSettings, PomodoroPhase, Task, TimeEntry } from './models';

/** Default focus phase length for pomodoro mode (25 minutes). */
export const POMODORO_FOCUS_MS = 25 * 60_000;
/** Default break phase length for pomodoro mode (5 minutes). */
export const POMODORO_BREAK_MS = 5 * 60_000;
/** Number of focus phases in one complete pomodoro set. */
export const POMODORO_CYCLES_PER_SET = 4;

/** True if this timer runs in pomodoro mode (legacy data without `mode` is treated as free). */
export function isPomodoro(t: ActiveTimer): boolean {
  return t.mode === 'pomodoro';
}

export function startTimer(taskId: string, now: number): ActiveTimer {
  return { taskId, startedAt: now, accumulatedMs: 0, isPaused: false, sessionStartedAt: now };
}

/** Start a fresh pomodoro focus phase on the given task. */
export function startPomodoroFocus(
  taskId: string,
  now: number,
  focusMs: number = POMODORO_FOCUS_MS,
): ActiveTimer {
  return {
    taskId,
    startedAt: now,
    accumulatedMs: 0,
    isPaused: false,
    sessionStartedAt: now,
    mode: 'pomodoro',
    phase: 'focus',
    phaseStartedAt: now,
    phaseAccumulatedMs: 0,
    phaseDurationMs: focusMs,
    cyclesCompleted: 0,
  };
}

export function pauseTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (t.isPaused) return t;
  const phaseFold =
    t.mode === 'pomodoro' && t.phaseStartedAt !== undefined
      ? {
          phaseAccumulatedMs: (t.phaseAccumulatedMs ?? 0) + Math.max(0, now - t.phaseStartedAt),
          phaseStartedAt: now,
        }
      : {};
  return {
    ...t,
    accumulatedMs: t.accumulatedMs + Math.max(0, now - t.startedAt),
    isPaused: true,
    pausedAt: now,
    autoPausedBy: undefined,
    ...phaseFold,
  };
}

export function resumeTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (!t.isPaused) return t;
  return {
    ...t,
    startedAt: now,
    isPaused: false,
    pausedAt: undefined,
    autoPausedBy: undefined,
    // Keep phaseAccumulatedMs; reset the phase segment anchor so the phase
    // clock keeps ticking in lock-step with the segment clock.
    phaseStartedAt: t.mode === 'pomodoro' ? now : t.phaseStartedAt,
  };
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

/** Elapsed ms within the current pomodoro phase (handles pause correctly). */
export function computePhaseElapsed(t: ActiveTimer, now: number): number {
  if (t.mode !== 'pomodoro' || t.phaseStartedAt === undefined) return 0;
  const acc = t.phaseAccumulatedMs ?? 0;
  if (t.isPaused) return acc;
  return acc + Math.max(0, now - t.phaseStartedAt);
}

/** Has the current pomodoro phase run past its target duration? */
export function isPhaseComplete(t: ActiveTimer, now: number): boolean {
  if (t.mode !== 'pomodoro' || t.phaseDurationMs === undefined) return false;
  return computePhaseElapsed(t, now) >= t.phaseDurationMs;
}

export interface AdvanceResult {
  /** The new timer after the phase transition. */
  next: ActiveTimer;
  /**
   * Which phase was just finished. Renderer can use this to decide which
   * dialog copy to show ("break time" vs "next focus" vs "set complete").
   */
  finishedPhase: PomodoroPhase;
  /** True if the full set (POMODORO_CYCLES_PER_SET focus phases) is done. */
  setComplete: boolean;
}

/**
 * Move a pomodoro timer to the next phase. focus → break increments
 * `cyclesCompleted`; when the just-finished focus was the last in the
 * current set, the timer pauses (still on focus phase) and `setComplete` is
 * true so the caller can ask the user whether to start a new set. break →
 * focus never bumps the counter.
 *
 * The session clock (`startedAt`/`accumulatedMs`) is preserved across
 * transitions so the entire pomodoro span settles as one `TimeEntry`. Only
 * the phase clock resets.
 */
export function advancePomodoroPhase(
  t: ActiveTimer,
  now: number,
  opts: { focusMs?: number; breakMs?: number } = {},
): AdvanceResult {
  if (t.mode !== 'pomodoro') {
    return { next: t, finishedPhase: t.phase ?? 'focus', setComplete: false };
  }
  const focusMs = opts.focusMs ?? t.phaseDurationMs ?? POMODORO_FOCUS_MS;
  const breakMs = opts.breakMs ?? POMODORO_BREAK_MS;
  const finishedPhase: PomodoroPhase = t.phase ?? 'focus';
  const completed = t.cyclesCompleted ?? 0;

  if (finishedPhase === 'focus') {
    const nextCompleted = completed + 1;
    if (nextCompleted >= POMODORO_CYCLES_PER_SET) {
      // Last focus in this set ended: freeze both clocks at `now`, leave the
      // phase as `focus`, and let the renderer decide whether to start a
      // new set or stop the timer.
      const phaseAcc = (t.phaseAccumulatedMs ?? 0) + Math.max(0, now - (t.phaseStartedAt ?? now));
      const segAcc = t.accumulatedMs + Math.max(0, now - t.startedAt);
      return {
        next: {
          ...t,
          cyclesCompleted: nextCompleted,
          isPaused: true,
          pausedAt: now,
          startedAt: now,
          accumulatedMs: segAcc,
          phaseStartedAt: now,
          phaseAccumulatedMs: phaseAcc,
        },
        finishedPhase: 'focus',
        setComplete: true,
      };
    }
    // Normal focus → break: same set continues.
    return {
      next: {
        ...t,
        phase: 'break',
        phaseStartedAt: now,
        phaseAccumulatedMs: 0,
        phaseDurationMs: breakMs,
        cyclesCompleted: nextCompleted,
      },
      finishedPhase,
      setComplete: false,
    };
  }

  // break → focus: start a new focus, no cycle counter change.
  return {
    next: {
      ...t,
      phase: 'focus',
      phaseStartedAt: now,
      phaseAccumulatedMs: 0,
      phaseDurationMs: focusMs,
    },
    finishedPhase,
    setComplete: false,
  };
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
