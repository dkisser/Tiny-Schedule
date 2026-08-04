import {
  type AppData,
  defaultSettings,
  INBOX_PROJECT_ID,
  type Project,
  type Tag,
  type Task,
} from '@tiny-schedule/shared';

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
      title: typeof p.title === 'string' ? p.title : id,
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

/** Whole-library import: replace content, keep current settings + running timer. */
export function mergeImport(current: AppData, imported: AppData): AppData {
  return {
    ...imported,
    settings: current.settings,
    activeTimer: current.activeTimer,
  };
}
