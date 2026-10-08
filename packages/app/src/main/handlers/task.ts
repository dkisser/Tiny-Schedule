import { Ipc, type Task } from '@tiny-schedule/shared';
import type { HandlerDeps } from './deps';
import { masked, sendSafe } from './deps';

/** 任务与计时的 handler：只转调 taskService，不判断领域规则。 */
export function taskHandlers({ tasks, logger, getWindow }: HandlerDeps) {
  return {
    taskUpsert: (task: Task) => {
      const { data, settledMs } = tasks.upsert(task);
      return { data: masked(data), settledMs };
    },

    taskDelete: ({ id }: { id: string }) => masked(tasks.remove(id)),

    timerSync: ({ timer }: { timer: Parameters<HandlerDeps['tasks']['syncTimer']>[0] }) => {
      const { dropped } = tasks.syncTimer(timer);
      if (dropped) {
        // Announce the drop. Staying silent would leave the renderer's clock
        // ticking for a session the main process just discarded — and its next
        // stop would settle that time into the done task.
        sendSafe(getWindow(), Ipc.timerChanged, null);
      }
    },

    /**
     * Stop timing. The main process settles here, so `settledMs` is the
     * authority on "how much time did this record" — the renderer no longer
     * gets to be the one that decides. `req.taskId` pins which session to
     * settle so a racing sync() can't make this bill the wrong task.
     */
    timingStop: (req: { taskId?: string }) => {
      const result = tasks.stopTiming(Date.now(), req.taskId);
      if (!result.ok) {
        // Rejections still carry data: the main process may already have
        // dropped the timer, and the renderer needs to see that.
        logger.info({ action: 'timing:stop', error: result.error });
        return { ...result, data: masked(result.data) };
      }
      return { ok: true as const, data: masked(result.data), settledMs: result.settledMs };
    },

    finishDay: () => masked(tasks.finishDay()),
  };
}
