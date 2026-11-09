/**
 * Record schemas for the plugin's storage domain.
 *
 * These are the durable boundary: every write that reaches the medium is
 * validated by the schema registered for its table, so a malformed record
 * never lands on disk. The shapes mirror the retired Tiny-Schedule app's
 * domain model, minus the fields that are now derived (per-task time totals
 * live in `time_entries` and are aggregated on read).
 */
import { z } from 'zod';

/** YYYY-MM-DD day string. */
export const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A project's color: `null` means "cleared by the user", `undefined` means "never set". */
const ProjectColorSchema = z.string().nullable().optional();

export const ProjectRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  icon: z.string().optional(),
  isArchived: z.boolean(),
  primaryColor: ProjectColorSchema,
});

export const TagRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  color: z.string().optional(),
});

/** One measured work interval. The per-day and per-task totals are derived from these rows. */
export const TimeEntryRecordSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  /** Local day the interval belongs to (YYYY-MM-DD). */
  date: DaySchema,
  /** Epoch ms. */
  start: z.number(),
  /** Epoch ms. */
  end: z.number(),
  /** Duration in ms. */
  ms: z.number(),
});

export const TaskRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  projectId: z.string(),
  /** Display-name snapshot; older rows may fall back to the live project. */
  projectTitle: z.string().optional(),
  tagIds: z.array(z.string()),
  /** Display-name snapshots for tags that may since be gone. */
  tagSnapshots: z
    .record(z.string(), z.object({ title: z.string(), color: z.string().optional() }))
    .optional(),
  subTaskIds: z.array(z.string()),
  parentTaskId: z.string().optional(),
  isDone: z.boolean(),
  /** Epoch ms of completion. */
  doneAt: z.number().optional(),
  /** YYYY-MM-DD the task is due on. */
  dueDay: DaySchema.optional(),
  /** Stored attribute — importance is a field, urgency is derived. */
  isImportant: z.boolean(),
  /** Estimated effort in ms; 0 means unestimated. */
  timeEstimate: z.number().min(0),
  notes: z.string(),
  /** Epoch ms. */
  created: z.number(),
});

export const IDEA_STATUSES = [
  'open',
  'done',
  'discarded',
  'converted',
  'incubating',
  'closed',
] as const;

export const IdeaStatusSchema = z.enum(IDEA_STATUSES);

export const IdeaEntrySchema = z.object({
  id: z.string().min(1),
  /** Epoch ms. */
  createdAt: z.number(),
  text: z.string(),
});

export const IdeaVerdictSchema = z.object({
  result: z.enum(['validated', 'invalidated', 'partial']),
  text: z.string().optional(),
  /** Epoch ms. */
  closedAt: z.number(),
});

export const IdeaRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string(),
  /** Epoch ms. */
  createdAt: z.number(),
  status: IdeaStatusSchema,
  /** Epoch ms; set when the idea became a task. */
  convertedAt: z.number().optional(),
  convertedTaskId: z.string().optional(),
  /** The dedicated project an incubating idea is validated against. */
  projectId: z.string().optional(),
  /** What "validated" means for this idea. */
  validationGoal: z.string().optional(),
  /** Evolution log, appended in createdAt order. */
  timeline: z.array(IdeaEntrySchema).optional(),
  /** The conclusion, present once the idea is closed. */
  verdict: IdeaVerdictSchema.optional(),
  /** Epoch ms; when the idea was upgraded to a project. */
  incubatedAt: z.number().optional(),
  /** Epoch ms; when the idea reached a resolved state. */
  resolvedAt: z.number().optional(),
});

export const FollowUpEntrySchema = z.object({
  id: z.string().min(1),
  /** Epoch ms. */
  at: z.number(),
  text: z.string(),
});

export const FollowUpRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string(),
  entries: z.array(FollowUpEntrySchema),
  /** Epoch ms; when the wait started. */
  createdAt: z.number(),
  /** YYYY-MM-DD the next check-in is due. */
  nextFollowUpDay: DaySchema.optional(),
  isResolved: z.boolean(),
  resolvedAt: z.number().optional(),
});

/** Manual drag order for one view; task ids in display order. */
export const TaskOrderRecordSchema = z.object({
  viewKey: z.string().min(1),
  ids: z.array(z.string()),
});

/** The single running timer. dsh has no sleep/idle watcher, so nothing auto-pauses it. */
export const ActiveTimerRecordSchema = z.object({
  taskId: z.string().min(1),
  /** Epoch ms. */
  startedAt: z.number(),
  accumulatedMs: z.number(),
  isPaused: z.boolean(),
  pausedAt: z.number().optional(),
  sessionStartedAt: z.number().optional(),
  mode: z.enum(['free', 'pomodoro']).optional(),
  phase: z.enum(['focus', 'break']).optional(),
  phaseStartedAt: z.number().optional(),
  phaseAccumulatedMs: z.number().optional(),
  phaseDurationMs: z.number().optional(),
  cyclesCompleted: z.number().int().min(0).optional(),
  focusAccumulatedMs: z.number().optional(),
});

export const SettingsRecordSchema = z.object({
  /** dueDay within this many days counts as urgent (the quadrant's horizontal axis). */
  urgencyThresholdDays: z.number().int().min(0),
  /** dueDay beyond this many days belongs to the long-term pool. */
  longTermHorizonDays: z.number().int().min(1),
});

/**
 * The domain's global slot. The schema must not accept `null`: the medium
 * stores `null` as the "never written" sentinel, so a nullable global could
 * not round-trip.
 */
export const GlobalStateSchema = z.object({
  settings: SettingsRecordSchema,
  activeTimer: ActiveTimerRecordSchema.nullable(),
});

export const DEFAULT_SETTINGS: SettingsRecord = {
  urgencyThresholdDays: 2,
  longTermHorizonDays: 14,
};

export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;
export type TagRecord = z.infer<typeof TagRecordSchema>;
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export type TimeEntryRecord = z.infer<typeof TimeEntryRecordSchema>;
export type IdeaRecord = z.infer<typeof IdeaRecordSchema>;
export type IdeaStatus = z.infer<typeof IdeaStatusSchema>;
export type IdeaEntry = z.infer<typeof IdeaEntrySchema>;
export type IdeaVerdict = z.infer<typeof IdeaVerdictSchema>;
export type FollowUpRecord = z.infer<typeof FollowUpRecordSchema>;
export type FollowUpEntry = z.infer<typeof FollowUpEntrySchema>;
export type TaskOrderRecord = z.infer<typeof TaskOrderRecordSchema>;
export type ActiveTimerRecord = z.infer<typeof ActiveTimerRecordSchema>;
export type SettingsRecord = z.infer<typeof SettingsRecordSchema>;
export type GlobalState = z.infer<typeof GlobalStateSchema>;
