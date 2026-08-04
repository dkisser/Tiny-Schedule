import { z } from 'zod';
import type { AppData, AppSettings, Task } from './models';

export const Ipc = {
  dataLoad: 'data:load',
  taskUpsert: 'task:upsert',
  taskDelete: 'task:delete',
  settingsUpdate: 'settings:update',
  finishDay: 'day:finish',
  timerSync: 'timer:sync',
  importRun: 'import:run',
  exportMarkdown: 'export:markdown',
  selectAvatar: 'avatar:select',
  aiRegistry: 'ai:registry',
  aiTestProvider: 'ai:testProvider',
  aiAnalyze: 'ai:analyze',
  aiChunk: 'ai:chunk',
  aiDone: 'ai:done',
  aiError: 'ai:error',
} as const;

export type IpcChannel = (typeof Ipc)[keyof typeof Ipc];

const TimeEntrySchema = z.object({
  date: z.string(),
  start: z.number(),
  end: z.number(),
  ms: z.number(),
});

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  projectId: z.string(),
  tagIds: z.array(z.string()),
  subTaskIds: z.array(z.string()),
  parentTaskId: z.string().optional(),
  isDone: z.boolean(),
  doneAt: z.number().optional(),
  dueDay: z.string().optional(),
  timeEstimate: z.number().min(0),
  timeSpent: z.number().min(0),
  timeSpentOnDay: z.record(z.string(), z.number()),
  timeEntries: z.array(TimeEntrySchema),
  notes: z.string(),
  created: z.number(),
});
export type TaskPayload = z.infer<typeof TaskSchema>;

const AiProviderSchema = z.object({
  id: z.string(),
  registryId: z.string(),
  apiKeyEncrypted: z.string(),
  baseUrl: z.string().optional(),
  model: z.string(),
  isDefault: z.boolean(),
});

const SettingsSchema = z.object({
  userName: z.string(),
  avatar: z.string().nullable(),
  theme: z.enum(['light', 'dark', 'system']),
  aiProviders: z.array(AiProviderSchema),
  aiPrompt: z.string(),
  autoAiAnalyzeOnFinishDay: z.boolean(),
});

const ActiveTimerSchema = z.object({
  taskId: z.string(),
  startedAt: z.number(),
  accumulatedMs: z.number(),
  isPaused: z.boolean(),
  pausedAt: z.number().optional(),
});

const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string().optional(),
  isArchived: z.boolean(),
  primaryColor: z.string().optional(),
});

const TagSchema = z.object({
  id: z.string(),
  title: z.string(),
  color: z.string().optional(),
});

export const AppDataSchema = z.object({
  version: z.literal(1),
  tasks: z.record(z.string(), TaskSchema),
  projects: z.record(z.string(), ProjectSchema),
  tags: z.record(z.string(), TagSchema),
  timeTracking: z.unknown(),
  notes: z.unknown(),
  planner: z.unknown(),
  metric: z.unknown(),
  boards: z.unknown(),
  misc: z.record(z.string(), z.unknown()),
  settings: SettingsSchema,
  activeTimer: ActiveTimerSchema.nullable(),
});

export const TaskDeleteReqSchema = z.object({ id: z.string().min(1) });

// Settings updates from the renderer carry PLAIN-TEXT api keys in a separate
// field; the main process encrypts them before persisting.
export const SettingsUpdateReqSchema = z
  .object({
    userName: z.string(),
    avatar: z.string().nullable(),
    theme: z.enum(['light', 'dark', 'system']),
    aiProviders: z.array(
      z.object({
        id: z.string(),
        registryId: z.string(),
        apiKey: z.string(), // plain text from renderer; encrypted in main
        baseUrl: z.string().optional(),
        model: z.string(),
        isDefault: z.boolean(),
      }),
    ),
    aiPrompt: z.string(),
    autoAiAnalyzeOnFinishDay: z.boolean(),
  })
  .partial();
export type SettingsUpdateReq = z.infer<typeof SettingsUpdateReqSchema>;

export const TimerSyncReqSchema = z.object({ timer: ActiveTimerSchema.nullable() });
export type TimerSyncReq = z.infer<typeof TimerSyncReqSchema>;

export const FinishDayReqSchema = z.object({ date: z.string() });
export type FinishDayReq = z.infer<typeof FinishDayReqSchema>;

export const ExportMarkdownReqSchema = z.object({
  mode: z.enum(['projectList', 'worklog']),
  projectId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ExportMarkdownReq = z.infer<typeof ExportMarkdownReqSchema>;

export const ExportMarkdownResultSchema = z.object({
  savedPath: z.string().nullable(),
  error: z.string().optional(),
});
export type ExportMarkdownResult = z.infer<typeof ExportMarkdownResultSchema>;

export const ImportRunResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  counts: z.object({ tasks: z.number(), projects: z.number(), tags: z.number() }).optional(),
});
export type ImportRunResult = z.infer<typeof ImportRunResultSchema>;

export const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  models: z.array(z.string()),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const AiTestReqSchema = z.object({ providerId: z.string() });
export const AiAnalyzeReqSchema = z.object({
  scope: z.enum(['today', 'week', 'project']),
  projectId: z.string().optional(),
  providerId: z.string().optional(),
});
export type AiAnalyzeReq = z.infer<typeof AiAnalyzeReqSchema>;

export const AiStreamEventSchema = z.object({
  requestId: z.string(),
  delta: z.string().optional(),
  full: z.string().optional(),
  error: z.string().optional(),
});
export type AiStreamEvent = z.infer<typeof AiStreamEventSchema>;

/** AppData sent to the renderer never contains real keys. */
export function maskDataForRenderer(data: AppData): AppData {
  return {
    ...data,
    settings: {
      ...data.settings,
      aiProviders: data.settings.aiProviders.map((p) => ({ ...p, apiKeyEncrypted: '' })),
    },
  };
}

export type { AppData, AppSettings, Task };
