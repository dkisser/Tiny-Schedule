import type { AppData } from '@tiny-schedule/shared';
import { scopeToRange, touchesRange } from './prompts';

export interface QueryTasksParams {
  from?: string; // YYYY-MM-DD
  to?: string;
  projectId?: string;
  isDone?: boolean;
}

export interface QueriedTask {
  id: string;
  title: string;
  isDone: boolean;
  project: string;
  tags: string[];
  dueDay?: string;
  timeEstimateMs: number;
  timeSpentMs: number;
  timeSpentInRangeMs: number;
}

export function queryTasks(data: AppData, p: QueryTasksParams): QueriedTask[] {
  return Object.values(data.tasks)
    .filter((t) => !t.parentTaskId)
    .filter((t) => (p.projectId ? t.projectId === p.projectId : true))
    .filter((t) => (p.isDone === undefined ? true : t.isDone === p.isDone))
    .filter((t) => (p.from && p.to ? touchesRange(t, p.from, p.to) : true))
    .map((t) => ({
      id: t.id,
      title: t.title,
      isDone: t.isDone,
      project: data.projects[t.projectId]?.title ?? t.projectId,
      tags: t.tagIds.map((id) => data.tags[id]?.title ?? id),
      dueDay: t.dueDay,
      timeEstimateMs: t.timeEstimate,
      timeSpentMs: t.timeSpent,
      timeSpentInRangeMs:
        p.from && p.to
          ? Object.entries(t.timeSpentOnDay)
              .filter(([day]) => day >= (p.from as string) && day <= (p.to as string))
              .reduce((sum, [, ms]) => sum + ms, 0)
          : t.timeSpent,
    }));
}

export interface SummaryParams {
  scope: 'today' | 'week' | 'project';
  date?: string; // 缺省由调用方注入今天
  projectId?: string;
}

export interface SummaryResult {
  range: string;
  taskCount: number;
  doneCount: number;
  totalSpentMs: number;
  byProject: { project: string; taskCount: number; spentMs: number }[];
  byTag: { tag: string; taskCount: number; spentMs: number }[];
}

export function getSummary(data: AppData, p: SummaryParams): SummaryResult {
  const date = p.date ?? '1970-01-01';
  const query =
    p.scope === 'project'
      ? queryTasks(data, { projectId: p.projectId })
      : queryTasks(data, scopeToRange(p.scope, date));
  const byProject = new Map<string, { project: string; taskCount: number; spentMs: number }>();
  const byTag = new Map<string, { tag: string; taskCount: number; spentMs: number }>();
  for (const t of query) {
    const pj = byProject.get(t.project) ?? { project: t.project, taskCount: 0, spentMs: 0 };
    pj.taskCount += 1;
    pj.spentMs += t.timeSpentInRangeMs;
    byProject.set(t.project, pj);
    for (const tag of t.tags) {
      const tg = byTag.get(tag) ?? { tag, taskCount: 0, spentMs: 0 };
      tg.taskCount += 1;
      tg.spentMs += t.timeSpentInRangeMs;
      byTag.set(tag, tg);
    }
  }
  const { from, to } = p.scope === 'project' ? { from: '', to: '' } : scopeToRange(p.scope, date);
  return {
    range:
      p.scope === 'project' ? (data.projects[p.projectId ?? '']?.title ?? '') : `${from} ~ ${to}`,
    taskCount: query.length,
    doneCount: query.filter((t) => t.isDone).length,
    totalSpentMs: query.reduce((s, t) => s + t.timeSpentInRangeMs, 0),
    byProject: [...byProject.values()].sort((a, b) => b.spentMs - a.spentMs),
    byTag: [...byTag.values()].sort((a, b) => b.spentMs - a.spentMs),
  };
}

export interface MetaResult {
  projects: { id: string; title: string; isArchived: boolean }[];
  tags: { id: string; title: string }[];
}

export function listMeta(data: AppData): MetaResult {
  return {
    projects: Object.values(data.projects).map((p) => ({
      id: p.id,
      title: p.title,
      isArchived: p.isArchived,
    })),
    tags: Object.values(data.tags).map((t) => ({ id: t.id, title: t.title })),
  };
}
