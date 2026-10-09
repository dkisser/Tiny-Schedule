import {
  type ActiveTimer,
  type AppData,
  addDays,
  applySettlement,
  dropStaleTiming,
  localDate,
  rollUnfinishedDueDay,
  sameTimer,
  settleTimer,
  type Task,
  type TimingStopResult,
  upsertTaskWithTiming,
} from '@tiny-schedule/shared';
import type { Logger } from 'pino';
import type { DataStore } from '../infra/dataStore';
import {
  createTaskQueries,
  type QueriedTask,
  type QueryTasksParams,
  type SummaryParams,
  type SummaryResult,
} from './taskQueries';

export interface ServiceDeps {
  store: DataStore;
  logger: Logger;
}

/**
 * 任务与计时的唯一写入口（ADR-0003）。
 *
 * 每个方法都是 load → 调 shared domain 纯函数 → persist 的一笔不可变转换。
 * 领域不变量（完成任务即结束计时、陈旧计时的清扫、finishDay 的到期日滚动）
 * 一律在这里强制，handler 只做 zod 校验与转调。
 */

export interface UpsertTaskOutcome {
  data: AppData;
  /** Ms recorded because this write completed a timed task; 0 otherwise. */
  settledMs: number;
  /** False when the store refused the write (data.json unreadable). */
  persisted: boolean;
}

export function createTaskService({ store, logger }: ServiceDeps) {
  const reads = createTaskQueries(() => store.get());

  // Declared as plain closures rather than object-literal methods so they stay
  // callable after destructuring: `settleForQuit` runs inside `before-quit`, and
  // a `this`-bound call there would throw and leave the app unquittable with a
  // timer still running.
  const stopTiming = (now = Date.now(), expectedTaskId?: string): TimingStopResult => {
    const current = store.get();
    const timer = current.activeTimer;
    if (!timer) return { ok: false, error: 'NO_ACTIVE_TIMER', data: current };
    if (expectedTaskId !== undefined && timer.taskId !== expectedTaskId) {
      // Someone else's session is running. Settling it here would bill the
      // wrong task, so decline and hand back the truth of what's on record.
      logger.info({
        action: 'timer:stop:skip',
        taskId: timer.taskId,
        expectedTaskId,
      });
      return { ok: false, error: 'TIMER_MISMATCH', data: current };
    }
    const task = current.tasks[timer.taskId];
    if (!task) {
      const { data } = store.update((d) => ({ ...d, activeTimer: null }));
      logger.info({ action: 'timer:drop:stop', taskId: timer.taskId, reason: 'not-found' });
      return { ok: false, error: 'TASK_NOT_FOUND', data };
    }
    if (task.isDone) {
      const { data } = store.update((d) => ({ ...d, activeTimer: null }));
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
    const settlement = settleTimer(timer, now);
    const { data, persisted } = store.update((d) => {
      const t = d.tasks[timer.taskId];
      if (!t) return { ...d, activeTimer: null };
      // A zero-length stop records nothing. Without this guard a timer started
      // and stopped in the same millisecond appends a phantom TimeEntry and a
      // zero-valued timeSpentOnDay key — and those two are what the worklog
      // and the delete-confirmation dialog read to decide "this task has
      // recorded time". completeTask keeps the same `ms <= 0` rule.
      if (settlement.ms <= 0) return { ...d, activeTimer: null };
      return {
        ...d,
        tasks: { ...d.tasks, [t.id]: applySettlement(t, settlement) },
        activeTimer: null,
      };
    });
    // A refused write is not a settlement. Reporting ok:true here told the
    // renderer "this time was recorded" for a settlement that exists nowhere
    // but in the returned (degraded, unpersisted) dataset — the user closed
    // the app believing their hours were saved.
    if (!persisted) {
      logger.error({
        action: 'timer:settle:refused',
        taskId: timer.taskId,
        ms: settlement.ms,
        note: 'the settlement was discarded; nothing was written to disk',
      });
      return { ok: false, error: 'WRITE_REFUSED' };
    }
    logger.info({ action: 'timer:settle:stop', taskId: timer.taskId, ms: settlement.ms });
    return { ok: true, data, settledMs: settlement.ms };
  };

  return {
    /**
     * The single enforcement point for "completing a task ends its timing":
     * every write path funnels through here, so no entry point can leave a
     * done task being timed. upsertTaskWithTiming also normalizes doneAt and
     * moves the task and the timer in one atomic transition. settledMs goes
     * back to the caller so the renderer reports what was actually recorded
     * instead of predicting it.
     */
    upsert(task: Task, now = Date.now()): UpsertTaskOutcome {
      let settledMs = 0;
      const { data: next, persisted } = store.update((d) => {
        const r = upsertTaskWithTiming(d, task, now);
        settledMs = r.settledMs;
        return r.data;
      });
      logger.info({ action: 'task:upsert', taskId: task.id, title: task.title, settledMs });
      return { data: next, settledMs, persisted };
    },

    remove(id: string): AppData {
      const { data: next } = store.update((d) => {
        const tasks = { ...d.tasks };
        delete tasks[id];
        // detach from parent's subTaskIds
        for (const t of Object.values(tasks)) {
          if (t.subTaskIds.includes(id)) {
            tasks[t.id] = { ...t, subTaskIds: t.subTaskIds.filter((s) => s !== id) };
          }
        }
        // A deleted task leaves its timer behind as an unkillable ghost:
        // dropStaleTiming only tests `tasks[timer.taskId]?.isDone`, and a
        // *missing* task yields undefined, which is not true — so the sweep
        // never fires on this path. Every heartbeat then re-persists the
        // orphan, and the eventual stop reports TASK_NOT_FOUND and records
        // nothing. Run it here so delete is as clean as completion.
        const cleaned = dropStaleTiming({ ...d, tasks });
        if (cleaned.activeTimer !== d.activeTimer) {
          logger.info({ action: 'timer:drop:delete', taskId: id });
        }
        return cleaned;
      });
      logger.info({ action: 'task:delete', taskId: id });
      return next;
    },

    /** The timer currently on record, or null. Read-only. */
    currentTimer(): ActiveTimer | null {
      return store.get().activeTimer;
    },

    /**
     * Persist a timer the renderer reports. Same invariant as upsert: a timer
     * may never be persisted for a task that is already done, whoever is
     * asking to sync it. Returns the persisted state so the caller can tell
     * whether the timer survived, and whether the write was refused.
     */
    syncTimer(timer: ActiveTimer | null): { data: AppData; dropped: boolean; persisted: boolean } {
      if (!timer) {
        // Nothing to clear. Every write re-validates the whole dataset and
        // copies the backup, and stop() clears after settling — so skipping
        // the no-op keeps a stop at one write instead of two.
        const current = store.get();
        if (!current.activeTimer) return { data: current, dropped: false, persisted: true };
        const { data, persisted } = store.update((d) => ({ ...d, activeTimer: null }));
        return { data, dropped: false, persisted };
      }
      // The renderer's 30s heartbeat re-sends the same timer it already has.
      // Persisting it again costs a full schema validation, a backup copy and
      // a temp+rename per tick — ~120 identical writes an hour, which is the
      // dominant write load of a running app and wears the disk for nothing.
      //
      // By *value*, not by identity. The two sides can never share a reference:
      // what the renderer holds arrived over IPC as a structured clone, and
      // what the store holds is whatever zod allocated during the last parse.
      // An identity check passed here only because the test double handed back
      // the same in-process object — it was never true in production, which
      // made this branch dead code and left the optimization unmade.
      const current = store.get();
      // The stale-timer sweep runs *before* the equality test, never after: an
      // unchanged timer on a task that has since been completed still has to
      // be dropped, and short-circuiting on equality first let that invariant
      // slip through — the heartbeat would keep a done task being timed
      // indefinitely, which is the one thing this port exists to prevent.
      // dropStaleTiming returns the same reference when nothing was stale.
      const storedIsStale = dropStaleTiming(current).activeTimer !== current.activeTimer;
      // Only short-circuit on a *writable* store. update() is what attempts
      // recovery, so returning early skipped it: a store that had latched on an
      // unreadable data.json — and whose fallback happened to carry the very
      // timer the renderer is sending — would match here on every heartbeat,
      // never re-read the file the user had repaired, and stay latched for the
      // rest of the session. The deferred migrations never ran, and every other
      // write stayed refused.
      if (!storedIsStale && store.isWritable && sameTimer(current.activeTimer, timer)) {
        return { data: current, dropped: false, persisted: true };
      }
      const { data: next, persisted } = store.update((d) =>
        dropStaleTiming({ ...d, activeTimer: timer }),
      );
      if (!next.activeTimer) {
        logger.info({ action: 'timer:drop:sync', taskId: timer.taskId });
        return { data: next, dropped: true, persisted };
      }
      logger.info({ action: 'timer:sync', taskId: timer.taskId, isPaused: timer.isPaused });
      return { data: next, dropped: false, persisted };
    },

    /**
     * Stop the running timing session and settle it here, in the main process.
     * See the closure above for the rules; it is re-exposed here so handlers
     * reach it through the service like every other write.
     */
    stopTiming,

    /**
     * Finish the local "today": unfinished tasks due today roll to tomorrow so
     * they stay visible in the dueDay-driven Today view.
     */
    finishDay(now = Date.now()): AppData {
      const today = localDate(now);
      const tomorrow = addDays(today, 1);
      const { data: next } = store.update((d) => ({
        ...d,
        tasks: rollUnfinishedDueDay(d.tasks, today, tomorrow),
        misc: { ...d.misc, lastFinishDay: today },
      }));
      logger.info({ action: 'day:finish', date: today });
      return next;
    },

    /**
     * Settle a running timer during app quit. Same rules as stopTiming, but
     * it reports the ms settled (or 0) instead of the contract envelope,
     * because the quit path has no renderer waiting on a reply.
     */
    settleForQuit(now = Date.now()): number {
      const result = stopTiming(now);
      return result.ok ? result.settledMs : 0;
    },

    // --- 读侧查询：AI agent 的工具经由这里取数（ADR-0003：tools 的读也走 services） ---

    queryTasks(params: QueryTasksParams): QueriedTask[] {
      return reads.queryTasks(params);
    },

    getSummary(params: SummaryParams): SummaryResult {
      return reads.getSummary(params);
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;
