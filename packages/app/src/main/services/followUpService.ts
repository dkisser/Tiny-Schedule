import {
  type AppData,
  type FollowUp,
  type FollowUpCommandResult,
  reopenFollowUp,
  resolveFollowUp,
} from '@tiny-schedule/shared';
import type { ServiceDeps } from './taskService';

/**
 * 跟进的写侧唯一入口（ADR-0003）。跟进的状态机足够简单，保持 upsert + 守卫
 * （与 ADR 的决定一致）；resolve/reopen 是命令式的入口，与想法不同不强制切换。
 */

export function createFollowUpService({ store, logger }: ServiceDeps) {
  const persist = (followUp: FollowUp): AppData => {
    const next = store.update((d) => ({
      ...d,
      followUps: { ...d.followUps, [followUp.id]: followUp },
    }));
    logger.info({ action: 'followUp:upsert', followUpId: followUp.id, title: followUp.title });
    return next;
  };

  return {
    /** Legacy unconditional overwrite write; the transition rules below ride on it. */
    upsert(followUp: FollowUp): AppData {
      return persist(followUp);
    },

    remove(id: string): AppData {
      const next = store.update((d) => {
        const followUps = { ...d.followUps };
        delete followUps[id];
        return { ...d, followUps };
      });
      logger.info({ action: 'followUp:delete', followUpId: id });
      return next;
    },

    /**
     * 办结：记录了结时刻。
     *
     * Rejections are envelopes, not nulls — the caller is the renderer, which
     * would otherwise have no way to tell "this follow-up is gone" from "the
     * dataset failed to load".
     */
    resolve(id: string, now = Date.now()): FollowUpCommandResult {
      const current = store.get().followUps[id];
      if (!current) {
        logger.info({ action: 'followUp:rejected', followUpId: id, error: 'FOLLOW_UP_NOT_FOUND' });
        return { ok: false, error: 'FOLLOW_UP_NOT_FOUND' };
      }
      return { ok: true, data: persist(resolveFollowUp(current, now)) };
    },

    /** 恢复跟进：清空了结时刻，回到等待中。 */
    reopen(id: string): FollowUpCommandResult {
      const current = store.get().followUps[id];
      if (!current) {
        logger.info({ action: 'followUp:rejected', followUpId: id, error: 'FOLLOW_UP_NOT_FOUND' });
        return { ok: false, error: 'FOLLOW_UP_NOT_FOUND' };
      }
      return { ok: true, data: persist(reopenFollowUp(current)) };
    },
  };
}

export type FollowUpService = ReturnType<typeof createFollowUpService>;
