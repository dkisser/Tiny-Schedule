/**
 * The task tracker service.
 *
 * Every mutation in the plugin goes through this class: the agent's tools and
 * the browser's HTTP actions call the same methods, so there is exactly one
 * write path and one projection path. Reads are synchronous (the domain keeps
 * its authoritative state in memory); writes are queued on the domain's single
 * write chain.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import {
  appendFollowUpEntry,
  blankFollowUp,
  isFollowUpDue,
  reopenFollowUp,
  resolveFollowUp,
} from '../domain/followups.ts';
import {
  appendIdeaEntry,
  blankIdea,
  closeIdeaWithVerdict,
  completeIdea,
  discardIdea,
  reopenIdea,
  upgradeIdeaToProject,
} from '../domain/ideas.ts';
import { blankTask, newProjectId, newTaskId, newTimeEntryId } from '../domain/projections.ts';
import type {
  ActiveTimerRecord,
  FollowUpRecord,
  IdeaRecord,
  ProjectRecord,
  SettingsRecord,
  TagRecord,
  TaskRecord,
  TimeEntryRecord,
} from '../domain/schema.ts';
import { addDays, localDate, today as todayOf } from '../domain/time.ts';
import { pauseTimer, resumeTimer, settleTimer, startTimer } from '../domain/timer.ts';
import type { TaskView } from '../domain/types.ts';
import type { TrackerSnapshot } from './snapshot.ts';
import { taskTrackerDomainSpec } from './spec.ts';

/** The inbox project every task can land in. */
export const INBOX_PROJECT_ID = 'INBOX_PROJECT';

export interface TaskInput {
  id?: string;
  title: string;
  projectId?: string;
  tagIds?: string[];
  dueDay?: string;
  isImportant?: boolean;
  notes?: string;
  timeEstimate?: number;
  parentTaskId?: string;
}

/** The editable fields of a task, as the browser's detail panel sees them. */
export interface TaskPatch {
  title?: string;
  projectId?: string;
  /** `null` clears the due day. */
  dueDay?: string | null;
  isImportant?: boolean;
  notes?: string;
  /** Estimate in ms. */
  timeEstimate?: number;
  tagIds?: string[];
}

export interface IdeaInput {
  id?: string;
  title: string;
  notes?: string;
}

export interface FollowUpInput {
  id?: string;
  title: string;
  notes?: string;
  nextFollowUpDay?: string;
}

/** The payload the browser renders. One snapshot, one fetch. */
export type { TrackerSnapshot } from './snapshot.ts';

export class TaskTrackerService {
  constructor(private readonly domain: Domain<typeof taskTrackerDomainSpec>) {}

  // ── reads ────────────────────────────────────────────────────────────────

  get settings(): SettingsRecord {
    return this.domain.global.get().settings;
  }

  get activeTimer(): ActiveTimerRecord | null {
    return this.domain.global.get().activeTimer;
  }

  listProjects(): ProjectRecord[] {
    return [...this.domain.table('projects').entries()].map(([, value]) => value);
  }

  listTags(): TagRecord[] {
    return [...this.domain.table('tags').entries()].map(([, value]) => value);
  }

  listIdeas(): IdeaRecord[] {
    return [...this.domain.table('ideas').entries()].map(([, value]) => value);
  }

  listFollowUps(): FollowUpRecord[] {
    return [...this.domain.table('follow_ups').entries()].map(([, value]) => value);
  }

  listTimeEntries(): TimeEntryRecord[] {
    return [...this.domain.table('time_entries').entries()].map(([, value]) => value);
  }

  /**
   * All tasks with their time figures derived from the `time_entries` table.
   * Per-task totals and per-day totals are computed here, never stored twice.
   */
  listTasks(): TaskView[] {
    const spent = new Map<string, number>();
    const perDay = new Map<string, Record<string, number>>();
    const entries = new Map<string, TimeEntryRecord[]>();
    for (const entry of this.listTimeEntries()) {
      spent.set(entry.taskId, (spent.get(entry.taskId) ?? 0) + entry.ms);
      const days = perDay.get(entry.taskId) ?? {};
      days[entry.date] = (days[entry.date] ?? 0) + entry.ms;
      perDay.set(entry.taskId, days);
      const rows = entries.get(entry.taskId) ?? [];
      rows.push(entry);
      entries.set(entry.taskId, rows);
    }
    return [...this.domain.table('tasks').entries()].map(([, task]) => ({
      ...task,
      timeSpent: spent.get(task.id) ?? 0,
      timeSpentOnDay: perDay.get(task.id) ?? {},
      timeEntries: (entries.get(task.id) ?? []).slice().sort((a, b) => a.end - b.end),
    }));
  }

  /** Manual drag order, keyed by view. */
  orders(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [, row] of this.domain.table('task_order').entries()) {
      result[row.viewKey] = row.ids;
    }
    return result;
  }

  /** The full state the browser renders. */
  snapshot(): TrackerSnapshot {
    return {
      settings: this.settings,
      activeTimer: this.activeTimer,
      tasks: this.listTasks(),
      projects: this.listProjects(),
      tags: this.listTags(),
      ideas: this.listIdeas(),
      followUps: this.listFollowUps(),
      orders: this.orders(),
    };
  }

  // ── projects & tags ──────────────────────────────────────────────────────

  async ensureInboxProject(): Promise<ProjectRecord> {
    const projects = this.domain.table('projects');
    const existing = projects.get(INBOX_PROJECT_ID);
    if (existing !== undefined) return existing;
    const inbox: ProjectRecord = { id: INBOX_PROJECT_ID, title: 'Inbox', isArchived: false };
    await projects.put(inbox.id, inbox);
    return inbox;
  }

  async createProject(input: {
    title: string;
    icon?: string;
    primaryColor?: string | null;
  }): Promise<ProjectRecord> {
    const project: ProjectRecord = {
      id: newProjectId(),
      title: input.title,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      isArchived: false,
      ...(input.primaryColor !== undefined ? { primaryColor: input.primaryColor } : {}),
    };
    await this.domain.table('projects').put(project.id, project);
    return project;
  }

  async setProjectArchived(id: string, archived: boolean): Promise<ProjectRecord> {
    const project = this.domain.table('projects').get(id);
    if (project === undefined) throw new Error(`project '${id}' does not exist`);
    const next = { ...project, isArchived: archived };
    await this.domain.table('projects').put(id, next);
    return next;
  }

  async createTag(input: { title: string; color?: string }): Promise<TagRecord> {
    const tag: TagRecord = {
      id: `g_${newProjectId().slice(2)}`,
      title: input.title,
      ...(input.color !== undefined ? { color: input.color } : {}),
    };
    await this.domain.table('tags').put(tag.id, tag);
    return tag;
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  async upsertTask(input: TaskInput): Promise<TaskRecord> {
    const tasks = this.domain.table('tasks');
    const now = Date.now();
    const existing = input.id !== undefined ? tasks.get(input.id) : undefined;
    if (existing === undefined) {
      const project =
        input.projectId !== undefined
          ? this.domain.table('projects').get(input.projectId)
          : undefined;
      const inbox = await this.ensureInboxProject();
      const base = blankTask(input.title, project ?? inbox, now);
      const created: TaskRecord = {
        ...base,
        id: input.id ?? base.id,
        projectId: project?.id ?? inbox.id,
        ...(project !== undefined ? { projectTitle: project.title } : {}),
        ...(input.tagIds !== undefined ? { tagIds: input.tagIds } : {}),
        ...(input.dueDay !== undefined ? { dueDay: input.dueDay } : {}),
        ...(input.isImportant !== undefined ? { isImportant: input.isImportant } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.timeEstimate !== undefined ? { timeEstimate: input.timeEstimate } : {}),
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      };
      await tasks.put(created.id, created);
      if (created.parentTaskId !== undefined) {
        await this.addSubTask(created.parentTaskId, created.id);
      }
      return created;
    }
    const next: TaskRecord = {
      ...existing,
      title: input.title,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.tagIds !== undefined ? { tagIds: input.tagIds } : {}),
      ...(input.dueDay !== undefined ? { dueDay: input.dueDay } : {}),
      ...(input.isImportant !== undefined ? { isImportant: input.isImportant } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.timeEstimate !== undefined ? { timeEstimate: input.timeEstimate } : {}),
    };
    await tasks.put(next.id, next);
    return next;
  }

  /**
   * Patch the editable fields of a task. Only the fields present in the patch
   * change; `dueDay: null` clears the due day.
   */
  async updateTask(id: string, patch: TaskPatch): Promise<TaskRecord> {
    const tasks = this.domain.table('tasks');
    const task = tasks.get(id);
    if (task === undefined) throw new Error(`task '${id}' does not exist`);
    const next: TaskRecord = {
      ...task,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.dueDay !== undefined ? { dueDay: patch.dueDay ?? undefined } : {}),
      ...(patch.isImportant !== undefined ? { isImportant: patch.isImportant } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.timeEstimate !== undefined
        ? { timeEstimate: Math.max(0, patch.timeEstimate) }
        : {}),
      ...(patch.tagIds !== undefined ? { tagIds: patch.tagIds } : {}),
    };
    await tasks.put(id, next);
    return next;
  }

  private async addSubTask(parentId: string, childId: string): Promise<void> {
    const tasks = this.domain.table('tasks');
    const parent = tasks.get(parentId);
    if (parent === undefined) return;
    if (parent.subTaskIds.includes(childId)) return;
    await tasks.put(parentId, { ...parent, subTaskIds: [...parent.subTaskIds, childId] });
  }

  /**
   * Mark a task done or undone. Completing a task that currently has the
   * running timer settles that timer first — the work is finished, so the
   * interval closes with it.
   */
  async setTaskDone(id: string, done: boolean): Promise<TaskRecord> {
    const tasks = this.domain.table('tasks');
    const task = tasks.get(id);
    if (task === undefined) throw new Error(`task '${id}' does not exist`);
    if (done && this.activeTimer?.taskId === id) {
      await this.stopTimer();
    }
    const next: TaskRecord = done
      ? { ...task, isDone: true, doneAt: Date.now() }
      : { ...task, isDone: false, doneAt: undefined };
    await tasks.put(id, next);
    return next;
  }

  async deleteTask(id: string): Promise<void> {
    const tasks = this.domain.table('tasks');
    const task = tasks.get(id);
    if (task === undefined) return;
    if (this.activeTimer?.taskId === id) {
      await this.stopTimer();
    }
    const entries = this.domain.table('time_entries');
    for (const entry of this.listTimeEntries()) {
      if (entry.taskId === id) await entries.delete(entry.id);
    }
    for (const child of task.subTaskIds) {
      const childTask = tasks.get(child);
      if (childTask !== undefined) {
        await tasks.put(child, { ...childTask, parentTaskId: undefined });
      }
    }
    if (task.parentTaskId !== undefined) {
      const parent = tasks.get(task.parentTaskId);
      if (parent !== undefined) {
        await tasks.put(parent.id, {
          ...parent,
          subTaskIds: parent.subTaskIds.filter((childId) => childId !== id),
        });
      }
    }
    await tasks.delete(id);
  }

  /** Record the manual drag order of one view. */
  async setOrder(viewKey: string, ids: string[]): Promise<void> {
    await this.domain.table('task_order').put(viewKey, { viewKey, ids });
  }

  // ── time & timer ─────────────────────────────────────────────────────────

  /**
   * Record a measured interval. `date` defaults to today; the interval is
   * anchored at the end of the given day so the per-day totals land where the
   * user expects them.
   */
  async logTime(input: {
    taskId: string;
    minutes: number;
    date?: string;
    note?: string;
  }): Promise<TimeEntryRecord> {
    const tasks = this.domain.table('tasks');
    if (tasks.get(input.taskId) === undefined) {
      throw new Error(`task '${input.taskId}' does not exist`);
    }
    const date = input.date ?? todayOf();
    const ms = Math.round(input.minutes * 60_000);
    const end = endOfDay(date);
    const entry: TimeEntryRecord = {
      id: newTimeEntryId(),
      taskId: input.taskId,
      date,
      start: end - ms,
      end,
      ms,
    };
    await this.domain.table('time_entries').put(entry.id, entry);
    return entry;
  }

  /** Remove one measured interval. The per-task totals shrink with it. */
  async deleteTimeEntry(id: string): Promise<void> {
    const entries = this.domain.table('time_entries');
    if (entries.get(id) === undefined) throw new Error(`time entry '${id}' does not exist`);
    await entries.delete(id);
  }

  async startTimer(taskId: string): Promise<ActiveTimerRecord> {
    const tasks = this.domain.table('tasks');
    if (tasks.get(taskId) === undefined) throw new Error(`task '${taskId}' does not exist`);
    const current = this.activeTimer;
    if (current !== null) {
      throw new Error(`a timer is already running on task '${current.taskId}'`);
    }
    const timer = startTimer(taskId, Date.now());
    await this.setActiveTimer(timer);
    return timer;
  }

  async pauseTimer(): Promise<ActiveTimerRecord> {
    const current = this.activeTimer;
    if (current === null) throw new Error('no timer is running');
    const next = pauseTimer(current, Date.now());
    await this.setActiveTimer(next);
    return next;
  }

  async resumeTimer(): Promise<ActiveTimerRecord> {
    const current = this.activeTimer;
    if (current === null) throw new Error('no timer is running');
    const next = resumeTimer(current, Date.now());
    await this.setActiveTimer(next);
    return next;
  }

  /** Close the timer and persist the interval it measured. */
  async stopTimer(): Promise<{ ms: number; entry: TimeEntryRecord }> {
    const current = this.activeTimer;
    if (current === null) throw new Error('no timer is running');
    const settlement = settleTimer(current, Date.now());
    const entry: TimeEntryRecord = {
      id: newTimeEntryId(),
      taskId: current.taskId,
      ...settlement.entry,
    };
    await this.domain.table('time_entries').put(entry.id, entry);
    await this.setActiveTimer(null);
    return { ms: settlement.ms, entry };
  }

  private async setActiveTimer(timer: ActiveTimerRecord | null): Promise<void> {
    const global = this.domain.global.get();
    await this.domain.global.set({ ...global, activeTimer: timer });
  }

  // ── ideas ────────────────────────────────────────────────────────────────

  async upsertIdea(input: IdeaInput): Promise<IdeaRecord> {
    const ideas = this.domain.table('ideas');
    const existing = input.id !== undefined ? ideas.get(input.id) : undefined;
    if (existing === undefined) {
      const created = blankIdea(input.title);
      const next: IdeaRecord = {
        ...created,
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      };
      await ideas.put(next.id, next);
      return next;
    }
    const next: IdeaRecord = {
      ...existing,
      title: input.title,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    await ideas.put(next.id, next);
    return next;
  }

  private async mutateIdea(
    id: string,
    mutate: (idea: IdeaRecord) => IdeaRecord,
  ): Promise<IdeaRecord> {
    const ideas = this.domain.table('ideas');
    const idea = ideas.get(id);
    if (idea === undefined) throw new Error(`idea '${id}' does not exist`);
    const next = mutate(idea);
    await ideas.put(id, next);
    return next;
  }

  async completeIdea(id: string): Promise<IdeaRecord> {
    return this.mutateIdea(id, (idea) => completeIdea(idea));
  }

  async discardIdea(id: string): Promise<IdeaRecord> {
    return this.mutateIdea(id, (idea) => discardIdea(idea));
  }

  async reopenIdea(id: string): Promise<IdeaRecord> {
    return this.mutateIdea(id, (idea) => reopenIdea(idea));
  }

  async appendIdeaNote(id: string, text: string): Promise<IdeaRecord> {
    return this.mutateIdea(id, (idea) => appendIdeaEntry(idea, text));
  }

  async closeIdea(
    id: string,
    result: 'validated' | 'invalidated' | 'partial',
    text?: string,
  ): Promise<IdeaRecord> {
    return this.mutateIdea(id, (idea) => closeIdeaWithVerdict(idea, result, text));
  }

  /** Upgrade an idea to a dedicated project and start its validation. */
  async upgradeIdeaToProject(
    id: string,
    projectId: string,
    validationGoal?: string,
  ): Promise<IdeaRecord> {
    const projects = this.domain.table('projects');
    if (projects.get(projectId) === undefined) {
      throw new Error(`project '${projectId}' does not exist`);
    }
    return this.mutateIdea(id, (idea) => upgradeIdeaToProject(idea, projectId, validationGoal));
  }

  // ── follow-ups ───────────────────────────────────────────────────────────

  async upsertFollowUp(input: FollowUpInput): Promise<FollowUpRecord> {
    const rows = this.domain.table('follow_ups');
    const existing = input.id !== undefined ? rows.get(input.id) : undefined;
    if (existing === undefined) {
      const base = blankFollowUp(input.title);
      const next: FollowUpRecord = {
        ...base,
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.nextFollowUpDay !== undefined ? { nextFollowUpDay: input.nextFollowUpDay } : {}),
      };
      await rows.put(next.id, next);
      return next;
    }
    const next: FollowUpRecord = {
      ...existing,
      title: input.title,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.nextFollowUpDay !== undefined ? { nextFollowUpDay: input.nextFollowUpDay } : {}),
    };
    await rows.put(next.id, next);
    return next;
  }

  async resolveFollowUp(id: string): Promise<FollowUpRecord> {
    const rows = this.domain.table('follow_ups');
    const row = rows.get(id);
    if (row === undefined) throw new Error(`follow-up '${id}' does not exist`);
    const next = resolveFollowUp(row);
    await rows.put(id, next);
    return next;
  }

  async reopenFollowUp(id: string): Promise<FollowUpRecord> {
    const rows = this.domain.table('follow_ups');
    const row = rows.get(id);
    if (row === undefined) throw new Error(`follow-up '${id}' does not exist`);
    const next = reopenFollowUp(row);
    await rows.put(id, next);
    return next;
  }

  async appendFollowUpNote(id: string, text: string): Promise<FollowUpRecord> {
    const rows = this.domain.table('follow_ups');
    const row = rows.get(id);
    if (row === undefined) throw new Error(`follow-up '${id}' does not exist`);
    const next = appendFollowUpEntry(row, text);
    await rows.put(id, next);
    return next;
  }

  /** Follow-ups whose check-in day has arrived. */
  dueFollowUps(now = Date.now()): FollowUpRecord[] {
    return this.listFollowUps().filter((f) => isFollowUpDue(f, now));
  }

  // ── day boundary ─────────────────────────────────────────────────────────

  /**
   * End the day: work that was due today and is still open moves to tomorrow.
   * Returns the tasks that were rolled over.
   */
  async finishDay(now = Date.now()): Promise<TaskRecord[]> {
    const day = localDate(now);
    const tomorrow = addDays(day, 1);
    const tasks = this.domain.table('tasks');
    const rolled: TaskRecord[] = [];
    for (const [, task] of tasks.entries()) {
      if (task.isDone) continue;
      if (task.parentTaskId !== undefined) continue;
      if (task.dueDay !== day) continue;
      const next = { ...task, dueDay: tomorrow };
      await tasks.put(task.id, next);
      rolled.push(next);
    }
    return rolled;
  }
}

/** The epoch ms of the end of a local calendar day. */
function endOfDay(day: string): number {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}
