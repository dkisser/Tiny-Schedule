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
  getSummary,
  type QueriedTask,
  type QueryTasksParams,
  queryTasks,
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
        return { ...d, tasks };
      });
      logger.info({ action: 'task:delete', taskId: id });
      return next;
    },

    /**
     * Persist a timer the renderer reports. Same invariant as upsert: a timer
     * may never be persisted for a task that is already done, whoever is
     * asking to sync it. Returns the persisted state so the caller can tell
     * whether the timer survived.
     */
    syncTimer(timer: ActiveTimer | null): { data: AppData; dropped: boolean } {
      if (!timer) {
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
     *
     * The quit and auto-pause paths already settle on this side; making the
     * stop path do the same removes the renderer's word from the answer to
     * "how much time did this record". A done task is dropped rather than
     * settled: the time may already have been recorded, and settling again
     * would bill it twice.
     */
    stopTiming(now = Date.now()): TimingStopResult {
      const current = store.get();
      const timer = current.activeTimer;
      if (!timer) return { ok: false, error: 'NO_ACTIVE_TIMER' };
      const task = current.tasks[timer.taskId];
      if (!task) {
        const data = store.update((d) => ({ ...d, activeTimer: null }));
        logger.info({ action: 'timer:drop:stop', taskId: timer.taskId, reason: 'not-found' });
        return { ok: false, error: 'TASK_NOT_FOUND' };
      }
      if (task.isDone) {
        const data = store.update((d) => ({ ...d, activeTimer: null }));
        logger.info({ action: 'timer:drop:stop', taskId: timer.taskId, reason: 'task-done' });
        return { ok: false, error: 'TASK_NOT_FOUND' };
      }
      const settlement = settleTimer(timer, now);
      const data = store.update((d) => {
        const t = d.tasks[timer.taskId];
        if (!t) return { ...d, activeTimer: null };
        return {
          ...d,
          tasks: { ...d.tasks, [t.id]: applySettlement(t, settlement) },
          activeTimer: null,
        };
      });
      logger.info({ action: 'timer:settle:stop', taskId: timer.taskId, ms: settlement.ms });
      return { ok: true, data, settledMs: settlement.ms };
    },

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
      const result = this.stopTiming(now);
      return result.ok ? result.settledMs : 0;
    },

    // --- 读侧查询：AI agent 的工具经由这里取数（ADR-0003：tools 的读也走 services） ---

    queryTasks(params: QueryTasksParams): QueriedTask[] {
      return queryTasks(store.get(), params);
    },

    getSummary(params: SummaryParams): SummaryResult {
      return getSummary(store.get(), params);
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;
