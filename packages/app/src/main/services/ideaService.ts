import { randomUUID } from 'node:crypto';
import {
  type AppData,
  closeIdeaWithVerdict,
  completeIdea,
  discardIdea,
  type Idea,
  type IdeaCommandResult,
  type IdeaConvertResult,
  type IdeaEdit,
  type IdeaUpgradeResult,
  INBOX_PROJECT_ID,
  ideaToTask,
  PROJECT_TITLE_MAX_LENGTH,
  type Project,
  reopenIdea,
  upgradeIdeaToProject,
  upsertTaskWithTiming,
} from '@tiny-schedule/shared';
import type { ServiceDeps } from './taskService';

/**
 * 想法的写侧唯一入口（ADR-0003）。
 *
 * 与 taskService 的区别：想法的写契约是**意图命令集**而不是 upsert，所以这里的
 * 方法名就是 CONTEXT.md 的领域语言，守卫在这里强制——converted/closed 不可重开、
 * reopen 仅限 done/discarded、closed 必须带 verdict。领域拒绝返回 { ok:false, error }，
 * 系统错误继续 throw，与 contract 的既有惯例一致。
 *
 * `upsert` 仍原样保留（渲染进程阶段③才切换到命令集），本阶段不收紧它的语义。
 */

export interface IdeaUpgradeInput {
  title: string;
  icon?: string;
  primaryColor?: string;
  validationGoal?: string;
}

function newProjectId(): string {
  return `p_${randomUUID()}`;
}

export function createIdeaService({ store, logger }: ServiceDeps) {
  /** Fetch an idea or reject with a stable error code. */
  const load = (id: string): { idea: Idea; data: AppData } | { error: string } => {
    const data = store.get();
    const idea = data.ideas[id];
    if (!idea) return { error: 'IDEA_NOT_FOUND' };
    return { idea, data };
  };

  const apply = (id: string, transition: (idea: Idea) => Idea): IdeaCommandResult => {
    const found = load(id);
    if ('error' in found) return { ok: false, error: found.error };
    const next = store.update((d) => ({
      ...d,
      ideas: { ...d.ideas, [id]: transition(found.idea) },
    }));
    logger.info({ action: 'idea:transition', ideaId: id });
    return { ok: true, data: next };
  };

  /**
   * Guard + transition, shared by the single-field commands.
   *
   * Deliberately NOT part of the returned object: exposing it would let a
   * future agent write tool or handler perform a transition the command set
   * deliberately does not express, which is the whole point of ADR-0003
   * ("契约里根本不存在这个操作"). A closure also keeps it off `this`, so the
   * commands below stay safe to destructure.
   */
  const transitionFrom = (
    id: string,
    allowed: readonly Idea['status'][],
    transition: (idea: Idea) => Idea,
    rejectError: string,
  ): IdeaCommandResult => {
    const found = load(id);
    if ('error' in found) return { ok: false, error: found.error };
    if (!allowed.includes(found.idea.status)) {
      logger.info({
        action: 'idea:rejected',
        ideaId: id,
        status: found.idea.status,
        error: rejectError,
      });
      return { ok: false, error: rejectError };
    }
    return apply(id, transition);
  };

  return {
    /**
     * 想法的字段编辑（标题/备注/验证目标/演进日志）。
     *
     * 写契约收紧后 ideaUpsert 只携带非状态字段，所以这里必须**合并**到已存的想法
     * 上，而不是覆盖：覆盖会把 status 与转移结果抹掉，等于绕过刚立起来的守卫。
     * 新建（记录箱里记一笔）仍走这条路径，落库时 status 恒为 open。
     */
    edit(patch: IdeaEdit): AppData {
      // A partial edit is a *merge*, so only the keys the caller actually set
      // may be applied. `{ ...stored, ...patch }` would let an explicitly
      // present-but-undefined optional key (which is what zod hands back for
      // `timeline: undefined`) erase the stored value — the schema was
      // deliberately loosened so callers could send partial edits, and every
      // one of them would have been silently destructive.
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ) as Partial<IdeaEdit>;
      const next = store.update((d) => {
        const stored = d.ideas[patch.id];
        const idea: Idea = stored
          ? { ...stored, ...defined, id: patch.id }
          : { ...patch, status: 'open' as const };
        return { ...d, ideas: { ...d.ideas, [idea.id]: idea } };
      });
      logger.info({ action: 'idea:upsert', ideaId: patch.id, title: patch.title });
      return next;
    },

    remove(id: string): AppData {
      const next = store.update((d) => {
        const ideas = { ...d.ideas };
        delete ideas[id];
        return { ...d, ideas };
      });
      logger.info({ action: 'idea:delete', ideaId: id });
      return next;
    },

    /** 记录即完成。open 是唯一可分流的状态，incubating/closed/converted 均拒绝。 */
    complete(id: string): IdeaCommandResult {
      return transitionFrom(id, ['open'], completeIdea, 'IDEA_NOT_IN_OPEN');
    },

    /** 废弃。 */
    discard(id: string): IdeaCommandResult {
      return transitionFrom(id, ['open'], discardIdea, 'IDEA_NOT_IN_OPEN');
    },

    /**
     * 重新打开：仅 done/discarded 允许，回到收集箱。
     * converted 与 closed 是终态——契约上根本没有对它们 reopen 的操作。
     */
    reopen(id: string): IdeaCommandResult {
      return transitionFrom(id, ['done', 'discarded'], reopenIdea, 'IDEA_NOT_REOPENABLE');
    },

    /** 转为任务：任务进 Inbox，想法转 converted（终态）。 */
    convertToTask(id: string, title?: string): IdeaConvertResult {
      const found = load(id);
      if ('error' in found) return { ok: false, error: found.error };
      if (found.idea.status !== 'open') {
        return { ok: false, error: 'IDEA_NOT_IN_OPEN' };
      }
      const inbox: Project | undefined = found.data.projects[INBOX_PROJECT_ID];
      if (!inbox) {
        logger.error({ action: 'idea:convertToTask', ideaId: id, reason: 'no-inbox' });
        throw new Error('Inbox project is missing');
      }
      // 标题覆盖：调用方可以给任务换名，但备注恒随想法带入。
      const source = title ? { ...found.idea, title } : found.idea;
      const { task, converted } = ideaToTask(source, inbox);
      const now = Date.now();
      const next = store.update((d) => {
        // Route the task write through the shared invariant helper rather than
        // splicing d.tasks: upsertTaskWithTiming ends every task write with
        // dropStaleTiming, which is what guarantees "no write leaves a done
        // task still being timed". Splicing skipped it, so a stale activeTimer
        // survived the conversion and later billed time onto a finished task.
        // Running it inside this same update keeps the two writes atomic.
        const r = upsertTaskWithTiming(d, task, now);
        return { ...r.data, ideas: { ...r.data.ideas, [id]: converted } };
      });
      logger.info({ action: 'idea:convertToTask', ideaId: id, taskId: task.id });
      return { ok: true, data: next, taskId: task.id };
    },

    /**
     * 升级为项目：建专属项目 + 转验证中，在**一次** store.update 里完成。
     *
     * 渲染进程过去编排两次独立 IPC（先 project:create 再 idea:upsert），中途崩溃
     * 会留下孤儿项目；原子性由此而来——不存在"项目建好了但想法没转"的中间态。
     */
    upgradeToProject(id: string, input: IdeaUpgradeInput): IdeaUpgradeResult {
      const found = load(id);
      if ('error' in found) return { ok: false, error: found.error };
      if (found.idea.status !== 'open') {
        return { ok: false, error: 'IDEA_NOT_IN_OPEN' };
      }
      const projectId = newProjectId();
      const project: Project = {
        id: projectId,
        title: input.title.slice(0, PROJECT_TITLE_MAX_LENGTH),
        icon: input.icon,
        isArchived: false,
        primaryColor: input.primaryColor,
      };
      const upgraded = upgradeIdeaToProject(found.idea, projectId, input.validationGoal);
      const next = store.update((d) => ({
        ...d,
        projects: { ...d.projects, [projectId]: project },
        ideas: { ...d.ideas, [id]: upgraded },
      }));
      logger.info({ action: 'idea:upgradeToProject', ideaId: id, projectId });
      return { ok: true, data: next, projectId };
    },

    /**
     * 给出结论：incubating → closed；已 closed 时复用来修改结论。
     * verdict 由 schema 强制存在（result 必填），所以"closed 必须带结论"在契约层
     * 就无法表达为一个缺 verdict 的命令。
     */
    closeWithVerdict(
      id: string,
      result: 'validated' | 'invalidated' | 'partial',
      text?: string,
    ): IdeaCommandResult {
      return transitionFrom(
        id,
        ['incubating', 'closed'],
        (idea) => closeIdeaWithVerdict(idea, result, text),
        'IDEA_NOT_CLOSABLE',
      );
    },
  };
}

export type IdeaService = ReturnType<typeof createIdeaService>;
