import type {
  AppData,
  AppSettings,
  FollowUp,
  Idea,
  IdeaVerdict,
  Project,
  Task,
} from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';

/**
 * Outcome of an idea intent command: a domain rejection is a normal answer,
 * not an exception, so it travels back to the UI as data (ADR-0003).
 */
export interface IdeaCommandOutcome {
  ok: boolean;
  /** Present only on rejection: the stable code the main process decided on. */
  error?: string;
}

const ACCEPTED: IdeaCommandOutcome = { ok: true };

/** Domain rejections come back as data, not as exceptions (ADR-0003). */
export interface FollowUpCommandOutcome {
  ok: boolean;
  error?: string;
}

/**
 * An idea edit, with the one distinction the wire contract draws: an absent
 * validationGoal leaves it alone, an explicit null clears it.
 */
export type IdeaPatch = Omit<Idea, 'validationGoal' | 'timeline'> & {
  validationGoal?: string | null;
};

/**
 * Run an intent command (idea or follow-up) and adopt its dataset. The main process is the
 * only place that decides whether a transition is legal, so the verdict is
 * forwarded rather than second-guessed here.
 *
 * A *thrown* error is a different matter: the contract says system errors keep
 * throwing (e.g. a missing Inbox project, or a zod rejection at the
 * registration loop). Callers fire these off with `void`, so an uncaught
 * rejection is silent in a packaged app — no toast, the dialog stays open, and
 * the user concludes the click did nothing. Surfacing it as a rejection keeps
 * every caller's existing `if (!outcome.ok) toast.error(...)` path honest.
 */
async function adoptCommand(
  promise: Promise<{ ok: true; data: AppData } | { ok: false; error: string }>,
): Promise<IdeaCommandOutcome> {
  let result: { ok: true; data: AppData } | { ok: false; error: string };
  try {
    result = await promise;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'COMMAND_FAILED' };
  }
  if (!result.ok) return { ok: false, error: result.error };
  useDataStore.setState({ data: result.data });
  return ACCEPTED;
}

// Renderer-side provider draft carries plain-text apiKey for editing
export interface ProviderDraft {
  id: string;
  registryId: string;
  apiKey: string;
  hasKey?: boolean;
  baseUrl?: string;
  model: string;
  isDefault: boolean;
}

interface DataState {
  data: AppData | null;
  loading: boolean;
  load: () => Promise<void>;
  upsertTask: (task: Task) => Promise<{ data: AppData; settledMs: number }>;
  deleteTask: (id: string) => Promise<void>;
  upsertFollowUp: (followUp: FollowUp) => Promise<void>;
  deleteFollowUp: (id: string) => Promise<void>;
  /** 字段编辑（标题/备注/验证目标）；状态与演进日志只能走意图命令。 */
  upsertIdea: (idea: IdeaPatch) => Promise<void>;
  addIdeaEntry: (id: string, text: string) => Promise<IdeaCommandOutcome>;
  deleteIdeaEntry: (id: string, entryId: string) => Promise<IdeaCommandOutcome>;
  updateIdeaEntry: (id: string, entryId: string, text: string) => Promise<IdeaCommandOutcome>;
  deleteIdea: (id: string) => Promise<void>;
  /**
   * 想法的写路径是意图命令而非 upsert（ADR-0003）：终态规则由主进程强制，
   * 领域拒绝以 { ok:false, error } 返回，调用方据此提示而不必自己判断合法性。
   */
  completeIdea: (id: string) => Promise<IdeaCommandOutcome>;
  discardIdea: (id: string) => Promise<IdeaCommandOutcome>;
  reopenIdea: (id: string) => Promise<IdeaCommandOutcome>;
  convertIdeaToTask: (id: string, title?: string) => Promise<IdeaCommandOutcome>;
  upgradeIdeaToProject: (req: {
    id: string;
    title: string;
    icon?: string;
    primaryColor?: string;
    validationGoal?: string;
  }) => Promise<IdeaCommandOutcome>;
  closeIdeaWithVerdict: (
    id: string,
    result: IdeaVerdict['result'],
    text?: string,
  ) => Promise<IdeaCommandOutcome>;
  resolveFollowUp: (id: string) => Promise<FollowUpCommandOutcome>;
  reopenFollowUp: (id: string) => Promise<FollowUpCommandOutcome>;
  setTaskOrder: (viewKey: string, ids: string[]) => void;
  // Returns the newly created project (callers like 想法升级为项目 need its id).
  createProject: (title: string) => Promise<Project | null>;
  updateProject: (
    id: string,
    patch: { title?: string; primaryColor?: string | null; isArchived?: boolean },
  ) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createTag: (title: string) => Promise<void>;
  updateTag: (id: string, title: string) => Promise<void>;
  deleteTag: (id: string) => Promise<void>;
  updateSettings: (
    patch: Omit<Partial<AppSettings>, 'aiProviders'> & { aiProviders?: ProviderDraft[] },
  ) => Promise<void>;
}

export const useDataStore = create<DataState>((set, get) => ({
  data: null,
  loading: false,
  load: async () => {
    set({ loading: true });
    const data = await api().dataLoad();
    set({ data, loading: false });
  },
  upsertTask: async (task) => {
    // The main process enforces "completing a task ends its timing" on write and
    // reports what it actually recorded, so this response is the authority on
    // both the dataset and the timer.
    const { data, settledMs } = await api().taskUpsert(task);
    set({ data });
    return { data, settledMs };
  },
  deleteTask: async (id) => {
    const data = await api().taskDelete({ id });
    set({ data });
  },
  upsertFollowUp: async (followUp) => {
    const data = await api().followUpUpsert(followUp);
    set({ data });
  },
  deleteFollowUp: async (id) => {
    const data = await api().followUpDelete({ id });
    set({ data });
  },
  upsertIdea: async (idea) => {
    // The write contract carries non-status fields only (ADR-0003), so a caller
    // holding a full Idea cannot smuggle a status change through this path.
    // The timeline is deliberately NOT sent: this path is for scalar fields the
    // user just typed, and the caller's snapshot of a list is as stale as its
    // snapshot of anything else — a debounced title commit landing after an
    // entry was added would roll the timeline back. It has its own commands.
    const data = await api().ideaUpsert({
      id: idea.id,
      title: idea.title,
      notes: idea.notes,
      createdAt: idea.createdAt,
      // Omitted when undefined: the main process treats an absent key as "leave
      // this alone". Only an explicit null clears the field.
      ...(idea.validationGoal !== undefined ? { validationGoal: idea.validationGoal } : {}),
    });
    set({ data });
  },
  addIdeaEntry: (id, text) => adoptCommand(api().ideaAddEntry({ id, text })),
  deleteIdeaEntry: (id, entryId) => adoptCommand(api().ideaDeleteEntry({ id, entryId })),
  updateIdeaEntry: (id, entryId, text) =>
    adoptCommand(api().ideaUpdateEntry({ id, entryId, text })),
  deleteIdea: async (id) => {
    const data = await api().ideaDelete({ id });
    set({ data });
  },
  completeIdea: (id) => adoptCommand(api().ideaComplete({ id })),
  discardIdea: (id) => adoptCommand(api().ideaDiscard({ id })),
  reopenIdea: (id) => adoptCommand(api().ideaReopen({ id })),
  convertIdeaToTask: (id, title) =>
    adoptCommand(api().ideaConvertToTask({ id, ...(title ? { title } : {}) })),
  upgradeIdeaToProject: (req) => adoptCommand(api().ideaUpgradeToProject(req)),
  closeIdeaWithVerdict: (id, result, text) =>
    adoptCommand(api().ideaCloseWithVerdict({ id, result, ...(text ? { text } : {}) })),
  // Same shape as the idea commands: the main process applies the transition
  // and returns the dataset, and a rejection comes back as data so the caller
  // can toast it instead of firing a void-ed promise into the void.
  resolveFollowUp: (id) => adoptCommand(api().followUpResolve({ id })),
  reopenFollowUp: (id) => adoptCommand(api().followUpReopen({ id })),
  setTaskOrder: (viewKey, ids) => {
    // Optimistic: apply locally first so dragging stays fluid, then persist.
    set((s) => {
      if (!s.data) return s;
      const taskOrder = (s.data.misc.taskOrder ?? {}) as Record<string, string[]>;
      return {
        data: { ...s.data, misc: { ...s.data.misc, taskOrder: { ...taskOrder, [viewKey]: ids } } },
      };
    });
    void api().orderSet({ viewKey, ids });
  },
  createProject: async (title) => {
    const prevIds = new Set(Object.keys(get().data?.projects ?? {}));
    const data = await api().projectCreate({ title });
    set({ data });
    return Object.values(data.projects).find((p) => !prevIds.has(p.id)) ?? null;
  },
  updateProject: async (id, patch) => {
    const data = await api().projectUpdate({ id, ...patch });
    set({ data });
  },
  deleteProject: async (id) => {
    const data = await api().projectDelete({ id });
    set({ data });
  },
  createTag: async (title) => {
    const data = await api().tagCreate({ title });
    set({ data });
  },
  updateTag: async (id, title) => {
    const data = await api().tagUpdate({ id, title });
    set({ data });
  },
  deleteTag: async (id) => {
    const data = await api().tagDelete({ id });
    set({ data });
  },
  updateSettings: async (patch) => {
    const data = await api().settingsUpdate(patch);
    set({ data });
  },
}));
