import type { AppData, AppSettings, FollowUp, Idea, Project, Task } from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';

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
  upsertIdea: (idea: Idea) => Promise<void>;
  /** Run an idea intent command and adopt its dataset. See the implementation. */
  runIdeaCommand: <R extends { ok: true; data: AppData }>(
    run: () => Promise<R | { ok: false; error: string }>,
  ) => Promise<R | { ok: false; error: string }>;
  runFollowUpCommand: <R extends { ok: true; data: AppData }>(
    run: () => Promise<R | { ok: false; error: string }>,
  ) => Promise<R | { ok: false; error: string }>;
  deleteIdea: (id: string) => Promise<void>;
  setTaskOrder: (viewKey: string, ids: string[]) => void;
  /**
   * The id of the project that was created, or null when the write was refused.
   *
   * The id comes back with the dataset rather than being recovered by diffing
   * the project list: two creations that interleave leave one diff picking the
   * wrong project, and a null here means "nothing was created" — never an id
   * for a project the store threw away.
   */
  createProject: (title: string) => Promise<string | null>;
  updateProject: (
    id: string,
    patch: { title?: string; primaryColor?: string | null; isArchived?: boolean },
  ) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  /** False when the write was refused, so the caller can keep what the user typed. */
  createTag: (title: string) => Promise<boolean>;
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
    // The host enforces "completing a task ends its timing" on write and reports
    // what it actually recorded, so this response is the authority on both the
    // dataset and the timer.
    //
    // A refusal throws rather than resolving with the degraded dataset: the
    // caller here is a dialog deciding whether to close itself and what to tell
    // the user, and a resolved promise would read as "saved" — reporting a
    // settlement that never reached the disk. The store-mode banner explains
    // why the save could not land.
    const result = await api().taskUpsert(task);
    if (!result.ok) throw new Error(`task:upsert refused: ${result.error}`);
    set({ data: result.data });
    return { data: result.data, settledMs: result.settledMs };
  },
  deleteTask: async (id) => {
    const data = await api().taskDelete({ id });
    set({ data });
  },
  upsertFollowUp: async (followUp) => {
    // Also a field edit: isResolved/resolvedAt advance only through
    // followUpResolve/followUpReopen, so passing a full snapshot through would
    // let a stale one undo a resolve. nextFollowUpDay keeps null-vs-undefined
    // meaning clear (null clears the date input) on the way in.
    const data = await api().followUpUpsert({
      id: followUp.id,
      title: followUp.title,
      notes: followUp.notes,
      createdAt: followUp.createdAt,
      entries: followUp.entries,
      nextFollowUpDay: followUp.nextFollowUpDay ?? null,
    });
    set({ data });
  },
  deleteFollowUp: async (id) => {
    const data = await api().followUpDelete({ id });
    set({ data });
  },
  upsertIdea: async (idea) => {
    // `ideaUpsert` is a field *edit*, not a replace (ADR-0003): `status` and
    // every transition field are absent from the request by design, so a
    // snapshot written back here can never advance or undo the idea's state.
    // Transitions go through the intent commands below instead.
    const data = await api().ideaUpsert({
      id: idea.id,
      title: idea.title,
      notes: idea.notes,
      createdAt: idea.createdAt,
      validationGoal: idea.validationGoal,
    });
    set({ data });
  },

  /**
   * Run an intent command, adopt the dataset it returns, and pass its verdict
   * back to the caller.
   *
   * The caller has to branch on the verdict — a refused command leaves the UI
   * where it was, which is the point (ADR-0004). Returning the whole result
   * rather than just the data keeps that decision with the component that has
   * the context to make it: a rejected convert should not navigate, a rejected
   * entry should keep the text the user typed.
   */
  runIdeaCommand: async (run) => {
    const result = await run();
    if (!result.ok) return result as { ok: false; error: string };
    set({ data: result.data });
    return result;
  },

  runFollowUpCommand: async (run) => {
    const result = await run();
    if (!result.ok) return result as { ok: false; error: string };
    set({ data: result.data });
    return result;
  },
  deleteIdea: async (id) => {
    const data = await api().ideaDelete({ id });
    set({ data });
  },
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
    const result = await api().projectCreate({ title });
    if (!result.ok) return null;
    set({ data: result.data });
    return result.projectId;
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
    const result = await api().tagCreate({ title });
    // False, not a silent resolve: the sidebar keeps whatever the user typed
    // when the tag did not take, so a refused write cannot look like a rename
    // that landed.
    if (!result.ok) return false;
    set({ data: result.data });
    return true;
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
