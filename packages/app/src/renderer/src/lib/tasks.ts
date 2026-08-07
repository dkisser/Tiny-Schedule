import { type AppData, localDate, type Project, type Task } from '@tiny-schedule/shared';

export function isTopLevel(t: Task): boolean {
  return !t.parentTaskId;
}

export function isOverdue(t: Task, now = Date.now()): boolean {
  const today = localDate(now);
  return !t.isDone && !!t.dueDay && t.dueDay < today;
}

// Today is driven purely by dueDay: a task belongs to Today when its due day
// is today or earlier (overdue tasks stay visible). The old TODAY system tag
// no longer controls membership.
export function todayTasks(data: AppData, now = Date.now()): Task[] {
  const today = localDate(now);
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => !t.isDone)
    .filter((t) => !!t.dueDay && t.dueDay <= today)
    .sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? ''));
}

export function todayDoneTasks(data: AppData, now = Date.now()): Task[] {
  const today = localDate(now);
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => t.isDone)
    .filter((t) => {
      // 今天完成的（含逾期完成/提前完成）+ 截止日不超过今天的已完成记录
      if (t.doneAt !== undefined && localDate(t.doneAt) === today) return true;
      return !!t.dueDay && t.dueDay <= today;
    })
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
}

export function splitByDone(tasks: Task[]): { open: Task[]; done: Task[] } {
  const open: Task[] = [];
  const done: Task[] = [];
  for (const t of tasks) {
    if (t.isDone) done.push(t);
    else open.push(t);
  }
  done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return { open, done };
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

export function taskOrderFor(data: AppData, viewKey: string): string[] | undefined {
  return (data.misc.taskOrder as Record<string, string[]> | undefined)?.[viewKey];
}

// Manual drag order overrides the default sort for tasks present in orderIds;
// tasks added afterwards keep their default order, appended after the manual ones.
export function applyManualOrder(tasks: Task[], orderIds?: string[]): Task[] {
  if (!orderIds || orderIds.length === 0) return tasks;
  const pos = new Map(orderIds.map((id, i) => [id, i]));
  const ordered = tasks
    .filter((t) => pos.has(t.id))
    .sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  const rest = tasks.filter((t) => !pos.has(t.id));
  return [...ordered, ...rest];
}

export function newTaskId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankTask(title: string, project: Project): Task {
  return {
    id: newTaskId(),
    title,
    projectId: project.id,
    projectTitle: project.title,
    tagIds: [],
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

// Display names come from the task's snapshot first; only tasks created
// before the snapshot fields existed fall back to the live entity lookup.
export function taskProjectTitle(task: Task, data: AppData): string {
  return task.projectTitle ?? data.projects[task.projectId]?.title ?? '';
}

export function taskTagLabel(task: Task, data: AppData, tagId: string): string {
  return task.tagSnapshots?.[tagId]?.title ?? data.tags[tagId]?.title ?? '';
}
