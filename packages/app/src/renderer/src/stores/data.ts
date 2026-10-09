import type {
  AppData,
  AppSettings,
  FollowUpEdit,
  Idea,
  IdeaVerdict,
  Project,
  Task,
  WriteOutcome,
} from '@tiny-schedule/shared';
import { toast } from 'sonner';
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
async function adoptCommand<T extends ({ ok: true } & WriteOutcome) | { ok: false; error: string }>(
  promise: Promise<T>,
): Promise<IdeaCommandOutcome & Partial<T>> {
  let result: T;
  try {
    result = await promise;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'COMMAND_FAILED',
    } as IdeaCommandOutcome & Partial<T>;
  }
  if (!result.ok) return { ok: false, error: result.error } as IdeaCommandOutcome & Partial<T>;
  // Same two rules as adopt(): a refused write must not blank the app with the
  // degraded dataset, and must be reported once.
  const data = adopt({ data: result.data, persisted: result.persisted });
  result = { ...result, data } as T;
  // Forwarded rather than dropped: the contract adds taskId/projectId to some
  // commands precisely so the renderer does not have to guess them back out
  // of the returned dataset. Widening the parameter erased them, and nothing
  // caught it because a widened parameter type-checks.
  return { ...result, ok: true };
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
  upsertTask: (task: Task) => Promise<{ data: AppData; settledMs: number; persisted: boolean }>;
  deleteTask: (id: string) => Promise<void>;
  /** 字段编辑（标题/备注/条目/下次跟进日）；状态只能走 resolve/reopen 命令。 */
  upsertFollowUp: (followUp: FollowUpEdit) => Promise<void>;
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
  convertIdeaToTask: (
    id: string,
    title?: string,
  ) => Promise<IdeaCommandOutcome & { taskId?: string }>;
  upgradeIdeaToProject: (req: {
    id: string;
    title: string;
    icon?: string;
    primaryColor?: string;
    validationGoal?: string;
  }) => Promise<IdeaCommandOutcome & { projectId?: string }>;
  closeIdeaWithVerdict: (
    id: string,
    result: IdeaVerdict['result'],
    text?: string,
  ) => Promise<IdeaCommandOutcome>;
  resolveFollowUp: (id: string) => Promise<FollowUpCommandOutcome>;
  reopenFollowUp: (id: string) => Promise<FollowUpCommandOutcome>;
  setTaskOrder: (viewKey: string, ids: string[]) => void;
  // Returns the new project's id — the service mints it, so the renderer no
  // longer recovers it by diffing the project list.
  createProject: (title: string) => Promise<string>;
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

/**
 * 写通道结果的唯一采纳点（ADR-0004）。
 *
 * 两条规则都在这里，且只有这里：
 *
 * 1. **降级数据集不采纳。** persisted 为 false 时，data 是主进程自己都读不出来
 *    的回落值（可能是空库）。把它 set 进 store 会让整个任务库从界面上消失，
 *    而提示语说的是"保存失败"——用户不会把两者联系起来。
 * 2. **提示只有一处。** 之前每条写路径各自判断 persisted、各自写 toast，漏一次
 *    就是用户看着保存成功、重启后数据消失，而漏掉是默认结果。
 *
 * 返回值仍是采纳后的数据集，供调用方需要时使用（读的是 store 里的既有值）。
 */
function adopt(outcome: WriteOutcome): AppData {
  if (!outcome.persisted) {
    toast.error('保存失败：数据文件当前不可写，这次修改没有落盘。');
    return useDataStore.getState().data ?? outcome.data;
  }
  useDataStore.setState({ data: outcome.data });
  return outcome.data;
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
    const outcome = await api().taskUpsert(task);
    // Completing a task reports what main actually recorded; a refused write
    // must reach the dialog as a failure rather than a clean zero.
    const data = adopt(outcome);
    return { data, settledMs: outcome.settledMs, persisted: outcome.persisted };
  },
  deleteTask: async (id) => {
    adopt(await api().taskDelete({ id }));
  },
  upsertFollowUp: async (followUp) => {
    // Hand-picked fields: the caller usually spreads its render-time snapshot,
    // and the state fields are not on the edit contract. Sending them anyway
    // would just have zod strip them — or, if that ever changed, silently
    // undo a 办结 the user had already performed.
    adopt(
      await api().followUpUpsert({
        id: followUp.id,
        title: followUp.title,
        notes: followUp.notes,
        createdAt: followUp.createdAt,
        entries: followUp.entries ?? [],
        ...(followUp.nextFollowUpDay !== undefined
          ? { nextFollowUpDay: followUp.nextFollowUpDay }
          : {}),
      }),
    );
  },
  deleteFollowUp: async (id) => {
    adopt(await api().followUpDelete({ id }));
  },
  upsertIdea: async (idea) => {
    // The write contract carries non-status fields only (ADR-0003), so a caller
    // holding a full Idea cannot smuggle a status change through this path.
    // The timeline is deliberately NOT sent: this path is for scalar fields the
    // user just typed, and the caller's snapshot of a list is as stale as its
    // snapshot of anything else — a debounced title commit landing after an
    // entry was added would roll the timeline back. It has its own commands.
    adopt(
      await api().ideaUpsert({
        id: idea.id,
        title: idea.title,
        notes: idea.notes,
        createdAt: idea.createdAt,
        // Omitted when undefined: the main process treats an absent key as "leave
        // this alone". Only an explicit null clears the field.
        ...(idea.validationGoal !== undefined ? { validationGoal: idea.validationGoal } : {}),
      }),
    );
  },
  addIdeaEntry: (id, text) => adoptCommand(api().ideaAddEntry({ id, text })),
  deleteIdeaEntry: (id, entryId) => adoptCommand(api().ideaDeleteEntry({ id, entryId })),
  updateIdeaEntry: (id, entryId, text) =>
    adoptCommand(api().ideaUpdateEntry({ id, entryId, text })),
  deleteIdea: async (id) => {
    adopt(await api().ideaDelete({ id }));
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
    // projectService.create returns the id directly. It used to be recovered
    // by diffing the whole project list, which returns the wrong project if
    // two creations interleave — and the caller that comment cited has since
    // moved to the atomic ideaUpgradeToProject, leaving the diff dead.
    const outcome = await api().projectCreate({ title });
    adopt(outcome);
    return outcome.projectId;
  },
  updateProject: async (id, patch) => {
    adopt(await api().projectUpdate({ id, ...patch }));
  },
  deleteProject: async (id) => {
    adopt(await api().projectDelete({ id }));
  },
  createTag: async (title) => {
    adopt(await api().tagCreate({ title }));
  },
  updateTag: async (id, title) => {
    adopt(await api().tagUpdate({ id, title }));
  },
  deleteTag: async (id) => {
    adopt(await api().tagDelete({ id }));
  },
  updateSettings: async (patch) => {
    adopt(await api().settingsUpdate(patch));
  },
}));
