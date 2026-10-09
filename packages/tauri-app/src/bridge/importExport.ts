import {
  type AppData,
  defaultSettings,
  INBOX_PROJECT_ID,
  PROJECT_TITLE_MAX_LENGTH,
  type Project,
  type Tag,
  type Task,
} from '@tiny-schedule/shared';

/**
 * Super Productivity backup import, ported verbatim from
 * packages/app/src/main/importer.ts.
 *
 * This is the merge-semantics half of the import feature and it moved into the
 * webview unchanged: it is pure TS over plain data, has no Node dependency, and
 * its "imported entity wins on id collision while the running timer and the
 * local AI history survive" rule is the part a rewrite would silently break.
 * The Electron-only parts (dialogs, file reads, the store write) live in
 * `src/api/files.ts`.
 *
 * Field-for-field identical to the original, including the two Chinese
 * comments, which record decisions rather than describe code.
 */

interface RawEntities<T> {
  ids?: unknown;
  entities?: Record<string, T & { id?: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface ImportCounts {
  tasks: number;
  projects: number;
  tags: number;
}

export function normalizeBackup(raw: unknown): { data: AppData; counts: ImportCounts } {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new Error('INVALID_BACKUP: missing data object');
  }
  const d = raw.data;
  const rawTasks = d.task as RawEntities<Record<string, unknown>> | undefined;
  const rawProjects = d.project as RawEntities<Record<string, unknown>> | undefined;
  const rawTags = d.tag as RawEntities<Record<string, unknown>> | undefined;
  if (
    !isRecord(rawTasks?.entities) ||
    !isRecord(rawProjects?.entities) ||
    !isRecord(rawTags?.entities)
  ) {
    throw new Error('INVALID_BACKUP: missing task/project/tag entities');
  }

  const tasks: Record<string, Task> = {};
  for (const [id, t] of Object.entries(rawTasks.entities)) {
    tasks[id] = {
      id,
      title: typeof t.title === 'string' ? t.title : '(untitled)',
      projectId:
        typeof t.projectId === 'string' && t.projectId.length > 0 ? t.projectId : INBOX_PROJECT_ID,
      tagIds: Array.isArray(t.tagIds)
        ? (t.tagIds as string[]).filter((x) => typeof x === 'string')
        : [],
      subTaskIds: Array.isArray(t.subTaskIds) ? (t.subTaskIds as string[]) : [],
      isDone: t.isDone === true,
      dueDay: typeof t.dueDay === 'string' ? t.dueDay : undefined,
      timeEstimate: typeof t.timeEstimate === 'number' ? t.timeEstimate : 0,
      timeSpent: typeof t.timeSpent === 'number' ? t.timeSpent : 0,
      timeSpentOnDay: isRecord(t.timeSpentOnDay)
        ? Object.fromEntries(
            Object.entries(t.timeSpentOnDay).filter(([, v]) => typeof v === 'number') as [
              string,
              number,
            ][],
          )
        : {},
      timeEntries: [],
      notes: typeof t.notes === 'string' ? t.notes : '',
      created: typeof t.created === 'number' ? t.created : Date.now(),
      // A completed task needs a completion time, or the first edit that
      // follows the import stamps one: `upsertTaskWithTiming` resolves
      // `incoming.doneAt ?? stored?.doneAt ?? now`, so leaving it undefined
      // produced `isDone: true` with no doneAt, and the user saw a task
      // completed in 2023 report "做完于 今天" the moment they touched its
      // title — plus a fresh entry in today's done group for work that
      // happened long ago. Backups carry no completion time, so the created
      // timestamp is used as the floor: it is a real date from the task's own
      // history and never later than the completion it stands in for.
      doneAt:
        t.isDone === true
          ? typeof t.doneAt === 'number'
            ? t.doneAt
            : typeof t.created === 'number'
              ? t.created
              : Date.now()
          : undefined,
    };
  }
  // derive parentTaskId from subTaskIds
  for (const parent of Object.values(tasks)) {
    for (const subId of parent.subTaskIds) {
      const sub = tasks[subId];
      if (sub) sub.parentTaskId = parent.id;
    }
  }

  const projects: Record<string, Project> = {};
  for (const [id, p] of Object.entries(rawProjects.entities)) {
    const theme = isRecord(p.theme) ? p.theme : {};
    projects[id] = {
      id,
      title: (typeof p.title === 'string' ? p.title : id).slice(0, PROJECT_TITLE_MAX_LENGTH),
      icon: typeof p.icon === 'string' ? p.icon : undefined,
      isArchived: p.isArchived === true,
      primaryColor: typeof theme.primary === 'string' ? theme.primary : undefined,
    };
  }
  if (!projects[INBOX_PROJECT_ID]) {
    projects[INBOX_PROJECT_ID] = {
      id: INBOX_PROJECT_ID,
      title: 'Inbox',
      icon: 'inbox',
      isArchived: false,
    };
  }

  const tags: Record<string, Tag> = {};
  for (const [id, tg] of Object.entries(rawTags.entities)) {
    tags[id] = {
      id,
      title: typeof tg.title === 'string' ? tg.title : id,
      color: typeof tg.color === 'string' ? tg.color : undefined,
    };
  }

  // Snapshot display names at import time (tasks are decoupled from entities).
  for (const t of Object.values(tasks)) {
    const project = projects[t.projectId];
    if (project) t.projectTitle = project.title;
    const snapshots: Record<string, { title: string; color?: string }> = {};
    for (const tagId of t.tagIds) {
      const tag = tags[tagId];
      if (tag) snapshots[tagId] = { title: tag.title, ...(tag.color ? { color: tag.color } : {}) };
    }
    if (Object.keys(snapshots).length > 0) t.tagSnapshots = snapshots;
  }

  const data: AppData = {
    version: 1,
    tasks,
    projects,
    tags,
    timeTracking: d.timeTracking ?? null,
    notes: d.note ?? null,
    planner: d.planner ?? null,
    metric: d.metric ?? null,
    boards: d.boards ?? null,
    misc: {
      simpleCounter: d.simpleCounter ?? null,
      taskRepeatCfg: d.taskRepeatCfg ?? null,
      issueProvider: d.issueProvider ?? null,
      reminders: d.reminders ?? null,
      menuTree: d.menuTree ?? null,
      importedAt: Date.now(),
    },
    settings: defaultSettings(),
    activeTimer: null,
    followUps: {},
    ideas: {},
  };

  return {
    data,
    counts: {
      tasks: Object.keys(tasks).length,
      projects: Object.keys(projects).length,
      tags: Object.keys(tags).length,
    },
  };
}

/**
 * Whole-library import: append imported content onto current data instead of
 * replacing it. On ID collisions the imported entity wins; everything else
 * (existing tasks, AI chat sessions/history in misc, settings, running timer)
 * is preserved.
 */
export function mergeImport(current: AppData, imported: AppData): AppData {
  return {
    ...current,
    tasks: { ...current.tasks, ...imported.tasks },
    projects: { ...current.projects, ...imported.projects },
    tags: { ...current.tags, ...imported.tags },
    timeTracking: imported.timeTracking ?? current.timeTracking,
    notes: imported.notes ?? current.notes,
    planner: imported.planner ?? current.planner,
    metric: imported.metric ?? current.metric,
    boards: imported.boards ?? current.boards,
    misc: { ...current.misc, ...imported.misc },
    // Super Productivity 备份里没有想法/跟进概念：导入必须保留本地已有记录，
    // 不能用 normalizeBackup 产出的空对象覆盖（决策 12）。
    followUps: current.followUps,
    ideas: current.ideas,
    settings: current.settings,
    activeTimer: current.activeTimer,
  };
}

/**
 * Markdown export, ported from packages/app/src/main/exporter.ts and
 * packages/app/src/main/duration.ts.
 *
 * The Electron original kept the formatters in a separate `duration.ts` that
 * the main process shared with other modules; in the webview there is nothing
 * else to share them with, so they live next to their only caller.
 */

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
}

function tagLabel(data: AppData, t: Task, tagId: string): string | null {
  const title = t.tagSnapshots?.[tagId]?.title ?? data.tags[tagId]?.title;
  return title ? `\`${title}\`` : null;
}

function taskLine(data: AppData, t: Task): string {
  const parts: string[] = [];
  const tags = t.tagIds.map((id) => tagLabel(data, t, id)).filter(Boolean);
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
    '## 已做完',
    ...(done.length > 0 ? done.map((t) => taskLine(data, t)) : ['（无）']),
    '',
  ];
  return lines.join('\n');
}

export interface WorklogOptions {
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
