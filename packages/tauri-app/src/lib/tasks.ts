import { type AppData, addDays, localDate, type Project, type Task } from '@tiny-schedule/shared';

export function isTopLevel(t: Task): boolean {
  return !t.parentTaskId;
}

export function isOverdue(t: Task, now = Date.now()): boolean {
  const today = localDate(now);
  return !t.isDone && !!t.dueDay && t.dueDay < today;
}

// ---------------------------------------------------------------------------
// 看板查询助手（首页四象限 / 长期池）
// ---------------------------------------------------------------------------

/** The four quadrant cells, from important×urgent. */
export type QuadrantKey =
  | 'important-urgent'
  | 'important-notUrgent'
  | 'notImportant-urgent'
  | 'notImportant-notUrgent';

export const QUADRANT_KEYS: QuadrantKey[] = [
  'important-urgent',
  'important-notUrgent',
  'notImportant-urgent',
  'notImportant-notUrgent',
];

/** A task due beyond this many days belongs to the long-term pool. */
export const LONG_TERM_HORIZON_DAYS = 14;

/**
 * Urgency is derived, never stored: dueDay within `thresholdDays` of today is
 * urgent, and an overdue task satisfies it for free. Dates compare as
 * YYYY-MM-DD strings, the same way the worklog export ranges them.
 */
export function isUrgent(t: Task, today: string, thresholdDays: number): boolean {
  if (t.isDone || !t.dueDay) return false;
  return t.dueDay <= addDays(today, thresholdDays);
}

export function quadrantOf(t: Task, today: string, thresholdDays: number): QuadrantKey {
  const important = t.isImportant ? 'important' : 'notImportant';
  const urgent = isUrgent(t, today, thresholdDays) ? 'urgent' : 'notUrgent';
  return `${important}-${urgent}`;
}

/** Top-level open tasks projected into the four cells. */
export function quadrantTasks(
  tasks: Task[],
  today: string,
  thresholdDays: number,
): Record<QuadrantKey, Task[]> {
  const cells: Record<QuadrantKey, Task[]> = {
    'important-urgent': [],
    'important-notUrgent': [],
    'notImportant-urgent': [],
    'notImportant-notUrgent': [],
  };
  for (const t of tasks) {
    if (!isTopLevel(t) || t.isDone) continue;
    cells[quadrantOf(t, today, thresholdDays)].push(t);
  }
  return cells;
}

/**
 * How many tasks with this cell's coordinates were finished in the last week.
 * Counted from the whole set (done tasks are not in any open cell) so a cell
 * can report its own throughput rather than nothing.
 */
export function completedInCell(
  tasks: Task[],
  cell: QuadrantKey,
  today: string,
  thresholdDays: number,
): number {
  const from = addDays(today, -6);
  return tasks.filter(
    (t) =>
      isTopLevel(t) &&
      t.isDone &&
      t.doneAt !== undefined &&
      localDate(t.doneAt) >= from &&
      localDate(t.doneAt) <= today &&
      quadrantOf(t, today, thresholdDays) === cell,
  ).length;
}

/** Top-level open tasks with no due day, and those due beyond the horizon. */
export function longTermPool(
  tasks: Task[],
  today: string,
): { unscheduled: Task[]; farFuture: Task[] } {
  const open = tasks.filter((t) => isTopLevel(t) && !t.isDone);
  const horizon = addDays(today, LONG_TERM_HORIZON_DAYS);
  return {
    unscheduled: open.filter((t) => !t.dueDay).sort((a, b) => b.created - a.created),
    farFuture: open
      .filter((t) => !!t.dueDay && t.dueDay > horizon)
      .sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? '')),
  };
}

export interface FocusPoint {
  date: string;
  ms: number;
}

/** Focus ms per day for the 7 days ending today (today included). */
export function focusSeries7d(tasks: Task[], today: string): FocusPoint[] {
  const from = addDays(today, -6);
  const series: FocusPoint[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(from, i);
    let ms = 0;
    for (const t of tasks) ms += t.timeSpentOnDay[date] ?? 0;
    series.push({ date, ms });
  }
  return series;
}

/** Focus ms recorded today across every task, subtasks included. */
export function workedTodayMs(tasks: Task[], today: string): number {
  return tasks.reduce((sum, t) => sum + (t.timeSpentOnDay[today] ?? 0), 0);
}

/** Unfinished work still owed on the tasks due today or earlier. */
export function estimateRemainingMs(tasks: Task[], today: string): number {
  return tasks
    .filter(isTopLevel)
    .filter((t) => !t.isDone && !!t.dueDay && t.dueDay <= today)
    .reduce((sum, t) => sum + Math.max(0, t.timeEstimate - t.timeSpent), 0);
}

/** Top-level tasks finished today (doneAt is epoch ms). */
export function doneTodayCount(tasks: Task[], today: string): number {
  return tasks.filter(
    (t) => isTopLevel(t) && t.isDone && t.doneAt !== undefined && localDate(t.doneAt) === today,
  ).length;
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

// 只展示今天做完的任务（含提前做完/逾期做完，它们的 doneAt 都是今天）；
// 过去几天做完的任务随日期滚动消失，历史已做完任务在各项目页查看。
export function todayDoneTasks(data: AppData, now = Date.now()): Task[] {
  const today = localDate(now);
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => t.isDone && t.doneAt !== undefined && localDate(t.doneAt) === today)
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
    isImportant: false,
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
