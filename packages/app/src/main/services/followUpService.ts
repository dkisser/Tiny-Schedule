import {
  type AppData,
  FOLLOW_UP_CLEARABLE_FIELDS,
  type FollowUp,
  type FollowUpCommandResult,
  type FollowUpEdit,
  reopenFollowUp,
  resolveFollowUp,
} from '@tiny-schedule/shared';
import type { ServiceDeps } from './taskService';

/** The only fields a field edit may write. State advances by command only. */
const EDITABLE_FIELDS = ['title', 'notes', 'createdAt', 'entries', 'nextFollowUpDay'] as const;

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

  /**
   * Field edits are a *merge*, never a whole-record overwrite.
   *
   * The renderer edits with `upsertFollowUp({ ...followUp, ...patch })`, always
   * spreading its render-time snapshot including isResolved/resolvedAt. A
   * write-back from a stale snapshot therefore undid a resolve that had
   * already happened — deterministically, not on a race: MarkdownEditor's
   * cleanup closure captured the mount-time followUp, so resolving from the
   * list row beside an open notes editor and then closing it reverted the
   * 办结 with no error and no log. Ideas got this merge for the same reason.
   */
  const merge = (patch: FollowUpEdit): AppData => {
    const next = store.update((d) => {
      const stored = d.followUps[patch.id];
      // An allowlist, not "filter out undefined": the state fields are not on
      // the edit contract, and a caller that supplies them anyway (a spread
      // straight from a stale record) must not be able to move the state. The
      // schema strips them at the wire, but the enforcement point is here, so
      // it does not rely on that.
      const changes: Record<string, unknown> = {};
      const cleared = new Set<string>();
      for (const key of EDITABLE_FIELDS) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue; // "leave this alone"
        // `null` means "clear", and the key is dropped below rather than
        // written as null — the domain type has no null. Driven by the
        // registry so a newly nullable field cannot become unclearable.
        if (value === null) {
          if ((FOLLOW_UP_CLEARABLE_FIELDS as readonly string[]).includes(key)) cleared.add(key);
          continue;
        }
        changes[key] = value;
      }
      // A new follow-up is 等待中 by definition; nothing else supplies the
      // state fields.
      let merged = (
        stored
          ? { ...stored, ...changes, id: patch.id }
          : { ...changes, id: patch.id, isResolved: false, entries: [] }
      ) as FollowUp;
      for (const key of cleared) {
        const rest: Record<string, unknown> = { ...merged };
        delete rest[key];
        merged = rest as unknown as FollowUp;
      }
      return { ...d, followUps: { ...d.followUps, [patch.id]: merged } };
    });
    logger.info({ action: 'followUp:edit', followUpId: patch.id, title: patch.title });
    return next;
  };

  return {
    /** 字段编辑（标题/备注/条目）；状态推进只能走 resolve/reopen。 */
    edit(patch: FollowUpEdit): AppData {
      return merge(patch);
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
