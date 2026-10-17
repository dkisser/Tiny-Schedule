import {
  type AppData,
  type AppSettings,
  blankFollowUp,
  blankIdea,
  blankScheduledTask,
  type FollowUp,
  type Idea,
  type Project,
  type Schedule,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskRunNowResult,
  type Task,
} from '@tiny-schedule/shared';
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
  /**
   * Create a fresh idea, reporting whether it actually landed.
   *
   * `ideaUpsert` is not a control-flow channel, so it hands back a bare
   * dataset and the caller is meant to learn about a refused store from the
   * mode banner rather than from a return value. That is the right default for
   * a field edit, where the input keeps its own state and nothing is lost. It
   * is wrong for *creating* something: the draft is cleared on the way out, so
   * a refusal silently discards what the user typed.
   *
   * Presence is the signal, and it is the honest one — a refused write returns
   * the degraded dataset the store already held, which cannot contain a record
   * that was never written.
   */
  createIdea: (title: string) => Promise<boolean>;
  createFollowUp: (title: string) => Promise<boolean>;
  /** Run an idea intent command and adopt its dataset. See the implementation. */
  runIdeaCommand: <R extends { ok: true; data: AppData }>(
    run: () => Promise<R | { ok: false; error: string }>,
  ) => Promise<R | { ok: false; error: string }>;
  runFollowUpCommand: <R extends { ok: true; data: AppData }>(
    run: () => Promise<R | { ok: false; error: string }>,
  ) => Promise<R | { ok: false; error: string }>;
  deleteIdea: (id: string) => Promise<void>;
  /**
   * 定时任务的字段编辑（对应契约里的 scheduledTaskUpsert）。
   *
   * 签名是 `(task, patch)` 而不是 `(req)`，因为契约的请求体要求 name / prompt /
   * schedule 全部在场（服务层再按"缺省即不动"做合并）。所以界面永远从自己手里的
   * 那条定时任务出发、改哪几个字段就只交哪几个——把这份"其余字段取自当前记录"的
   * 知识收在一个地方，而不是让每个输入框各自记得补齐另外两项。
   *
   * `workingDirectory: null` 表示清空（回到应用默认目录），与"不动"在契约里是两个
   * 意思，所以这个字段在 patch 上单独放宽成 `string | null`。
   *
   * 返回是否真的写进去了：字段编辑的调用方不需要这个信号（输入自己留着状态，什么都
   * 没丢），但**新建**需要——草稿是在关闭对话框时清掉的，一次被存储层拒绝的写入如果
   * 也把对话框关掉，用户输入的东西就没有了。判据是 presence：被拒绝时返回的是存储层
   * 手里那份降级数据集，里面不可能有一条从未写进去的记录。
   */
  /**
   * 新建一条定时任务，返回它的 id，或被存储层拒绝时返回 null。
   *
   * 与 `saveScheduledTask` 分开是因为新建还没有那条记录可依据：字段得由调用方一次给
   * 全（名称、prompt、频率），而启用状态不在这份草稿里——新任务是启用状态，这是它的
   * 定义而不是一个默认值（见 `blankScheduledTask`）。
   *
   * id 随结果一起返回，而不是让调用方去 diff 定时任务列表找新出现的那条。
   */
  createScheduledTask: (draft: {
    name: string;
    prompt: string;
    schedule: Schedule;
  }) => Promise<string | null>;
  saveScheduledTask: (
    task: ScheduledTask,
    patch: Partial<Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'workingDirectory'>> & {
      workingDirectory?: string | null;
    },
  ) => Promise<boolean>;
  /** 删除连同它的全部运行（见契约注释），所以这里没有第二个"只删任务"的口子。 */
  deleteScheduledTask: (id: string) => Promise<void>;
  /**
   * 按任务查运行，最新在前。
   *
   * 运行记录不进 AppData——它只会一直增长，塞进数据集等于让每个界面都背着整个历史。
   * 所以它是唯一需要调用方自己持有的查询结果。
   */
  listScheduledTaskRuns: (scheduledTaskId: string) => Promise<ScheduledTaskRun[]>;
  /**
   * 「立即运行」：手动触发一次，产物与定时触发完全同构（CONTEXT.md）。
   *
   * 不返回数据集：一次运行不改定时任务本身，只有运行历史变了，调用方刷新历史即可。
   * 失败分支仍带回 run——失败的运行同样是一条审计记录，不是没有记录。
   */
  runScheduledTaskNow: (taskId: string) => Promise<ScheduledTaskRunNowResult>;
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

  createIdea: async (title) => {
    const blank = blankIdea(title);
    const data = await api().ideaUpsert({
      id: blank.id,
      title: blank.title,
      notes: blank.notes,
      createdAt: blank.createdAt,
    });
    if (!data.ideas[blank.id]) return false;
    set({ data });
    return true;
  },

  createFollowUp: async (title) => {
    const blank = blankFollowUp(title);
    const data = await api().followUpUpsert({
      id: blank.id,
      title: blank.title,
      notes: blank.notes,
      createdAt: blank.createdAt,
      entries: blank.entries,
    });
    if (!data.followUps[blank.id]) return false;
    set({ data });
    return true;
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

  createScheduledTask: async (draft) => {
    const blank = blankScheduledTask(draft.name, draft.prompt, draft.schedule);
    const data = await api().scheduledTaskUpsert({
      id: blank.id,
      name: draft.name,
      prompt: draft.prompt,
      schedule: draft.schedule,
      enabled: blank.enabled,
    });
    const saved = Boolean(data.scheduledTasks[blank.id]);
    if (saved) set({ data });
    return saved ? blank.id : null;
  },

  saveScheduledTask: async (task, patch) => {
    const data = await api().scheduledTaskUpsert({
      id: task.id,
      name: patch.name ?? task.name,
      prompt: patch.prompt ?? task.prompt,
      schedule: patch.schedule ?? task.schedule,
      // null 是"清空"，与"不动"在契约里是两个意思，所以先判 null 再取缺省：写成
      // `patch.workingDirectory ?? task.workingDirectory` 的话，一次"清空"会被
      // 回退成原来的目录，用户永远删不掉它。
      workingDirectory:
        patch.workingDirectory === null
          ? null
          : (patch.workingDirectory ?? task.workingDirectory ?? null),
      enabled: patch.enabled ?? task.enabled,
    });
    const saved = Boolean(data.scheduledTasks[task.id]);
    if (saved) set({ data });
    return saved;
  },

  deleteScheduledTask: async (id) => {
    const data = await api().scheduledTaskDelete({ id });
    set({ data });
  },

  listScheduledTaskRuns: (scheduledTaskId) => api().scheduledTaskRunsList({ scheduledTaskId }),

  runScheduledTaskNow: (taskId) => api().scheduledTaskRunNow({ taskId }),
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
