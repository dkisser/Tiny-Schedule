import type { ActiveTimer, AppData, Task } from './models';
import { applySettlement, pauseTimer, type Settlement, settleTimer } from './timer';

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
