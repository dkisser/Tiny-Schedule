/**
 * Task projections.
 *
 * 今日 / 四象限 / 长期池 are three views over the same task set — not three
 * concepts. Every rule here is a pure function over tasks, so the agent, the
 * HTTP API and the browser all read the same answers.
 */
import { addDays, localDate } from './time.ts';
import type { QuadrantKey, TaskFilter, TaskView } from './types.ts';
import { QUADRANT_KEYS } from './types.ts';

/** A task with no parent — the unit the views are built from. */
export function isTopLevel(t: TaskView): boolean {
  return !t.parentTaskId;
}

/** Unfinished work whose due day has passed. */
export function isOverdue(t: TaskView, now = Date.now()): boolean {
  const day = localDate(now);
  return !t.isDone && !!t.dueDay && t.dueDay < day;
}

/**
 * Urgency is derived, never stored: a due day within `thresholdDays` of today
 * is urgent, and an overdue task satisfies it for free. Dates compare as
 * YYYY-MM-DD strings.
 */
export function isUrgent(t: TaskView, today: string, thresholdDays: number): boolean {
  if (t.isDone || !t.dueDay) return false;
  return t.dueDay <= addDays(today, thresholdDays);
}

/** Importance is stored, urgency is derived. */
export function quadrantOf(t: TaskView, today: string, thresholdDays: number): QuadrantKey {
  const important = t.isImportant ? 'important' : 'notImportant';
  const urgent = isUrgent(t, today, thresholdDays) ? 'urgent' : 'notUrgent';
  return `${important}-${urgent}` as QuadrantKey;
}

/** Does the cell sit on the urgent side of the board? */
export function isUrgentCell(cell: QuadrantKey): boolean {
  return cell.endsWith('-urgent');
}

/** Does the cell sit on the important side of the board? */
export function isImportantCell(cell: QuadrantKey): boolean {
  return cell.startsWith('important-');
}

/**
 * The field changes that move a task into `target`.
 *
 * A board is a view, not a container: there is no "place a task in this cell"
 * to honour, so a drop is translated into the fields that put the task where
 * the user pointed. Urgency has no stored field, so crossing that axis is a
 * rewrite of the due day — today to become urgent, the first day outside the
 * threshold to leave it.
 */
export function quadrantMovePatch(
  task: TaskView,
  target: QuadrantKey,
  today: string,
  thresholdDays: number,
): { dueDay?: string; isImportant?: boolean } {
  const patch: { dueDay?: string; isImportant?: boolean } = {};
  const current = quadrantOf(task, today, thresholdDays);
  if (isUrgentCell(current) !== isUrgentCell(target)) {
    patch.dueDay = isUrgentCell(target) ? today : addDays(today, thresholdDays + 1);
  }
  const important = isImportantCell(target);
  if (important !== task.isImportant) patch.isImportant = important;
  return patch;
}

/** Top-level open tasks projected into the four cells. */
export function quadrantTasks(
  tasks: TaskView[],
  today: string,
  thresholdDays: number,
): Record<QuadrantKey, TaskView[]> {
  const cells: Record<QuadrantKey, TaskView[]> = {
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
 * Counted from the whole set (done tasks sit in no open cell) so a cell can
 * report its own throughput rather than nothing.
 */
export function completedInCell(
  tasks: TaskView[],
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
  tasks: TaskView[],
  today: string,
  horizonDays: number,
): { unscheduled: TaskView[]; farFuture: TaskView[] } {
  const open = tasks.filter((t) => isTopLevel(t) && !t.isDone);
  const horizon = addDays(today, horizonDays);
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
export function focusSeries7d(tasks: TaskView[], today: string): FocusPoint[] {
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
export function workedTodayMs(tasks: TaskView[], today: string): number {
  return tasks.reduce((sum, t) => sum + (t.timeSpentOnDay[today] ?? 0), 0);
}

/** Unfinished work still owed on the tasks due today or earlier. */
export function estimateRemainingMs(tasks: TaskView[], today: string): number {
  return tasks
    .filter(isTopLevel)
    .filter((t) => !t.isDone && !!t.dueDay && t.dueDay <= today)
    .reduce((sum, t) => sum + Math.max(0, t.timeEstimate - t.timeSpent), 0);
}

/** Top-level tasks finished today (doneAt is epoch ms). */
export function doneTodayCount(tasks: TaskView[], today: string): number {
  return tasks.filter(
    (t) => isTopLevel(t) && t.isDone && t.doneAt !== undefined && localDate(t.doneAt) === today,
  ).length;
}

/**
 * Today is driven purely by dueDay: a task belongs to Today when its due day
 * is today or earlier (overdue tasks stay visible).
 */
export function todayTasks(tasks: TaskView[], today: string): TaskView[] {
  return tasks
    .filter(isTopLevel)
    .filter((t) => !t.isDone)
    .filter((t) => !!t.dueDay && t.dueDay <= today)
    .sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? ''));
}

/** Tasks finished today, including ones finished early or late. */
export function todayDoneTasks(tasks: TaskView[], today: string): TaskView[] {
  return tasks
    .filter(isTopLevel)
    .filter((t) => t.isDone && t.doneAt !== undefined && localDate(t.doneAt) === today)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
}

export function splitByDone(tasks: TaskView[]): { open: TaskView[]; done: TaskView[] } {
  const open: TaskView[] = [];
  const done: TaskView[] = [];
  for (const t of tasks) {
    if (t.isDone) done.push(t);
    else open.push(t);
  }
  done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return { open, done };
}

/** Tasks of one project, open first. */
export function projectTasks(tasks: TaskView[], projectId: string): TaskView[] {
  return tasks
    .filter(isTopLevel)
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => Number(a.isDone) - Number(b.isDone) || b.created - a.created);
}

/** Open tasks carrying a tag, newest first. */
export function tagTasks(tasks: TaskView[], tagId: string): TaskView[] {
  return tasks
    .filter(isTopLevel)
    .filter((t) => !t.isDone && t.tagIds.includes(tagId))
    .sort((a, b) => b.created - a.created);
}

/** Open tasks due after today. */
export function upcomingTasks(tasks: TaskView[], today: string): TaskView[] {
  return tasks
    .filter(isTopLevel)
    .filter((t) => !t.isDone && !!t.dueDay && t.dueDay > today)
    .sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? ''));
}

/**
 * Manual drag order overrides the default sort for tasks present in
 * `orderIds`; tasks added afterwards keep their default order, appended after
 * the manual ones.
 */
export function applyManualOrder(tasks: TaskView[], orderIds?: string[]): TaskView[] {
  if (!orderIds || orderIds.length === 0) return tasks;
  const pos = new Map(orderIds.map((id, i) => [id, i]));
  const ordered = tasks
    .filter((t) => pos.has(t.id))
    .sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  const rest = tasks.filter((t) => !pos.has(t.id));
  return [...ordered, ...rest];
}

/** Apply a filter set to the task list. */
export function filterTasks(
  tasks: TaskView[],
  filter: TaskFilter,
  today: string,
  thresholdDays: number,
  horizonDays: number,
): TaskView[] {
  const pool = filter.includeSubtasks ? tasks : tasks.filter(isTopLevel);
  return pool.filter((t) => {
    if (filter.isDone !== undefined && t.isDone !== filter.isDone) return false;
    if (filter.projectId !== undefined && t.projectId !== filter.projectId) return false;
    if (filter.tagIds !== undefined && !filter.tagIds.every((id) => t.tagIds.includes(id)))
      return false;
    if (
      filter.doneFrom !== undefined &&
      (t.doneAt === undefined || localDate(t.doneAt) < filter.doneFrom)
    ) {
      return false;
    }
    if (
      filter.doneTo !== undefined &&
      (t.doneAt === undefined || localDate(t.doneAt) > filter.doneTo)
    ) {
      return false;
    }
    if (filter.dueFrom !== undefined && (!t.dueDay || t.dueDay < filter.dueFrom)) return false;
    if (filter.dueTo !== undefined && (!t.dueDay || t.dueDay > filter.dueTo)) return false;
    if (filter.quadrant !== undefined && quadrantOf(t, today, thresholdDays) !== filter.quadrant)
      return false;
    if (filter.longTerm === true) {
      const pool = longTermPool([t], today, horizonDays);
      if (pool.unscheduled.length === 0 && pool.farFuture.length === 0) return false;
    }
    return true;
  });
}

export function newTaskId(now = Date.now()): string {
  return `t_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newProjectId(now = Date.now()): string {
  return `p_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newTimeEntryId(now = Date.now()): string {
  return `e_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** A blank task, bound to a project. */
export function blankTask(
  title: string,
  project: { id: string; title: string },
  now = Date.now(),
): TaskView {
  return {
    id: newTaskId(now),
    title,
    projectId: project.id,
    projectTitle: project.title,
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    isImportant: false,
    timeEstimate: 0,
    notes: '',
    created: now,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
  };
}

/** Display names come from the task's snapshot first; only tasks created before the snapshot fields existed fall back to the live entity lookup. */
export function taskProjectTitle(
  task: TaskView,
  projects: Record<string, { title: string }>,
): string {
  return task.projectTitle ?? projects[task.projectId]?.title ?? '';
}

/** The label of a tag, from the task's snapshot when the tag is gone. */
export function taskTagLabel(
  task: TaskView,
  tags: Record<string, { title: string }>,
  tagId: string,
): string {
  return task.tagSnapshots?.[tagId]?.title ?? tags[tagId]?.title ?? '';
}
