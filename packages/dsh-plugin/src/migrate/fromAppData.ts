/**
 * The one-shot migration from the retired desktop app.
 *
 * Reads the old `data.json` (read-only — the old file is never touched) and
 * produces the storage unit the plugin's domain expects. The legacy Electron
 * blobs are dropped on purpose: they were never modelled, and carrying them
 * forward would only preserve debt.
 */
import type {
  ActiveTimerRecord,
  FollowUpRecord,
  GlobalState,
  IdeaRecord,
  IdeaStatus,
  ProjectRecord,
  TagRecord,
  TaskOrderRecord,
  TaskRecord,
  TimeEntryRecord,
} from '../domain/schema.ts';
import { DEFAULT_SETTINGS } from '../domain/schema.ts';

/** The unit document the json backend reads and writes. */
export interface MigratedUnit {
  unit: { name: string; version: number };
  global: GlobalState;
  tables: {
    tasks: Record<string, TaskRecord>;
    projects: Record<string, ProjectRecord>;
    tags: Record<string, TagRecord>;
    time_entries: Record<string, TimeEntryRecord>;
    ideas: Record<string, IdeaRecord>;
    follow_ups: Record<string, FollowUpRecord>;
    task_order: Record<string, TaskOrderRecord>;
  };
}

export interface MigrationStats {
  tasks: number;
  projects: number;
  tags: number;
  ideas: number;
  followUps: number;
  timeEntries: number;
  /** Legacy sections that were intentionally dropped, with their byte size. */
  dropped: Record<string, number>;
}

export interface MigrationResult {
  unit: MigratedUnit;
  stats: MigrationStats;
}

const UNIT_NAME = 'task_tracker';
const UNIT_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The old data.json shape, read defensively. */
export interface LegacyAppData {
  tasks: Record<string, unknown>;
  projects: Record<string, unknown>;
  tags: Record<string, unknown>;
  ideas: Record<string, unknown>;
  followUps: Record<string, unknown>;
  misc: Record<string, unknown>;
  settings: Record<string, unknown>;
  activeTimer: unknown;
  [key: string]: unknown;
}

/**
 * Read the old application data.
 * @param raw - The parsed JSON document.
 * @returns the legacy shape, or a throw when the document is not usable.
 */
export function readLegacyAppData(raw: unknown): LegacyAppData {
  if (!isRecord(raw)) throw new Error('the backup is not a JSON object');
  const data = raw as LegacyAppData;
  if (!isRecord(data.tasks)) throw new Error('the backup has no tasks section');
  return data;
}

/**
 * Convert the legacy application data into the plugin's storage unit.
 * @param raw - The parsed legacy JSON document.
 * @returns the unit document and what was migrated.
 */
export function migrateAppData(raw: unknown): MigrationResult {
  const data = readLegacyAppData(raw);
  const dropped: Record<string, number> = {};
  for (const key of [
    'timeTracking',
    'notes',
    'planner',
    'metric',
    'boards',
    'scheduledTasks',
    'runs',
  ]) {
    const value = data[key];
    if (value !== undefined && value !== null) dropped[key] = JSON.stringify(value).length;
  }

  const projects: Record<string, ProjectRecord> = {};
  for (const [id, value] of Object.entries(recordsOf(data.projects))) {
    if (!isRecord(value)) continue;
    projects[id] = {
      id,
      title: str(value.title, id),
      ...(typeof value.icon === 'string' ? { icon: value.icon } : {}),
      isArchived: bool(value.isArchived),
      ...(value.primaryColor === null || typeof value.primaryColor === 'string'
        ? { primaryColor: value.primaryColor as string | null | undefined }
        : {}),
    };
  }

  const tags: Record<string, TagRecord> = {};
  for (const [id, value] of Object.entries(recordsOf(data.tags))) {
    if (!isRecord(value)) continue;
    tags[id] = {
      id,
      title: str(value.title, id),
      ...(typeof value.color === 'string' ? { color: value.color } : {}),
    };
  }

  const tasks: Record<string, TaskRecord> = {};
  const timeEntries: Record<string, TimeEntryRecord> = {};
  for (const [id, value] of Object.entries(recordsOf(data.tasks))) {
    if (!isRecord(value)) continue;
    const task: TaskRecord = {
      id,
      title: str(value.title),
      projectId: str(value.projectId, 'INBOX_PROJECT'),
      ...(typeof value.projectTitle === 'string' ? { projectTitle: value.projectTitle } : {}),
      tagIds: strArray(value.tagIds),
      ...(isRecord(value.tagSnapshots)
        ? { tagSnapshots: value.tagSnapshots as TaskRecord['tagSnapshots'] }
        : {}),
      subTaskIds: strArray(value.subTaskIds),
      ...(typeof value.parentTaskId === 'string' ? { parentTaskId: value.parentTaskId } : {}),
      isDone: bool(value.isDone),
      ...(typeof value.doneAt === 'number' ? { doneAt: value.doneAt } : {}),
      ...(typeof value.dueDay === 'string' ? { dueDay: value.dueDay } : {}),
      isImportant: bool(value.isImportant),
      timeEstimate: Math.max(0, num(value.timeEstimate)),
      notes: str(value.notes),
      created: num(value.created, Date.now()),
    };
    tasks[id] = task;
    collectTimeEntries(id, value, timeEntries);
  }

  const ideas: Record<string, IdeaRecord> = {};
  for (const [id, value] of Object.entries(recordsOf(data.ideas))) {
    if (!isRecord(value)) continue;
    const convertedAt = typeof value.convertedAt === 'number' ? value.convertedAt : undefined;
    const status =
      (typeof value.status === 'string' ? value.status : undefined) ??
      (convertedAt !== undefined ? 'converted' : 'open');
    ideas[id] = {
      id,
      title: str(value.title, id),
      notes: str(value.notes),
      createdAt: num(value.createdAt, Date.now()),
      status: status as IdeaStatus,
      ...(convertedAt !== undefined ? { convertedAt } : {}),
      ...(typeof value.convertedTaskId === 'string'
        ? { convertedTaskId: value.convertedTaskId }
        : {}),
      ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
      ...(typeof value.validationGoal === 'string' ? { validationGoal: value.validationGoal } : {}),
      ...(Array.isArray(value.timeline)
        ? { timeline: value.timeline as IdeaRecord['timeline'] }
        : {}),
      ...(isRecord(value.verdict) ? { verdict: value.verdict as IdeaRecord['verdict'] } : {}),
      ...(typeof value.incubatedAt === 'number' ? { incubatedAt: value.incubatedAt } : {}),
      ...(typeof value.resolvedAt === 'number' ? { resolvedAt: value.resolvedAt } : {}),
    };
  }

  const followUps: Record<string, FollowUpRecord> = {};
  for (const [id, value] of Object.entries(recordsOf(data.followUps))) {
    if (!isRecord(value)) continue;
    followUps[id] = {
      id,
      title: str(value.title, id),
      notes: str(value.notes),
      entries: Array.isArray(value.entries) ? (value.entries as FollowUpRecord['entries']) : [],
      createdAt: num(value.createdAt, Date.now()),
      ...(typeof value.nextFollowUpDay === 'string'
        ? { nextFollowUpDay: value.nextFollowUpDay }
        : {}),
      isResolved: bool(value.isResolved),
      ...(typeof value.resolvedAt === 'number' ? { resolvedAt: value.resolvedAt } : {}),
    };
  }

  const taskOrder: Record<string, TaskOrderRecord> = {};
  const misc = recordsOf(data.misc);
  const rawOrder = recordsOf(misc.taskOrder);
  for (const [viewKey, ids] of Object.entries(rawOrder)) {
    if (Array.isArray(ids)) {
      taskOrder[viewKey] = { viewKey, ids: strArray(ids) };
    }
  }

  const settings = recordsOf(data.settings);
  const urgency = num(settings.urgencyThresholdDays, DEFAULT_SETTINGS.urgencyThresholdDays);

  const global: GlobalState = {
    settings: {
      urgencyThresholdDays: Math.max(0, Math.round(urgency)),
      longTermHorizonDays: DEFAULT_SETTINGS.longTermHorizonDays,
    },
    activeTimer: isRecord(data.activeTimer) ? (data.activeTimer as ActiveTimerRecord) : null,
  };

  return {
    unit: {
      unit: { name: UNIT_NAME, version: UNIT_VERSION },
      global,
      tables: {
        tasks,
        projects,
        tags,
        time_entries: timeEntries,
        ideas,
        follow_ups: followUps,
        task_order: taskOrder,
      },
    },
    stats: {
      tasks: Object.keys(tasks).length,
      projects: Object.keys(projects).length,
      tags: Object.keys(tags).length,
      ideas: Object.keys(ideas).length,
      followUps: Object.keys(followUps).length,
      timeEntries: Object.keys(timeEntries).length,
      dropped,
    },
  };
}

/**
 * Turn one legacy task's time records into entry rows.
 *
 * `timeSpentOnDay` is the aggregate the old app's worklog and projections
 * used, so it is the source of truth; the raw `timeEntries` only sharpen the
 * start and end of a day whose single interval matches the aggregate.
 */
function collectTimeEntries(
  taskId: string,
  value: Record<string, unknown>,
  out: Record<string, TimeEntryRecord>,
): void {
  const perDay = recordsOf(value.timeSpentOnDay);
  const rawEntries = Array.isArray(value.timeEntries) ? value.timeEntries.filter(isRecord) : [];
  let index = 0;
  for (const [date, ms] of Object.entries(perDay)) {
    const total = num(ms);
    if (total <= 0) continue;
    const matching = rawEntries.filter((entry) => entry.date === date);
    const exact = matching.length === 1 ? matching[0] : undefined;
    const id = `e_mig_${taskId}_${index++}`;
    if (exact !== undefined && num(exact.ms) === total) {
      out[id] = {
        id,
        taskId,
        date,
        start: num(exact.start),
        end: num(exact.end),
        ms: total,
      };
    } else {
      const end = endOfDay(date);
      out[id] = { id, taskId, date, start: end - total, end, ms: total };
    }
  }
}

function endOfDay(day: string): number {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

/** Serialize the unit the way the json backend writes it. */
export function serializeUnit(unit: MigratedUnit): string {
  return `${JSON.stringify(
    {
      unit: unit.unit,
      global: unit.global,
      tables: unit.tables,
    },
    null,
    2,
  )}\n`;
}
