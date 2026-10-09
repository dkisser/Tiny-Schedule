import { settleActiveTimer, settleTimer, type TimingStopResult } from '@tiny-schedule/shared';
import { type AiLogger, consoleLogger } from '../ai/logger';
import type { DataStore } from './dataStore';

/**
 * Port of the `stopTiming` / `settleForQuit` half of
 * packages/app/src/main/services/taskService.ts.
 *
 * Only the timer-stopping half is here. The Electron service was the single
 * write entry point for tasks *and* timing (ADR-0003), but in this port those
 * duties have been split by the files that already cover them: `api/data.ts`
 * owns task upsert / delete / finishDay / timerSync. Duplicating them here
 * would give the same invariant — "completing a task ends its timing" — two
 * enforcement points, and the one that drifts is the one nobody reads.
 *
 * The domain rules are the original's, unchanged. What changed is the shape of
 * the call: the Electron main process held a synchronous `DataStore` whose
 * read-modify-write happened inside one tick, so `stopTiming` was a
 * synchronous function that read the dataset and settled it in a straight
 * line. Here every read and every write is an awaited round trip through the
 * webview's store, so both are async, and `update` answers with a
 * `WriteResult` whose `persisted` flag decides which branch is taken — see the
 * WRITE_REFUSED branch below, which is how this port can report a settlement
 * that never reached the disk instead of handing back the degraded dataset as
 * if it had.
 */
export interface TaskServiceDeps {
  store: DataStore;
  logger?: AiLogger;
}

export function createTaskService({ store, logger = consoleLogger }: TaskServiceDeps) {
  // Declared as plain closures rather than object-literal methods so they stay
  // callable after destructuring: `settleForQuit` runs on the quit path, and a
  // `this`-bound call there would throw and leave the app unquittable with a
  // timer still running.
  const stopTiming = async (
    now = Date.now(),
    expectedTaskId?: string,
  ): Promise<TimingStopResult> => {
    const current = await store.get();
    const timer = current.activeTimer;
    if (!timer) return { ok: false, error: 'NO_ACTIVE_TIMER', data: current };
    if (expectedTaskId !== undefined && timer.taskId !== expectedTaskId) {
      // Someone else's session is running. Settling it here would bill the
      // wrong task, so decline and hand back the truth of what's on record.
      // Distinct from NO_ACTIVE_TIMER on purpose: there the caller was right
      // and there was simply nothing to stop, whereas here a real session is
      // still being billed by someone else. Collapsing the two told the caller
      // nothing had happened while a timer kept running, so the interval it
      // was already accruing was silently dropped.
      logger.info({
        action: 'timer:stop:skip',
        taskId: timer.taskId,
        expectedTaskId,
      });
      return { ok: false, error: 'TIMER_MISMATCH', data: current };
    }
    const task = current.tasks[timer.taskId];
    if (!task) {
      const { data } = await store.update((d) => ({ ...d, activeTimer: null }));
      logger.info({ action: 'timer:drop:stop', taskId: timer.taskId, reason: 'not-found' });
      return { ok: false, error: 'TASK_NOT_FOUND', data };
    }
    if (task.isDone) {
      const { data } = await store.update((d) => ({ ...d, activeTimer: null }));
      logger.info({ action: 'timer:drop:stop', taskId: timer.taskId, reason: 'task-done' });
      // Distinct from TASK_NOT_FOUND: the row exists, we deliberately
      // refused to bill it. Conflating the two told the renderer "nothing
      // to stop" for a stop that actually threw the session away.
      //
      // A refused write takes the WRITE_REFUSED branch instead, on its own:
      // these two carry `data` because the drop was actually written, and a
      // refusal carries none because nothing happened.
      return { ok: false, error: 'TASK_ALREADY_DONE', data };
    }
    // `settledMs` comes out of the same pure transition that produced the
    // data, captured in the closure rather than recomputed — a second
    // `settleTimer` call could disagree with the write that actually landed.
    let settledMs = 0;
    const { data, persisted } = await store.update((d) => {
      const settled = settleActiveTimer(d, timer, now);
      settledMs = settled.settledMs;
      return settled.data;
    });
    // A refused write is not a settlement. Reporting ok:true here told the
    // renderer "this time was recorded" for a settlement that exists nowhere
    // but in the returned (degraded, unpersisted) dataset — the user closed
    // the app believing their hours were saved.
    if (!persisted) {
      // The store refused before running the mutation, so nothing was
      // recorded and `settledMs` never left 0. What would have been billed is
      // recomputed here for the log alone: with no write on disk there is no
      // landed settlement for this number to disagree with.
      logger.error({
        action: 'timer:settle:refused',
        taskId: timer.taskId,
        ms: settleTimer(timer, now).ms,
        note: 'the settlement was discarded; nothing was written to disk',
      });
      return { ok: false, error: 'WRITE_REFUSED' };
    }
    logger.info({ action: 'timer:settle:stop', taskId: timer.taskId, ms: settledMs });
    return { ok: true, data, settledMs };
  };

  return {
    /**
     * Stop the running timing session and settle it here, in the host side of
     * the webview. See the closure above for the rules; it is re-exposed here
     * so the timer channel reaches it through the service like every other
     * write.
     */
    stopTiming,

    /**
     * Settle a running timer during app quit. Same rules as stopTiming, but
     * it reports the ms settled (or 0) instead of the contract envelope,
     * because the quit path has no caller waiting on a reply.
     */
    settleForQuit: async (now = Date.now()): Promise<number> => {
      const result = await stopTiming(now);
      return result.ok ? result.settledMs : 0;
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;
