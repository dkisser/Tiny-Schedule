import { DROPPED_TIMER, Ipc, REFUSED_TIMER, type Task } from '@tiny-schedule/shared';
import type { HandlerDeps } from './deps';
import { masked, REFUSED, sendSafe, written } from './deps';

/** 任务与计时的 handler：只转调 taskService，不判断领域规则。 */
export function taskHandlers({ tasks, logger, getWindow }: HandlerDeps) {
  return {
    // Control flow: completing a task reports what was actually recorded and
    // whether it landed, and CompleteTaskDialog branches on both.
    taskUpsert: (task: Task) => {
      const { data, settledMs, persisted } = tasks.upsert(task);
      if (!persisted) return REFUSED;
      return { ...written(data), settledMs };
    },

    taskDelete: ({ id }: { id: string }) => masked(tasks.remove(id)),

    timerSync: ({ timer }: { timer: Parameters<HandlerDeps['tasks']['syncTimer']>[0] }) => {
      const { dropped, persisted } = tasks.syncTimer(timer);
      // Mutually exclusive, and refusal first: `dropped` is read off the
      // dataset a refused write hands back (a degraded fallback that may carry
      // no timer), so a refusal can report `dropped: true` for a drop that
      // never happened. Announcing it would clear a clock the main process is
      // still counting — and announcing both, as two `timerChanged(null)`
      // sends, is what the two branches did before the payload could tell
      // them apart.
      if (!persisted) {
        // The renderer keeps ticking a session that is not on disk. Say so,
        // rather than letting the next stop report a settlement that never
        // happened and that vanishes on restart. `refused` carries no timer:
        // nothing changed, so the clock must stay where it is.
        logger.error({ action: 'timer:sync:refused', taskId: timer?.taskId ?? null });
        sendSafe(getWindow(), Ipc.timerChanged, REFUSED_TIMER);
        return;
      }
      if (dropped) {
        // Announce the drop. Staying silent would leave the renderer's clock
        // ticking for a session the main process just discarded — and its next
        // stop would settle that time into the done task.
        sendSafe(getWindow(), Ipc.timerChanged, DROPPED_TIMER);
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
      if (result.ok) return { ...written(result.data), settledMs: result.settledMs };
      logger.info({ action: 'timing:stop', error: result.error });
      // Only the domain rejections carry a dataset — the main process dropped
      // the timer and wrote that down, so the renderer must converge on it.
      // WRITE_REFUSED carries none because nothing happened.
      if (result.error === 'WRITE_REFUSED') return result;
      return { ...result, data: masked(result.data) };
    },

    finishDay: () => masked(tasks.finishDay()),
  };
}
