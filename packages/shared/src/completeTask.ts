import type { ActiveTimer, Task } from './models';
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
  const done: Task = { ...task, isDone: true, doneAt: now };

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
