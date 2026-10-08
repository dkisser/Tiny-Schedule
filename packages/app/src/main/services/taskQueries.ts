import { type AppData, localDate } from '@tiny-schedule/shared';
import { scopeToRange, touchesRange } from './prompts';

export interface QueryTasksParams {
  from?: string; // YYYY-MM-DD
  to?: string;
  dueFrom?: string; // 截止日范围 YYYY-MM-DD
  dueTo?: string;
  doneFrom?: string; // 完成日范围 YYYY-MM-DD
  doneTo?: string;
  projectId?: string;
  isDone?: boolean;
}

export interface QueriedTask {
  id: string;
  title: string;
  isDone: boolean;
  doneAt?: string; // YYYY-MM-DD
  project: string;
  tags: string[];
  dueDay?: string;
  timeEstimateMs: number;
  timeSpentMs: number;
  timeSpentInRangeMs: number;
}

/**
 * The read side of the task aggregate.
 *
 * Exposed as a factory over a reader rather than as functions taking an
 * AppData: "the agent's tools read through services" (ADR-0003) only holds if
 * there is no way to reach the data without going through the service. A
 * caller handed an `AppData` could invoke `queryTasks(store.get(), params)`
 * directly, so the boundary would be a convention. Taking a reader makes the
 * store the only way in.
 */
export function createTaskQueries(read: () => AppData) {
  const queryTasks = (p: QueryTasksParams): QueriedTask[] => runQuery(read(), p);
  const getSummary = (p: SummaryParams): SummaryResult => runSummary(read(), p);
  return { queryTasks, getSummary };
}

function runQuery(data: AppData, p: QueryTasksParams): QueriedTask[] {
  // 范围过滤：from/to 各边界独立求值；只给一边时另一边界视为开（不设限）
  const hasRange = p.from !== undefined || p.to !== undefined;
  const from = p.from ?? '0000-01-01';
  const to = p.to ?? '9999-12-31';
  const hasDueRange = p.dueFrom !== undefined || p.dueTo !== undefined;
  const dueFrom = p.dueFrom ?? '0000-01-01';
  const dueTo = p.dueTo ?? '9999-12-31';
  const hasDoneRange = p.doneFrom !== undefined || p.doneTo !== undefined;
  const doneFrom = p.doneFrom ?? '0000-01-01';
  const doneTo = p.doneTo ?? '9999-12-31';
  return Object.values(data.tasks)
    .filter((t) => !t.parentTaskId)
    .filter((t) => (p.projectId ? t.projectId === p.projectId : true))
    .filter((t) => (p.isDone === undefined ? true : t.isDone === p.isDone))
    .filter((t) => (hasRange ? touchesRange(t, from, to) : true))
    .filter((t) => (hasDueRange ? !!t.dueDay && t.dueDay >= dueFrom && t.dueDay <= dueTo : true))
    .filter((t) => {
      if (!hasDoneRange) return true;
      if (t.doneAt === undefined) return false;
      const done = localDate(t.doneAt);
      return done >= doneFrom && done <= doneTo;
    })
    .map((t) => ({
      id: t.id,
      title: t.title,
      isDone: t.isDone,
      doneAt: t.doneAt !== undefined ? localDate(t.doneAt) : undefined,
      project: t.projectTitle ?? data.projects[t.projectId]?.title ?? t.projectId,
      tags: t.tagIds.map((id) => t.tagSnapshots?.[id]?.title ?? data.tags[id]?.title ?? id),
      dueDay: t.dueDay,
      timeEstimateMs: t.timeEstimate,
      timeSpentMs: t.timeSpent,
      timeSpentInRangeMs: hasRange
        ? Object.entries(t.timeSpentOnDay)
            .filter(([day]) => day >= from && day <= to)
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

function runSummary(data: AppData, p: SummaryParams): SummaryResult {
  const date = p.date ?? '1970-01-01';
  // project 范围必须提供 projectId：缺省时返回空汇总，避免把全部任务当作该项目的统计
  if (p.scope === 'project' && !p.projectId) {
    return { range: '', taskCount: 0, doneCount: 0, totalSpentMs: 0, byProject: [], byTag: [] };
  }
  const query =
    p.scope === 'project'
      ? runQuery(data, { projectId: p.projectId })
      : runQuery(data, scopeToRange(p.scope, date));
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
