import type { AppData, Idea, IdeaStatus } from '@tiny-schedule/shared';

// 想法的模型与生命周期转移规则归 shared 的 domain/idea.ts 所有（ADR-0003）；
// 本文件只剩读侧 selector。写侧一律经由主进程的想法意图命令，见 stores/data.ts。

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
