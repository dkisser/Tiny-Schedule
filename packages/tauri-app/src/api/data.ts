import {
  type AppData,
  addDays,
  dropStaleTiming,
  type FollowUpEdit,
  type IdeaAddEntryReq,
  type IdeaCloseWithVerdictReq,
  type IdeaConvertToTaskReq,
  type IdeaDeleteEntryReq,
  type IdeaEdit,
  type IdeaIdReq,
  type IdeaUpdateEntryReq,
  type IdeaUpgradeToProjectReq,
  INBOX_PROJECT_ID,
  IpcInvokeContract,
  type IpcInvokeFn,
  type IpcInvokeKey,
  localDate,
  maskDataForRenderer,
  PROJECT_TITLE_MAX_LENGTH,
  type RendererApi,
  type TimingStopReq,
  upsertTaskWithTiming,
} from '@tiny-schedule/shared';
import { consoleLogger } from '@/ai/logger';
import type { DataStore, WriteResult } from '@/bridge/dataStore';
import { createFollowUpService } from '@/bridge/followUpService';
import { createIdeaService } from '@/bridge/ideaService';
import { encryptKey } from '@/bridge/keys';
import { readStoreWritable } from '@/bridge/storeWritableBus';
import { createTaskService } from '@/bridge/taskService';

/**
 * The data slice of the renderer API: the 17 CRUD invokes that the Electron
 * main process implemented over `DataStore`.
 *
 * Each handler is a transcription of its counterpart in
 * packages/app/src/main/ipcHandlers.ts — same order of operations, same
 * partial-merge rules, same `maskDataForRenderer` on the way out. The one
 * structural difference is that validation happens per call site here (see
 * {@link parse}) rather than in a single `ipcMain.handle` loop, because there
 * is no IPC layer to hang it off any more.
 *
 * `randomUUID` comes from WebCrypto rather than node:crypto; the values are
 * only used as opaque ids.
 */
export type DataApi = {
  // `timerSync` is excluded from the mapped half and re-declared below: an
  // intersection would leave both signatures callable, and `tsc` resolves the
  // call to the `void` one.
  [K in Exclude<DataInvokeKey, 'timerSync'>]: IpcInvokeFn<K>;
} & {
  /**
   * `timerSync` is declared `void` by the contract, and to the renderer it
   * still is. Its slice implementation, though, returns the store's
   * {@link WriteResult} so the assembling layer can tell a refused write from
   * a dropped timer — the one distinction the timer channel has to make
   * (ADR-0004). Declared here rather than cast at the call site so the extra
   * information is part of this module's signature instead of an assertion
   * made where it is consumed.
   */
  timerSync: (req?: unknown) => Promise<WriteResult>;
};

/** The contract keys this slice owns; the rest stay stubbed for later waves. */
export type DataInvokeKey = Extract<
  DataInvokeKeyCandidate,
  | 'dataLoad'
  | 'taskUpsert'
  | 'taskDelete'
  | 'followUpUpsert'
  | 'followUpDelete'
  | 'followUpResolve'
  | 'followUpReopen'
  | 'ideaUpsert'
  | 'ideaDelete'
  | 'ideaComplete'
  | 'ideaDiscard'
  | 'ideaReopen'
  | 'ideaConvertToTask'
  | 'ideaUpgradeToProject'
  | 'ideaAddEntry'
  | 'ideaDeleteEntry'
  | 'ideaUpdateEntry'
  | 'ideaCloseWithVerdict'
  | 'orderSet'
  | 'projectCreate'
  | 'projectUpdate'
  | 'projectDelete'
  | 'tagCreate'
  | 'tagUpdate'
  | 'tagDelete'
  | 'settingsUpdate'
  | 'finishDay'
  | 'timerSync'
  | 'timingStop'
  | 'storeWritable'
>;

type DataInvokeKeyCandidate = IpcInvokeKey;

function randomId(): string {
  return crypto.randomUUID();
}

/**
 * Applies the contract's zod schema before the handler runs, matching
 * ipcHandlers.ts: every request was parsed centrally there, and a malformed
 * one threw before reaching the store. Parsing per call keeps that guarantee
 * now that the IPC layer is gone.
 */
function parse<K extends DataInvokeKey>(key: K, raw: unknown): unknown {
  const entry = IpcInvokeContract[key] as { req?: { parse(value: unknown): unknown } };
  return entry.req ? entry.req.parse(raw) : raw;
}

export function createDataApi(store: DataStore): DataApi {
  const masked = (data: AppData): AppData => maskDataForRenderer(data);

  /**
   * The two shapes a write can come back in (ADR-0004).
   *
   * Only the channels whose *return value is control flow* use `written`/
   * `refused`: the ones where the caller decides whether to close a dialog,
   * record something, or stop a clock. The rest return a bare masked dataset,
   * because their result only refreshes the view — and whether the app can save
   * at all is a global state pushed by the store's mode channel, not a fact to
   * carry on every call. See {@link IpcInvokeContract} for which is which.
   *
   * `ok: true` implies it reached the disk, so there is no "succeeded but was
   * dropped" combination for a caller to get wrong. That is the whole point of
   * the discriminated union over the old `persisted` boolean.
   */
  const written = (data: AppData): { ok: true; data: AppData } => ({
    ok: true,
    data: masked(data),
  });
  const refused = { ok: false, error: 'WRITE_REFUSED' } as const;

  /**
   * Map a service result onto the contract envelope, collapsing the write's
   * `persisted` flag into the union so a caller has exactly one thing to check.
   *
   * The services report `persisted` as a separate boolean because they are the
   * layer that knows whether the store accepted the mutation; the contract
   * folds it into `ok` because that is what a caller can act on. Keeping both
   * shapes is deliberate — but only at this boundary. Past it, no caller ever
   * sees a result where `ok` is true and nothing was written.
   *
   * A domain rejection (`IDEA_NOT_REOPENABLE`, `FOLLOW_UP_NOT_FOUND`, …) passes
   * through untouched: the caller's existing `if (!result.ok)` branch already
   * handles it, and it arrives with no dataset because nothing changed.
   */
  const asCommand = async <
    R extends { ok: true; data: AppData; persisted: boolean },
    E extends string,
  >(
    result: Promise<R | { ok: false; error: E }>,
  ): Promise<Omit<R, 'persisted'> | { ok: false; error: E | 'WRITE_REFUSED' }> => {
    const r = await result;
    if (!r.ok) return r;
    if (!r.persisted) return refused;
    const { persisted: _dropped, ...rest } = r;
    return { ...rest, data: masked(rest.data) };
  };

  const ideas = createIdeaService({ store });
  const followUps = createFollowUpService({ store, logger: consoleLogger });
  const tasks = createTaskService({ store });

  const handlers: Record<DataInvokeKey, (raw: unknown) => Promise<unknown>> = {
    dataLoad: async () => masked(await store.get()),

    taskUpsert: async (raw) => {
      const task = parse('taskUpsert', raw) as Parameters<typeof upsertTaskWithTiming>[1];
      // The single enforcement point for "completing a task ends its timing":
      // every write path funnels through here, so no entry point can leave a
      // done task being timed. settledMs goes back to the caller so the
      // renderer reports what was actually recorded instead of predicting it —
      // and only when the write landed, because "settled 90s" is a claim about
      // the disk, not about what the mutation computed.
      let settledMs = 0;
      const result = await store.update((d) => {
        const r = upsertTaskWithTiming(d, task, Date.now());
        settledMs = r.settledMs;
        return r.data;
      });
      if (!result.persisted) return refused;
      return { ...written(result.data), settledMs };
    },

    taskDelete: async (raw) => {
      const { id } = parse('taskDelete', raw) as { id: string };
      const result = await store.update((d) => {
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
      return masked(result.data);
    },

    /**
     * A field *edit*, not a replace — see {@link FollowUpEditSchema}.
     *
     * Delegated to the service rather than merged here. An inline merge got
     * this wrong in two ways at once: it seeded a brand-new record from
     * `blankFollowUp(edit.title)`, whose freshly minted id was then filed
     * under `edit.id`, so the stored record's `id` disagreed with the key it
     * lived at — and every later command addresses the record by that id, so
     * resolving a just-created follow-up reported NOT_FOUND. The service also
     * keeps the EDITABLE_FIELDS allowlist as the enforcement point rather
     * than relying on the wire schema to strip the state fields.
     */
    followUpUpsert: async (raw) => {
      const edit = parse('followUpUpsert', raw) as FollowUpEdit;
      return masked(await followUps.edit(edit));
    },

    followUpDelete: async (raw) => {
      const { id } = parse('followUpDelete', raw) as { id: string };
      const result = await store.update((d) => {
        const followUps = { ...d.followUps };
        delete followUps[id];
        return { ...d, followUps };
      });
      return masked(result.data);
    },

    /**
     * A field *edit*, not a replace — see {@link IdeaEditSchema}.
     *
     * Delegated to the service, for the same reason as followUpUpsert: the
     * inline merge seeded new records from `blankIdea(edit.title)`, whose fresh
     * id was filed under `edit.id`, so completing or discarding an idea the
     * user had just created reported IDEA_NOT_FOUND. Every transition field is
     * absent from the request by design, so a debounced commit cannot roll the
     * idea back; those move only through the intent commands.
     */
    ideaUpsert: async (raw) => {
      const edit = parse('ideaUpsert', raw) as IdeaEdit;
      return masked(await ideas.edit(edit));
    },

    ideaDelete: async (raw) => {
      const { id } = parse('ideaDelete', raw) as { id: string };
      const result = await store.update((d) => {
        const ideas = { ...d.ideas };
        delete ideas[id];
        return { ...d, ideas };
      });
      return masked(result.data);
    },

    /**
     * The idea command set — nine intent commands, each of which is the only
     * way that transition can happen (ADR-0003). The service owns the status
     * guards; these handlers only adapt the wire shape.
     */
    ideaComplete: async (raw) => {
      const { id } = parse('ideaComplete', raw) as IdeaIdReq;
      return asCommand(ideas.complete(id));
    },

    ideaDiscard: async (raw) => {
      const { id } = parse('ideaDiscard', raw) as IdeaIdReq;
      return asCommand(ideas.discard(id));
    },

    ideaReopen: async (raw) => {
      const { id } = parse('ideaReopen', raw) as IdeaIdReq;
      return asCommand(ideas.reopen(id));
    },

    ideaConvertToTask: async (raw) => {
      const { id, title } = parse('ideaConvertToTask', raw) as IdeaConvertToTaskReq;
      const result = await ideas.convertToTask(id, title);
      if (!result.ok) return result;
      if (!result.persisted) return refused;
      const { persisted: _dropped, ...rest } = result;
      // The task id rides back so the renderer can highlight or navigate to it
      // rather than searching the list for whatever is new.
      return { ...rest, data: masked(rest.data), taskId: rest.taskId };
    },

    ideaUpgradeToProject: async (raw) => {
      const req = parse('ideaUpgradeToProject', raw) as IdeaUpgradeToProjectReq;
      const result = await ideas.upgradeToProject(req.id, {
        title: req.title,
        ...(req.validationGoal !== undefined ? { validationGoal: req.validationGoal } : {}),
      });
      if (!result.ok) return result;
      if (!result.persisted) return refused;
      const { persisted: _dropped, ...rest } = result;
      return { ...rest, data: masked(rest.data), projectId: rest.projectId };
    },

    ideaAddEntry: async (raw) => {
      const { id, text } = parse('ideaAddEntry', raw) as IdeaAddEntryReq;
      return asCommand(ideas.addEntry(id, text));
    },

    ideaUpdateEntry: async (raw) => {
      const { id, entryId, text } = parse('ideaUpdateEntry', raw) as IdeaUpdateEntryReq;
      return asCommand(ideas.updateEntry(id, entryId, text));
    },

    ideaDeleteEntry: async (raw) => {
      const { id, entryId } = parse('ideaDeleteEntry', raw) as IdeaDeleteEntryReq;
      return asCommand(ideas.deleteEntry(id, entryId));
    },

    ideaCloseWithVerdict: async (raw) => {
      const req = parse('ideaCloseWithVerdict', raw) as IdeaCloseWithVerdictReq;
      return asCommand(ideas.closeWithVerdict(req.id, req.result, req.text));
    },

    /**
     * Resolve / reopen are commands rather than field edits: they move the
     * state machine, so they cannot be expressed by writing `isResolved` back.
     */
    followUpResolve: async (raw) => {
      const { id } = parse('followUpResolve', raw) as { id: string };
      return asCommand(followUps.resolve(id));
    },

    followUpReopen: async (raw) => {
      const { id } = parse('followUpReopen', raw) as { id: string };
      return asCommand(followUps.reopen(id));
    },

    /**
     * Stop timing, and settle the session it was running.
     *
     * The three branches are not interchangeable, which is why this returns
     * the service's envelope rather than flattening it: WRITE_REFUSED means
     * nothing happened and the caller must keep its clock, while a domain
     * rejection means the host DID drop the timer and persisted that — so the
     * dataset has to come back for the renderer to converge on.
     */
    timingStop: async (raw) => {
      const { taskId } = parse('timingStop', raw) as TimingStopReq;
      const result = await tasks.stopTiming(Date.now(), taskId);
      if (result.ok) return { ...written(result.data), settledMs: result.settledMs };
      // WRITE_REFUSED carries no dataset — there is nothing new to converge on.
      if (result.error === 'WRITE_REFUSED') return result;
      return { ...result, data: masked(result.data) };
    },

    /**
     * The read-only mode as a pull (ADR-0004).
     *
     * Push-only was not enough: the latch is set during startup, before the
     * renderer exists, so a store that has been unwritable since launch would
     * otherwise look writable to a window that mounts afterwards.
     */
    storeWritable: async () => readStoreWritable(store),

    orderSet: async (raw) => {
      const { viewKey, ids } = parse('orderSet', raw) as { viewKey: string; ids: string[] };
      await store.update((d) => {
        const taskOrder = (d.misc.taskOrder ?? {}) as Record<string, string[]>;
        return { ...d, misc: { ...d.misc, taskOrder: { ...taskOrder, [viewKey]: ids } } };
      });
    },

    projectCreate: async (raw) => {
      const req = parse('projectCreate', raw) as {
        title: string;
        icon?: string;
        primaryColor?: string;
      };
      const title = req.title.slice(0, PROJECT_TITLE_MAX_LENGTH);
      // The id is minted inside the mutation and returned alongside the
      // dataset. The renderer used to recover it by diffing the whole project
      // list, which picks the wrong project if two creations interleave.
      let projectId = '';
      const result = await store.update((d) => {
        const id = `p_${randomId()}`;
        projectId = id;
        return {
          ...d,
          projects: {
            ...d.projects,
            [id]: {
              id,
              title,
              icon: req.icon,
              isArchived: false,
              primaryColor: req.primaryColor,
            },
          },
        };
      });
      if (!result.persisted) return refused;
      return { ...written(result.data), projectId };
    },

    projectUpdate: async (raw) => {
      const req = parse('projectUpdate', raw) as {
        id: string;
        title?: string;
        primaryColor?: string;
        isArchived?: boolean;
      };
      const result = await store.update((d) => {
        const prev = d.projects[req.id];
        // Inbox is a system project: never accept updates through the API.
        if (!prev || req.id === INBOX_PROJECT_ID) return d;
        // Partial-merge: only apply fields that are explicitly present in the
        // request. `null` clears (e.g. clearing a project color); `undefined`
        // leaves the existing value untouched.
        const patch: Partial<typeof prev> = {};
        if (req.title !== undefined) patch.title = req.title.slice(0, PROJECT_TITLE_MAX_LENGTH);
        if (req.primaryColor !== undefined) patch.primaryColor = req.primaryColor;
        if (req.isArchived !== undefined) patch.isArchived = req.isArchived;
        if (Object.keys(patch).length === 0) return d;
        return { ...d, projects: { ...d.projects, [req.id]: { ...prev, ...patch } } };
      });
      return masked(result.data);
    },

    projectDelete: async (raw) => {
      const { id } = parse('projectDelete', raw) as { id: string };
      if (id === INBOX_PROJECT_ID) return masked(await store.get());
      const result = await store.update((d) => {
        if (!d.projects[id]) return d;
        const projects = { ...d.projects };
        delete projects[id];
        // Tasks keep their projectTitle snapshot; only the grouping moves to Inbox.
        const tasks = { ...d.tasks };
        for (const t of Object.values(tasks)) {
          if (t.projectId === id) tasks[t.id] = { ...t, projectId: INBOX_PROJECT_ID };
        }
        return { ...d, projects, tasks };
      });
      return masked(result.data);
    },

    tagCreate: async (raw) => {
      const req = parse('tagCreate', raw) as { title: string; color?: string };
      const result = await store.update((d) => {
        const id = `tag_${randomId()}`;
        return { ...d, tags: { ...d.tags, [id]: { id, title: req.title, color: req.color } } };
      });
      return result.persisted ? written(result.data) : refused;
    },

    tagUpdate: async (raw) => {
      const req = parse('tagUpdate', raw) as { id: string; title?: string; color?: string };
      const result = await store.update((d) => {
        const prev = d.tags[req.id];
        if (!prev) return d;
        const updated = {
          ...prev,
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.color !== undefined ? { color: req.color } : {}),
        };
        return { ...d, tags: { ...d.tags, [req.id]: updated } };
      });
      return masked(result.data);
    },

    tagDelete: async (raw) => {
      const { id } = parse('tagDelete', raw) as { id: string };
      const result = await store.update((d) => {
        if (!d.tags[id]) return d;
        const tags = { ...d.tags };
        delete tags[id];
        // Tasks keep tagIds + snapshot labels so their chips stay visible.
        return { ...d, tags };
      });
      return masked(result.data);
    },

    settingsUpdate: async (raw) => {
      // Derived from the contract entry itself — the same type the preload
      // signature uses — so the partial-merge below cannot drift from the
      // contract the renderer is typed against.
      const patch = parse('settingsUpdate', raw) as Parameters<
        NonNullable<RendererApi['settingsUpdate']>
      >[0];
      const result = await store.update(async (d) => {
        const settings = { ...d.settings };
        if (patch.userName !== undefined) settings.userName = patch.userName;
        if (patch.avatar !== undefined) settings.avatar = patch.avatar;
        if (patch.theme !== undefined) settings.theme = patch.theme;
        if (patch.aiPrompt !== undefined) settings.aiPrompt = patch.aiPrompt;
        if (patch.autoAiAnalyzeOnFinishDay !== undefined) {
          settings.autoAiAnalyzeOnFinishDay = patch.autoAiAnalyzeOnFinishDay;
        }
        if (patch.idlePauseEnabled !== undefined)
          settings.idlePauseEnabled = patch.idlePauseEnabled;
        if (patch.idlePauseMinutes !== undefined)
          settings.idlePauseMinutes = patch.idlePauseMinutes;
        if (patch.aiProviders !== undefined) {
          // encryptKey is async (WebCrypto), so the providers are mapped in an
          // async pass rather than the original's inline map. Same result: a
          // provider whose key was left as '<unchanged>' keeps the ciphertext
          // already on disk instead of being re-encrypted.
          const providers = [];
          for (const p of patch.aiProviders) {
            const prev = d.settings.aiProviders.find((x) => x.id === p.id);
            providers.push({
              id: p.id,
              registryId: p.registryId,
              baseUrl: p.baseUrl,
              apiKeyEncrypted:
                p.apiKey === '<unchanged>' && prev
                  ? prev.apiKeyEncrypted
                  : await encryptKey(p.apiKey),
              model: p.model,
              isDefault: p.isDefault,
            });
          }
          settings.aiProviders = providers as typeof settings.aiProviders;
        }
        return { ...d, settings };
      });
      return masked(result.data);
    },

    finishDay: async (raw) => {
      // The payload date is validated but not used: finishing always applies to
      // the local "today".
      parse('finishDay', raw);
      const today = localDate(Date.now());
      const tomorrow = addDays(today, 1);
      const result = await store.update((d) => {
        const tasks = { ...d.tasks };
        for (const t of Object.values(tasks)) {
          // Roll unfinished tasks due today to tomorrow so they remain visible
          // in the dueDay-driven Today view instead of silently disappearing.
          if (!t.isDone && t.dueDay === today) {
            tasks[t.id] = { ...t, dueDay: tomorrow };
          }
        }
        return { ...d, tasks, misc: { ...d.misc, lastFinishDay: today } };
      });
      return masked(result.data);
    },

    /**
     * Returns the store's {@link WriteResult} rather than nothing.
     *
     * The contract says `void`, and it stays `void` as far as callers are
     * concerned — the wrapper in `api.ts` discards it. But this handler is the
     * only place that knows whether the write landed, and the announcement on
     * the timer channel depends on that distinction: a refused sync must not be
     * read as a drop, or the renderer stops a clock the host never stopped.
     */
    timerSync: async (raw) => {
      const { timer } = parse('timerSync', raw) as {
        timer: Parameters<typeof dropStaleTiming>[0]['activeTimer'];
      };
      if (!timer) {
        return store.update((d) => ({ ...d, activeTimer: null }));
      }
      // Same invariant as taskUpsert: a timer may never be persisted for a task
      // that is already done, whoever is asking to sync it.
      return store.update((d) => dropStaleTiming({ ...d, activeTimer: timer }));
    },
  };

  // Wrap once so every call site validates exactly like the ipcMain loop did.
  const api = {} as Record<DataInvokeKey, (raw?: unknown) => Promise<unknown>>;
  for (const key of Object.keys(handlers) as DataInvokeKey[]) {
    const handler = handlers[key];
    api[key] = (raw?: unknown) => handler(raw);
  }
  return api as unknown as DataApi;
}
