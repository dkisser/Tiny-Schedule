import {
  type AppData,
  addDays,
  dropStaleTiming,
  INBOX_PROJECT_ID,
  IpcInvokeContract,
  type IpcInvokeFn,
  type IpcInvokeKey,
  localDate,
  maskDataForRenderer,
  PROJECT_TITLE_MAX_LENGTH,
  type RendererApi,
  upsertTaskWithTiming,
} from '@tiny-schedule/shared';
import type { DataStore } from '@/bridge/dataStore';
import { encryptKey } from '@/bridge/keys';

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
  [K in DataInvokeKey]: IpcInvokeFn<K>;
};

/** The contract keys this slice owns; the rest stay stubbed for later waves. */
export type DataInvokeKey = Extract<
  DataInvokeKeyCandidate,
  | 'dataLoad'
  | 'taskUpsert'
  | 'taskDelete'
  | 'followUpUpsert'
  | 'followUpDelete'
  | 'ideaUpsert'
  | 'ideaDelete'
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

  const handlers: Record<DataInvokeKey, (raw: unknown) => Promise<unknown>> = {
    dataLoad: async () => masked(await store.get()),

    taskUpsert: async (raw) => {
      const task = parse('taskUpsert', raw) as Parameters<typeof upsertTaskWithTiming>[1];
      // The single enforcement point for "completing a task ends its timing":
      // every write path funnels through here, so no entry point can leave a
      // done task being timed. settledMs goes back to the caller so the
      // renderer reports what was actually recorded instead of predicting it.
      let settledMs = 0;
      const next = await store.update((d) => {
        const r = upsertTaskWithTiming(d, task, Date.now());
        settledMs = r.settledMs;
        return r.data;
      });
      return { data: masked(next), settledMs };
    },

    taskDelete: async (raw) => {
      const { id } = parse('taskDelete', raw) as { id: string };
      const next = await store.update((d) => {
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
      return masked(next);
    },

    followUpUpsert: async (raw) => {
      const followUp = parse('followUpUpsert', raw) as AppData['followUps'][string];
      const next = await store.update((d) => ({
        ...d,
        followUps: { ...d.followUps, [followUp.id]: followUp },
      }));
      return masked(next);
    },

    followUpDelete: async (raw) => {
      const { id } = parse('followUpDelete', raw) as { id: string };
      const next = await store.update((d) => {
        const followUps = { ...d.followUps };
        delete followUps[id];
        return { ...d, followUps };
      });
      return masked(next);
    },

    ideaUpsert: async (raw) => {
      const idea = parse('ideaUpsert', raw) as AppData['ideas'][string];
      const next = await store.update((d) => ({
        ...d,
        ideas: { ...d.ideas, [idea.id]: idea },
      }));
      return masked(next);
    },

    ideaDelete: async (raw) => {
      const { id } = parse('ideaDelete', raw) as { id: string };
      const next = await store.update((d) => {
        const ideas = { ...d.ideas };
        delete ideas[id];
        return { ...d, ideas };
      });
      return masked(next);
    },

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
      const next = await store.update((d) => {
        const id = `p_${randomId()}`;
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
      return masked(next);
    },

    projectUpdate: async (raw) => {
      const req = parse('projectUpdate', raw) as {
        id: string;
        title?: string;
        primaryColor?: string;
        isArchived?: boolean;
      };
      const next = await store.update((d) => {
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
      return masked(next);
    },

    projectDelete: async (raw) => {
      const { id } = parse('projectDelete', raw) as { id: string };
      if (id === INBOX_PROJECT_ID) return masked(await store.get());
      const next = await store.update((d) => {
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
      return masked(next);
    },

    tagCreate: async (raw) => {
      const req = parse('tagCreate', raw) as { title: string; color?: string };
      const next = await store.update((d) => {
        const id = `tag_${randomId()}`;
        return { ...d, tags: { ...d.tags, [id]: { id, title: req.title, color: req.color } } };
      });
      return masked(next);
    },

    tagUpdate: async (raw) => {
      const req = parse('tagUpdate', raw) as { id: string; title?: string; color?: string };
      const next = await store.update((d) => {
        const prev = d.tags[req.id];
        if (!prev) return d;
        const updated = {
          ...prev,
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.color !== undefined ? { color: req.color } : {}),
        };
        return { ...d, tags: { ...d.tags, [req.id]: updated } };
      });
      return masked(next);
    },

    tagDelete: async (raw) => {
      const { id } = parse('tagDelete', raw) as { id: string };
      const next = await store.update((d) => {
        if (!d.tags[id]) return d;
        const tags = { ...d.tags };
        delete tags[id];
        // Tasks keep tagIds + snapshot labels so their chips stay visible.
        return { ...d, tags };
      });
      return masked(next);
    },

    settingsUpdate: async (raw) => {
      // Derived from the contract entry itself — the same type the preload
      // signature uses — so the partial-merge below cannot drift from the
      // contract the renderer is typed against.
      const patch = parse('settingsUpdate', raw) as Parameters<
        NonNullable<RendererApi['settingsUpdate']>
      >[0];
      const next = await store.update(async (d) => {
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
      return masked(next);
    },

    finishDay: async (raw) => {
      // The payload date is validated but not used: finishing always applies to
      // the local "today".
      parse('finishDay', raw);
      const today = localDate(Date.now());
      const tomorrow = addDays(today, 1);
      const next = await store.update((d) => {
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
      return masked(next);
    },

    timerSync: async (raw) => {
      const { timer } = parse('timerSync', raw) as {
        timer: Parameters<typeof dropStaleTiming>[0]['activeTimer'];
      };
      if (!timer) {
        await store.update((d) => ({ ...d, activeTimer: null }));
        return;
      }
      // Same invariant as taskUpsert: a timer may never be persisted for a task
      // that is already done, whoever is asking to sync it.
      const next = await store.update((d) => dropStaleTiming({ ...d, activeTimer: timer }));
      if (!next.activeTimer) {
        // The drop is announced by the caller layer (see api.ts), which owns
        // the event channel; here we only persist the corrected state.
        return;
      }
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
