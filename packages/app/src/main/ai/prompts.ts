import { type AppData, addDays } from '@tiny-schedule/shared';

export const DEFAULT_PROMPT = `你是一个效率分析助手。以下是用户 {{date}} 的任务与时间数据（JSON）：

{{data}}

请生成一份 Markdown 格式的报告，包含：
1. 概览：完成任务数、总耗时、时间主要花在哪里
2. 亮点与问题：各 1-2 条
3. 建议：2-3 条可执行的下一步
保持简洁，总长度不超过 300 字。`;

export interface PromptVars {
  date: string;
  data: string;
}

export function renderPrompt(template: string, vars: PromptVars): string {
  const tpl = template.trim().length > 0 ? template : DEFAULT_PROMPT;
  return tpl.replaceAll('{{date}}', vars.date).replaceAll('{{data}}', vars.data);
}

export interface AnalysisScope {
  scope: 'today' | 'week' | 'project';
  date: string; // anchor date YYYY-MM-DD
  projectId?: string;
}

export function touchesRange(
  t: { timeSpentOnDay: Record<string, number>; dueDay?: string },
  from: string,
  to: string,
): boolean {
  for (const day of Object.keys(t.timeSpentOnDay)) {
    if (day >= from && day <= to) return true;
  }
  return !!t.dueDay && t.dueDay >= from && t.dueDay <= to;
}

export function scopeToRange(
  scope: 'today' | 'week' | 'project',
  date: string,
): { from: string; to: string } {
  if (scope !== 'week') return { from: date, to: date };
  const [ay, am, ad] = date.split('-').map(Number) as [number, number, number];
  const dow = new Date(ay, am - 1, ad).getDay(); // 0 = Sunday
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const from = addDays(date, mondayOffset);
  return { from, to: addDays(from, 6) };
}

export function buildAnalysisData(data: AppData, scope: AnalysisScope): string {
  const { from, to } = scopeToRange(scope.scope, scope.date);

  const tasks = Object.values(data.tasks)
    .filter((t) => !t.parentTaskId)
    .filter((t) => {
      if (scope.scope === 'project') return t.projectId === scope.projectId;
      return touchesRange(t, from, to);
    })
    .map((t) => ({
      title: t.title,
      isDone: t.isDone,
      project: data.projects[t.projectId]?.title ?? t.projectId,
      tags: t.tagIds.map((id) => data.tags[id]?.title ?? id),
      dueDay: t.dueDay,
      timeEstimateMs: t.timeEstimate,
      timeSpentMs: t.timeSpent,
      timeSpentInRangeMs: Object.entries(t.timeSpentOnDay)
        .filter(([day]) => day >= from && day <= to)
        .reduce((sum, [, ms]) => sum + ms, 0),
    }));

  const payload = {
    range: scope.scope === 'today' ? scope.date : `${from} ~ ${to}`,
    project:
      scope.scope === 'project'
        ? (data.projects[scope.projectId ?? '']?.title ?? scope.projectId)
        : undefined,
    summary: {
      taskCount: tasks.length,
      doneCount: tasks.filter((t) => t.isDone).length,
      totalSpentMs: tasks.reduce((s, t) => s + t.timeSpentInRangeMs, 0),
    },
    tasks,
  };
  return JSON.stringify(payload, null, 2);
}
