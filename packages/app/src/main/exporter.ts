import type { AppData, Task } from '@tiny-schedule/shared';
import { formatClock, formatDuration } from './duration';

function tagLabel(data: AppData, tagId: string): string | null {
  const tag = data.tags[tagId];
  return tag ? `\`${tag.title}\`` : null;
}

function taskLine(data: AppData, t: Task): string {
  const parts: string[] = [];
  const tags = t.tagIds.map((id) => tagLabel(data, id)).filter(Boolean);
  if (tags.length > 0) parts.push(tags.join(' '));
  if (t.dueDay) parts.push(`截止 ${t.dueDay}`);
  if (t.timeEstimate > 0) parts.push(`预估 ${formatDuration(t.timeEstimate)}`);
  if (t.timeSpent > 0) parts.push(`实际 ${formatDuration(t.timeSpent)}`);
  const suffix = parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
  return `- [${t.isDone ? 'x' : ' '}] ${t.title}${suffix}`;
}

export function exportProjectTaskList(data: AppData, projectId: string): string {
  const project = data.projects[projectId];
  if (!project) throw new Error(`UNKNOWN_PROJECT: ${projectId}`);
  const tasks = Object.values(data.tasks).filter(
    (t) => t.projectId === projectId && !t.parentTaskId,
  );
  const open = tasks.filter((t) => !t.isDone);
  const done = tasks.filter((t) => t.isDone);
  const lines = [
    `# ${project.title}`,
    '',
    `> 导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 进行中',
    ...(open.length > 0 ? open.map((t) => taskLine(data, t)) : ['（无）']),
    '',
    '## 已完成',
    ...(done.length > 0 ? done.map((t) => taskLine(data, t)) : ['（无）']),
    '',
  ];
  return lines.join('\n');
}

interface WorklogOptions {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  projectId?: string;
}

function dayWindow(data: AppData, date: string): string | null {
  const tt = data.timeTracking as {
    tag?: Record<string, Record<string, { s?: number; e?: number }>>;
  } | null;
  const entry = tt?.tag?.TODAY?.[date];
  if (!entry?.s || !entry?.e) return null;
  return `工作时间：${formatClock(entry.s)} - ${formatClock(entry.e)}`;
}

export function exportWorklog(data: AppData, opts: WorklogOptions): string {
  const { from, to, projectId } = opts;
  const dates: string[] = [];
  for (const t of Object.values(data.tasks)) {
    if (projectId && t.projectId !== projectId) continue;
    for (const date of Object.keys(t.timeSpentOnDay)) {
      if (date >= from && date <= to) dates.push(date);
    }
  }
  const uniqueDates = [...new Set(dates)].sort();

  const lines = [`# 工作日志 ${from} ~ ${to}`, ''];
  if (uniqueDates.length === 0) {
    lines.push('该时间段没有工作记录。', '');
    return lines.join('\n');
  }
  for (const date of uniqueDates) {
    const dayTasks = Object.values(data.tasks).filter((t) => {
      if (projectId && t.projectId !== projectId) return false;
      return (t.timeSpentOnDay[date] ?? 0) > 0;
    });
    const total = dayTasks.reduce((sum, t) => sum + (t.timeSpentOnDay[date] ?? 0), 0);
    lines.push(`## ${date}（合计 ${formatDuration(total)}）`);
    const window = dayWindow(data, date);
    if (window) lines.push(window);
    for (const t of dayTasks) {
      lines.push(`- ${t.title} | ${formatDuration(t.timeSpentOnDay[date] ?? 0)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
