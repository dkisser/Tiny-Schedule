import { type AppData, localDate, SYSTEM_TAG_IDS, type Task } from '@tiny-schedule/shared';

export function isTopLevel(t: Task): boolean {
  return !t.parentTaskId;
}

export function todayTasks(data: AppData, now = Date.now()): Task[] {
  const today = localDate(now);
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => !t.isDone)
    .filter((t) => t.tagIds.includes(SYSTEM_TAG_IDS.today) || t.dueDay === today)
    .sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? ''));
}

export function projectTasks(data: AppData, projectId: string): Task[] {
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => Number(a.isDone) - Number(b.isDone) || b.created - a.created);
}

export function tagTasks(data: AppData, tagId: string): Task[] {
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => !t.isDone && t.tagIds.includes(tagId))
    .sort((a, b) => b.created - a.created);
}

export function upcomingTasks(data: AppData, now = Date.now()): Task[] {
  const today = localDate(now);
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => !t.isDone && t.dueDay && t.dueDay > today)
    .sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? ''));
}

export function newTaskId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankTask(title: string, projectId: string, extraTagIds: string[] = []): Task {
  return {
    id: newTaskId(),
    title,
    projectId,
    tagIds: extraTagIds,
    subTaskIds: [],
    isDone: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: Date.now(),
  };
}
