import type {
  AppData,
  Idea,
  IdeaEntry,
  IdeaStatus,
  IdeaVerdict,
  Project,
  Task,
} from '@tiny-schedule/shared';
import { blankTask } from './tasks';

export function newIdeaId(): string {
  return `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankIdea(title: string): Idea {
  return {
    id: newIdeaId(),
    title,
    notes: '',
    createdAt: Date.now(),
    status: 'open',
  };
}

// 收集箱：未处理的想法，新建的在最前。
export function openIdeas(data: AppData): Idea[] {
  return Object.values(data.ideas)
    .filter((i) => i.status === 'open')
    .sort((a, b) => b.createdAt - a.createdAt);
}

// 待结论：验证中、未给结论、且关联项目已归档。项目恢复归档时自然失效。
export function ideaPendingVerdict(idea: Idea, data: AppData): boolean {
  return (
    idea.status === 'incubating' &&
    !idea.verdict &&
    idea.projectId !== undefined &&
    data.projects[idea.projectId]?.isArchived === true
  );
}

// 想法关联的专属项目（一对一）；项目页横幅与归档检测用。
export function ideaByProjectId(data: AppData, projectId: string): Idea | undefined {
  return Object.values(data.ideas).find((i) => i.projectId === projectId);
}

// 关联项目的未完成任务数（验证中区行与关联项目卡片用）。
export function ideaProjectOpenTaskCount(data: AppData, projectId: string): number {
  return Object.values(data.tasks).filter(
    (t) => t.projectId === projectId && !t.parentTaskId && !t.isDone,
  ).length;
}

function ideaActivityAt(idea: Idea): number {
  const latestEntry = idea.timeline?.reduce((m, e) => Math.max(m, e.createdAt), 0) ?? 0;
  return Math.max(latestEntry, idea.incubatedAt ?? 0);
}

// 验证中的想法：待结论的置顶，其余按最近活跃（timeline 最新条目或升级时间）倒序。
export function incubatingIdeas(data: AppData): Idea[] {
  return Object.values(data.ideas)
    .filter((i) => i.status === 'incubating')
    .sort((a, b) => {
      const pa = ideaPendingVerdict(a, data);
      const pb = ideaPendingVerdict(b, data);
      if (pa !== pb) return pa ? -1 : 1;
      return ideaActivityAt(b) - ideaActivityAt(a);
    });
}

const RESOLVED_STATUSES: readonly IdeaStatus[] = ['done', 'discarded', 'converted', 'closed'];

// 已了结的想法：按了结时间倒序（converted 的老数据用 convertedAt 兜底）。
export function resolvedIdeas(data: AppData): Idea[] {
  return Object.values(data.ideas)
    .filter((i) => RESOLVED_STATUSES.includes(i.status))
    .sort((a, b) => (b.resolvedAt ?? b.convertedAt ?? 0) - (a.resolvedAt ?? a.convertedAt ?? 0));
}

// 想法转任务：任务进 Inbox，备注随标题一起带入；返回新任务与更新后的想法，
// 由调用方负责 upsertTask / upsertIdea。
export function ideaToTask(idea: Idea, inbox: Project): { task: Task; converted: Idea } {
  const task: Task = { ...blankTask(idea.title, inbox), notes: idea.notes };
  return {
    task,
    converted: { ...idea, status: 'converted', convertedAt: Date.now(), convertedTaskId: task.id },
  };
}

// 直接完成：记录即完成（今天的感受、天气…）。
export function completeIdea(idea: Idea): Idea {
  return { ...idea, status: 'done', resolvedAt: Date.now() };
}

// 废弃：觉得没必要做了；可重新打开。
export function discardIdea(idea: Idea): Idea {
  return { ...idea, status: 'discarded', resolvedAt: Date.now() };
}

// 重新打开：仅 done/discarded 允许，回到收集箱。
export function reopenIdea(idea: Idea): Idea {
  if (idea.status !== 'done' && idea.status !== 'discarded') return idea;
  return { ...idea, status: 'open', resolvedAt: undefined };
}

// 升级为项目：关联专属项目并进入验证中。项目由调用方先通过 project:create 建好。
export function upgradeIdeaToProject(idea: Idea, projectId: string, validationGoal?: string): Idea {
  return {
    ...idea,
    status: 'incubating',
    projectId,
    validationGoal: validationGoal || undefined,
    incubatedAt: Date.now(),
  };
}

export function appendIdeaEntry(idea: Idea, text: string): Idea {
  const entry: IdeaEntry = { id: newIdeaId(), createdAt: Date.now(), text };
  return { ...idea, timeline: [...(idea.timeline ?? []), entry] };
}

export function updateIdeaEntry(idea: Idea, entryId: string, text: string): Idea {
  return {
    ...idea,
    timeline: (idea.timeline ?? []).map((e) => (e.id === entryId ? { ...e, text } : e)),
  };
}

export function deleteIdeaEntry(idea: Idea, entryId: string): Idea {
  return { ...idea, timeline: (idea.timeline ?? []).filter((e) => e.id !== entryId) };
}

// 给出结论：incubating → closed；已 closed 时复用来修改结论（状态不变，只更新 verdict）。
export function closeIdeaWithVerdict(
  idea: Idea,
  result: IdeaVerdict['result'],
  text?: string,
): Idea {
  const verdict: IdeaVerdict = { result, text: text || undefined, closedAt: Date.now() };
  if (idea.status === 'closed') return { ...idea, verdict };
  return { ...idea, status: 'closed', verdict, resolvedAt: Date.now() };
}
