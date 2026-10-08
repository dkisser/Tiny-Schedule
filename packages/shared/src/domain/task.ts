import { z } from 'zod';
import type { AppData, AppSettings } from './appData';
import type { Project } from './project';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type TimerMode = 'free' | 'pomodoro';
export type PomodoroPhase = 'focus' | 'break';

export interface TimeEntry {
  date: string; // YYYY-MM-DD
  start: number; // epoch ms
  end: number; // epoch ms
  ms: number;
}

export interface Task {
  id: string;
  title: string;
  projectId: string;
  tagIds: string[];
  // Snapshots of project/tag display names at assignment time; later renames
  // or deletions of projects/tags must not propagate into existing tasks.
  projectTitle?: string;
  tagSnapshots?: Record<string, { title: string; color?: string }>;
  subTaskIds: string[];
  parentTaskId?: string;
  isDone: boolean;
  doneAt?: number;
  dueDay?: string; // YYYY-MM-DD
  timeEstimate: number; // ms
  timeSpent: number; // ms
  timeSpentOnDay: Record<string, number>; // date -> ms
  timeEntries: TimeEntry[];
  notes: string;
  created: number; // epoch ms
}

export interface ActiveTimer {
  taskId: string;
  startedAt: number; // epoch ms of current running segment
  accumulatedMs: number; // ms accumulated from previous segments
  isPaused: boolean;
  pausedAt?: number; // epoch ms when paused
  sessionStartedAt?: number; // epoch ms of the very first segment; absent in legacy data
  autoPausedBy?: 'sleep' | 'idle'; // set only by automatic pauses
  // Pomodoro fields (all optional; absent => free-mode timer).
  mode?: TimerMode; // absent on legacy data => treated as 'free'
  phase?: PomodoroPhase; // current phase when mode === 'pomodoro'
  phaseStartedAt?: number; // epoch ms when the current phase segment started (mirrors startedAt)
  phaseAccumulatedMs?: number; // ms accumulated in current phase from previous segments (mirrors accumulatedMs)
  phaseDurationMs?: number; // target length of the current phase
  cyclesCompleted?: number; // number of focus phases completed in this session
  // ms accumulated in `focus` phases across pauses and phase boundaries. Only
  // set on pomodoro timers; absent on legacy/free timers. Used to exclude
  // break time from the settled TimeEntry.
  focusAccumulatedMs?: number;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const TimeEntrySchema = z.object({
  date: z.string(),
  start: z.number(),
  end: z.number(),
  ms: z.number(),
});

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  projectId: z.string(),
  tagIds: z.array(z.string()),
  projectTitle: z.string().optional(),
  tagSnapshots: z
    .record(z.string(), z.object({ title: z.string(), color: z.string().optional() }))
    .optional(),
  subTaskIds: z.array(z.string()),
  parentTaskId: z.string().optional(),
  isDone: z.boolean(),
  doneAt: z.number().optional(),
  dueDay: z.string().optional(),
  timeEstimate: z.number().min(0),
  timeSpent: z.number().min(0),
  timeSpentOnDay: z.record(z.string(), z.number()),
  timeEntries: z.array(TimeEntrySchema),
  notes: z.string(),
  created: z.number(),
});
export type TaskPayload = z.infer<typeof TaskSchema>;

export const ActiveTimerSchema = z.object({
  taskId: z.string(),
  startedAt: z.number(),
  accumulatedMs: z.number(),
  isPaused: z.boolean(),
  pausedAt: z.number().optional(),
  sessionStartedAt: z.number().optional(),
  autoPausedBy: z.enum(['sleep', 'idle']).optional(),
  mode: z.enum(['free', 'pomodoro']).optional(),
  phase: z.enum(['focus', 'break']).optional(),
  phaseStartedAt: z.number().optional(),
  phaseAccumulatedMs: z.number().optional(),
  phaseDurationMs: z.number().optional(),
  cyclesCompleted: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function newTaskId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankTask(title: string, project: Project): Task {
  return {
    id: newTaskId(),
    title,
    projectId: project.id,
    projectTitle: project.title,
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

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
    focusAccumulatedMs: 0,
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
  // Pause folds the new segment delta (now - phaseStartedAt) into
  // focusAccumulatedMs so the live computeFocusElapsed still reports the
  // correct total during a pause. Resume just rebases phaseStartedAt, so the
  // next fold is again a delta — no double counting.
  const focusFold =
    t.mode === 'pomodoro' && t.phase === 'focus' && t.phaseStartedAt !== undefined
      ? {
          focusAccumulatedMs: (t.focusAccumulatedMs ?? 0) + Math.max(0, now - t.phaseStartedAt),
        }
      : {};
  return {
    ...t,
    accumulatedMs: t.accumulatedMs + Math.max(0, now - t.startedAt),
    isPaused: true,
    pausedAt: now,
    autoPausedBy: undefined,
    ...phaseFold,
    ...focusFold,
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

/**
 * Elapsed ms spent in `focus` phases only (pomodoro mode). Break time is
 * excluded so the settled TimeEntry reflects actual focused work. For
 * free-mode and legacy timers this falls back to the full `computeElapsed`.
 */
export function computeFocusElapsed(t: ActiveTimer, now: number): number {
  if (t.mode !== 'pomodoro') return computeElapsed(t, now);
  const acc = t.focusAccumulatedMs ?? 0;
  if (t.isPaused || t.phase !== 'focus') return acc;
  return acc + Math.max(0, now - (t.phaseStartedAt ?? now));
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
  const focusMs = opts.focusMs ?? POMODORO_FOCUS_MS;
  const breakMs = opts.breakMs ?? POMODORO_BREAK_MS;
  const finishedPhase: PomodoroPhase = t.phase ?? 'focus';
  const completed = t.cyclesCompleted ?? 0;

  if (finishedPhase === 'focus') {
    const nextCompleted = completed + 1;
    // Fold only the post-last-fold delta so pause's earlier fold and
    // advance's fold don't double-count the same segment. The pause path
    // already rebased phaseStartedAt to the pause instant, so
    // `now - phaseStartedAt` is the trailing delta only.
    const focusFold = {
      focusAccumulatedMs:
        (t.focusAccumulatedMs ?? 0) + Math.max(0, now - (t.phaseStartedAt ?? now)),
    };
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
          ...focusFold,
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
        ...focusFold,
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
  // Pomodoro timers settle with focus-only time; break is excluded.
  const ms = isPomodoro(t) ? computeFocusElapsed(t, now) : computeElapsed(t, now);
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

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface CompleteResult {
  /** The task with its timing settled in and `isDone` set. Persist in one write. */
  task: Task;
  /**
   * The timer to persist afterwards: `null` when this task's own timing was
   * ended, or the untouched timer when a *different* task is being timed.
   */
  timer: ActiveTimer | null;
  /** The settlement folded into `task`, or null when nothing was recorded. */
  settlement: Settlement | null;
}

/**
 * Mark a task done, ending the timing session running on it.
 *
 * The timing session is a global singleton held outside the task and linked
 * only by `taskId`, so no task mutation can stop it on its own — this is the
 * one place the two meet. Two rules shape the behaviour:
 *
 * - Timing is frozen at `now`, the moment the user chose to complete, not at
 *   however long the confirmation dialog stays open.
 * - A timer belonging to a different task is left running. Completing an
 *   unrelated task must never settle someone else's time.
 *
 * `pauseTimer` is a no-op on an already-paused timer, so a pause the user set
 * earlier still settles at its own `pausedAt` instead of being advanced to now.
 */
export function completeTask(task: Task, timer: ActiveTimer | null, now: number): CompleteResult {
  // Respect a doneAt the caller supplied (backfilling a task completed
  // earlier); only fill one in when completing it right now.
  const done: Task = { ...task, isDone: true, doneAt: task.doneAt ?? now };

  if (!timer || timer.taskId !== task.id) {
    return { task: done, timer, settlement: null };
  }

  const settlement = settleTimer(pauseTimer(timer, now), now);
  if (settlement.ms <= 0) {
    // Nothing worth recording (a zero-length session), but the timer still
    // ends: a done task must never be left being timed.
    return { task: done, timer: null, settlement: null };
  }
  return { task: applySettlement(done, settlement), timer: null, settlement };
}

/**
 * Roll unfinished tasks due today to tomorrow so they remain visible in the
 * dueDay-driven Today view instead of silently disappearing when the day is
 * finished. Done tasks and tasks due on any other day are untouched.
 */
export function rollUnfinishedDueDay(
  tasks: Record<string, Task>,
  today: string,
  tomorrow: string,
): Record<string, Task> {
  const next: Record<string, Task> = { ...tasks };
  for (const t of Object.values(tasks)) {
    if (!t.isDone && t.dueDay === today) {
      next[t.id] = { ...t, dueDay: tomorrow };
    }
  }
  return next;
}

export interface UpsertTaskResult {
  data: AppData;
  /** Ms recorded because this write completed a timed task; 0 otherwise. */
  settledMs: number;
}

/**
 * Apply a task upsert, enforcing that completing a task ends its timing.
 *
 * This is the enforcement point rather than a UI convention: every write path
 * (the completion checkbox, the subtask checkbox, a future keyboard shortcut or
 * agent tool) goes through here, so none of them can leave a done task being
 * timed. The task and the timer move in a single immutable transition, so a
 * crash can never catch them out of step — which is what made a settle-then-clear
 * pair of writes unsafe: an interruption there produced a done, already-recorded
 * task that a later recovery pass would record a second time.
 *
 * Only a false -> true transition settles anything. Re-saving an already-done
 * task (a title edit, say) must not disturb whatever else is being timed, but it
 * still sweeps a stale timer: whatever the write was, its result must not be a
 * done task that is still being timed.
 */
export function upsertTaskWithTiming(data: AppData, incoming: Task, now: number): UpsertTaskResult {
  const stored = data.tasks[incoming.id];
  const task: Task = {
    ...incoming,
    // Completing now stamps the moment. An already-done task keeps whatever
    // completion time it already had rather than sliding forward to `now`,
    // which would change which days it counts as done on.
    doneAt: incoming.isDone ? (incoming.doneAt ?? stored?.doneAt ?? now) : undefined,
  };
  const completing = task.isDone && !stored?.isDone;

  if (!completing) {
    return {
      data: dropStaleTiming({ ...data, tasks: { ...data.tasks, [task.id]: task } }),
      settledMs: 0,
    };
  }

  const result = completeTask(task, data.activeTimer, now);
  return {
    // Sweep here too, not just on the non-completing path: `result.timer` is
    // the *other* task's timer when one is running, and that task may itself be
    // done (reachable by an import, which keeps the current activeTimer while
    // letting an imported task win an id collision).
    data: dropStaleTiming({
      ...data,
      tasks: { ...data.tasks, [task.id]: result.task },
      activeTimer: result.timer,
    }),
    settledMs: result.settlement?.ms ?? 0,
  };
}

/**
 * Drop a timing session whose task is already done, recording nothing.
 *
 * Recovery paths must clear rather than settle. A done task holding a timer is
 * ambiguous: the time may already have been recorded (an interrupted write) or
 * never recorded at all (data from before this rule existed). Settling on that
 * guess double-bills the first case, so the safe direction is to discard — and
 * repairing historical timing is deliberately out of scope.
 */
export function dropStaleTiming(data: AppData): AppData {
  const timer = data.activeTimer;
  if (!timer || !data.tasks[timer.taskId]?.isDone) return data;
  return { ...data, activeTimer: null };
}
