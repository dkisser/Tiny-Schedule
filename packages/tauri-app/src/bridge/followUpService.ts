import {
  type AppData,
  FOLLOW_UP_CLEARABLE_FIELDS,
  type FollowUp,
  type FollowUpEdit,
  reopenFollowUp,
  resolveFollowUp,
} from '@tiny-schedule/shared';
import { type AiLogger } from '../ai/logger';
import { type DataStore } from './dataStore';

/**
 * Port of packages/app/src/main/services/followUpService.ts.
 *
 * The Electron original's `ServiceDeps` came from taskService; this port states
 * the two collaborators directly, because the Tauri slice has no taskService
 * to import them from and the shape did not change: the same {@link DataStore},
 * with pino's `Logger` replaced by the webview's {@link AiLogger}.
 *
 * Every method here is now `async`, and that is the only mechanical change:
 * Electron's `DataStore.update` was synchronous and its `WriteResult` fell out
 * of one tick, whereas this host's update returns a promise for a `WriteResult`
 * that reports `persisted`. Reading `.data` / `.persisted` off an awaited
 * `store.update(...)` is the whole port — the guards, the allowlist and the
 * envelope shapes are unchanged from the original.
 */

/** What this service needs to do its work: the store, and somewhere to log. */
export interface FollowUpServiceDeps {
  store: DataStore;
  logger: AiLogger;
}

/**
 * Commands additionally report whether the store accepted the write, so the
 * handler can turn a refusal into the same shape as FOLLOW_UP_NOT_FOUND
 * (ADR-0004) — the caller's response is identical either way: nothing happened.
 */
export type FollowUpCommandWrite =
  | { ok: true; data: AppData; persisted: boolean }
  | { ok: false; error: 'FOLLOW_UP_NOT_FOUND' };

/** The only fields a field edit may write. State advances by command only. */
const EDITABLE_FIELDS = ['title', 'notes', 'createdAt', 'entries', 'nextFollowUpDay'] as const;

/**
 * 跟进的写侧唯一入口（ADR-0003）。跟进的状态机足够简单，保持 upsert + 守卫
 * （与 ADR 的决定一致）；resolve/reopen 是命令式的入口，与想法不同不强制切换。
 */

export function createFollowUpService({ store, logger }: FollowUpServiceDeps) {
  const persist = async (followUp: FollowUp): Promise<{ data: AppData; persisted: boolean }> => {
    const { data: next, persisted } = await store.update((d) => ({
      ...d,
      followUps: { ...d.followUps, [followUp.id]: followUp },
    }));
    logger.info({ action: 'followUp:upsert', followUpId: followUp.id, title: followUp.title });
    return { data: next, persisted };
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
  const merge = async (patch: FollowUpEdit): Promise<AppData> => {
    const { data: next } = await store.update((d) => {
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
          : // The `entries: []` default has to lose to `changes.entries`, or
            // it overwrites the entries the caller just sent: creating a
            // follow-up that arrives with a timeline stored an empty one. The
            // fallback is only for a caller that sent none.
            {
              ...changes,
              id: patch.id,
              isResolved: false,
              entries: changes.entries ?? [],
            }
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
    edit(patch: FollowUpEdit): Promise<AppData> {
      return merge(patch);
    },

    async remove(id: string): Promise<AppData> {
      const { data: next } = await store.update((d) => {
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
     *
     * The existence check reads the store's cache, so on a refused store it sees
     * the degraded fallback: a follow-up the user can still see on screen but
     * that is not in the fallback reports NOT_FOUND, which is the same visible
     * outcome (nothing changed) for the same reason (nothing was written).
     */
    async resolve(id: string, now = Date.now()): Promise<FollowUpCommandWrite> {
      const current = (await store.get()).followUps[id];
      if (!current) {
        logger.info({ action: 'followUp:rejected', followUpId: id, error: 'FOLLOW_UP_NOT_FOUND' });
        return { ok: false, error: 'FOLLOW_UP_NOT_FOUND' };
      }
      const { data, persisted } = await persist(resolveFollowUp(current, now));
      return { ok: true, data, persisted };
    },

    /** 恢复跟进：清空了结时刻，回到等待中。 */
    async reopen(id: string): Promise<FollowUpCommandWrite> {
      const current = (await store.get()).followUps[id];
      if (!current) {
        logger.info({ action: 'followUp:rejected', followUpId: id, error: 'FOLLOW_UP_NOT_FOUND' });
        return { ok: false, error: 'FOLLOW_UP_NOT_FOUND' };
      }
      const { data, persisted } = await persist(reopenFollowUp(current));
      return { ok: true, data, persisted };
    },
  };
}

export type FollowUpService = ReturnType<typeof createFollowUpService>;
