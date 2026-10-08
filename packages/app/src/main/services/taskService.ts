import {
  type ActiveTimer,
  type AppData,
  addDays,
  applySettlement,
  dropStaleTiming,
  localDate,
  rollUnfinishedDueDay,
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
      const data = store.update((d) => ({ ...d, activeTimer: null }));
      logger.info({ action: 'timer:drop:stop', taskId: timer.taskId, reason: 'not-found' });
      return { ok: false, error: 'TASK_NOT_FOUND', data };
    }
    if (task.isDone) {
      const data = store.update((d) => ({ ...d, activeTimer: null }));
      logger.info({ action: 'timer:drop:stop', taskId: timer.taskId, reason: 'task-done' });
      // Distinct from TASK_NOT_FOUND: the row exists, we deliberately
      // refused to bill it. Conflating the two told the renderer "nothing
      // to stop" for a stop that actually threw the session away.
      return { ok: false, error: 'TASK_ALREADY_DONE', data };
    }
    const settlement = settleTimer(timer, now);
    const data = store.update((d) => {
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
      const next = store.update((d) => {
        const r = upsertTaskWithTiming(d, task, now);
        settledMs = r.settledMs;
        return r.data;
      });
      logger.info({ action: 'task:upsert', taskId: task.id, title: task.title, settledMs });
      return { data: next, settledMs };
    },

    remove(id: string): AppData {
      const next = store.update((d) => {
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
     * whether the timer survived.
     */
    syncTimer(timer: ActiveTimer | null): { data: AppData; dropped: boolean } {
      if (!timer) {
        // Nothing to clear. Every write re-validates the whole dataset and
        // copies the backup, and stop() clears unconditionally after settling
        // — so skipping the no-op keeps a stop at one write instead of two and
        // stops the 30s heartbeat from rewriting an unchanged file.
        const current = store.get();
        if (!current.activeTimer) return { data: current, dropped: false };
        return { data: store.update((d) => ({ ...d, activeTimer: null })), dropped: false };
      }
      const next = store.update((d) => dropStaleTiming({ ...d, activeTimer: timer }));
      if (!next.activeTimer) {
        logger.info({ action: 'timer:drop:sync', taskId: timer.taskId });
        return { data: next, dropped: true };
      }
      logger.info({ action: 'timer:sync', taskId: timer.taskId, isPaused: timer.isPaused });
      return { data: next, dropped: false };
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
      const next = store.update((d) => ({
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
