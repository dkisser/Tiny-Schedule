import type { TaskRecord, TimeEntryRecord } from './schema.ts';

/**
 * A task plus the time figures derived from the `time_entries` table.
 *
 * The domain keeps one truth for time: the entries. `timeSpent` and
 * `timeSpentOnDay` are projections of those rows, computed on read, so a
 * task and its measurements can never disagree.
 */
export interface TaskView extends TaskRecord {
  /** Total measured time in ms. */
  timeSpent: number;
  /** Measured time per local day (YYYY-MM-DD → ms). */
  timeSpentOnDay: Record<string, number>;
  /** The task's own measured intervals, oldest first. */
  timeEntries: TimeEntryRecord[];
}

/** Filters accepted by the task query. Every field is optional; omitted means "no bound". */
export interface TaskFilter {
  /** Completed at or after this day (YYYY-MM-DD). */
  doneFrom?: string;
  /** Completed at or before this day (YYYY-MM-DD). */
  doneTo?: string;
  /** Due at or after this day. */
  dueFrom?: string;
  /** Due at or before this day. */
  dueTo?: string;
  /** Belongs to this project. */
  projectId?: string;
  /** Carries every one of these tags. */
  tagIds?: string[];
  /** Completion state; omitted means "either". */
  isDone?: boolean;
  /** Quadrant cell, using the same derivation as the board. */
  quadrant?: QuadrantKey;
  /** Long-term pool membership. */
  longTerm?: boolean;
  /** Include subtasks (default: top-level only). */
  includeSubtasks?: boolean;
}

/** The four quadrant cells, from important × urgent. */
export type QuadrantKey =
  | 'important-urgent'
  | 'important-notUrgent'
  | 'notImportant-urgent'
  | 'notImportant-notUrgent';

export const QUADRANT_KEYS: readonly QuadrantKey[] = [
  'important-urgent',
  'important-notUrgent',
  'notImportant-urgent',
  'notImportant-notUrgent',
];

/** Human labels for the four cells. */
export const QUADRANT_LABELS: Record<QuadrantKey, string> = {
  'important-urgent': '重要且紧急',
  'important-notUrgent': '重要不紧急',
  'notImportant-urgent': '不重要但紧急',
  'notImportant-notUrgent': '不重要不紧急',
};
