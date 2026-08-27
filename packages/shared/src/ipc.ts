import { z } from 'zod';
import type { AppData, AppSettings, ChatSession, Task } from './models';

export const Ipc = {
  dataLoad: 'data:load',
  taskUpsert: 'task:upsert',
  taskDelete: 'task:delete',
  orderSet: 'order:set',
  projectCreate: 'project:create',
  projectUpdate: 'project:update',
  projectDelete: 'project:delete',
  tagCreate: 'tag:create',
  tagUpdate: 'tag:update',
  tagDelete: 'tag:delete',
  settingsUpdate: 'settings:update',
  finishDay: 'day:finish',
  timerSync: 'timer:sync',
  timerChanged: 'timer:changed',
  importRun: 'import:run',
  exportMarkdown: 'export:markdown',
  selectAvatar: 'avatar:select',
  aiRegistry: 'ai:registry',
  aiTestProvider: 'ai:testProvider',
  aiProviderKeyReveal: 'ai:providerKeyReveal',
  aiAnalyze: 'ai:analyze',
  aiChunk: 'ai:chunk',
  aiDone: 'ai:done',
  aiError: 'ai:error',
  chatSessionsList: 'chat:sessionsList',
  chatSessionCreate: 'chat:sessionCreate',
  chatSessionDelete: 'chat:sessionDelete',
  chatSend: 'chat:send',
  chatContinue: 'chat:continue',
  chatStop: 'chat:stop',
  chatChunk: 'chat:chunk',
  chatToolEvent: 'chat:toolEvent',
  chatStatus: 'chat:status',
  chatDone: 'chat:done',
  chatError: 'chat:error',
  uiNewTask: 'ui:newTask',
  appCheckUpdate: 'app:checkUpdate',
  appOpenExternal: 'app:openExternal',
  uiUpdateAvailable: 'ui:updateAvailable',
  notifyPhaseComplete: 'notify:phaseComplete',
  setAlwaysOnTopWindow: 'window:setAlwaysOnTop',
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
  projectTitle: z.string().optional(),
  tagSnapshots: z
    .record(z.string(), z.object({ title: z.string(), color: z.string().optional() }))
    .optional(),
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
  hasApiKey: z.boolean().optional(),
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
  // Defaults backfill legacy persisted settings that predate idle auto-pause.
  idlePauseEnabled: z.boolean().default(true),
  idlePauseMinutes: z.number().default(5),
});

const ActiveTimerSchema = z.object({
  taskId: z.string(),
  startedAt: z.number(),
  accumulatedMs: z.number(),
  isPaused: z.boolean(),
  pausedAt: z.number().optional(),
  sessionStartedAt: z.number().optional(),
  autoPausedBy: z.enum(['sleep', 'idle']).optional(),
  mode: z.enum(['free', 'pomodoro']).optional(),
  phase: z.enum(['focus', 'break']).optional(),
  phaseStartedAt: z.number().optional(),
  phaseAccumulatedMs: z.number().optional(),
  phaseDurationMs: z.number().optional(),
  cyclesCompleted: z.number().int().min(0).optional(),
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

export const OrderSetReqSchema = z.object({
  viewKey: z.string().min(1),
  ids: z.array(z.string()),
});
export type OrderSetReq = z.infer<typeof OrderSetReqSchema>;

export const ProjectCreateReqSchema = z.object({
  title: z.string().trim().min(1).max(100),
  icon: z.string().optional(),
  primaryColor: z.string().optional(),
});
export type ProjectCreateReq = z.infer<typeof ProjectCreateReqSchema>;

export const TagCreateReqSchema = z.object({
  title: z.string().trim().min(1).max(50),
  color: z.string().optional(),
});
export type TagCreateReq = z.infer<typeof TagCreateReqSchema>;

export const ProjectUpdateReqSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(100).optional(),
  // Explicit null clears the color; undefined leaves the existing one intact.
  primaryColor: z.string().nullable().optional(),
  // Archive hides the project from the sidebar but keeps its tasks in stats.
  isArchived: z.boolean().optional(),
});
export type ProjectUpdateReq = z.infer<typeof ProjectUpdateReqSchema>;

export const ProjectDeleteReqSchema = z.object({ id: z.string().min(1) });
export type ProjectDeleteReq = z.infer<typeof ProjectDeleteReqSchema>;

export const TagUpdateReqSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(50).optional(),
  color: z.string().optional(),
});
export type TagUpdateReq = z.infer<typeof TagUpdateReqSchema>;

export const TagDeleteReqSchema = z.object({ id: z.string().min(1) });
export type TagDeleteReq = z.infer<typeof TagDeleteReqSchema>;

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
    idlePauseEnabled: z.boolean(),
    idlePauseMinutes: z.number().int().min(1).max(1440),
  })
  .partial();
export type SettingsUpdateReq = z.infer<typeof SettingsUpdateReqSchema>;

export const TimerSyncReqSchema = z.object({ timer: ActiveTimerSchema.nullable() });
export type TimerSyncReq = z.infer<typeof TimerSyncReqSchema>;

/** Main -> renderer push after the main process changes the timer itself. */
export const TimerChangedEventSchema = ActiveTimerSchema.nullable();
export type TimerChangedEvent = z.infer<typeof TimerChangedEventSchema>;

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

export const CheckUpdateResultSchema = z.object({
  current: z.string(), // app.getVersion(), present even when offline
  hasUpdate: z.boolean(),
  latest: z.string().nullable(), // normalized (no v prefix)
  url: z.string().nullable(), // release page html_url
  notes: z.string().nullable(), // release notes, truncated
  error: z.string().optional(),
});
export type CheckUpdateResult = z.infer<typeof CheckUpdateResultSchema>;

export const OpenExternalReqSchema = z.object({ url: z.string().url() });
export type OpenExternalReq = z.infer<typeof OpenExternalReqSchema>;

export const NotifyPhaseCompleteReqSchema = z.object({
  phase: z.enum(['focus', 'break']),
  title: z.string().min(1),
  body: z.string().min(1),
});
export type NotifyPhaseCompleteReq = z.infer<typeof NotifyPhaseCompleteReqSchema>;

export const SetAlwaysOnTopWindowReqSchema = z.object({
  enabled: z.boolean(),
});
export type SetAlwaysOnTopWindowReq = z.infer<typeof SetAlwaysOnTopWindowReqSchema>;

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

export const ChatSessionCreateReqSchema = z.object({ providerId: z.string().optional() });
export type ChatSessionCreateReq = z.infer<typeof ChatSessionCreateReqSchema>;

export const ChatSessionDeleteReqSchema = z.object({ sessionId: z.string().min(1) });
export type ChatSessionDeleteReq = z.infer<typeof ChatSessionDeleteReqSchema>;

export const ChatSendReqSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().trim().min(1),
  providerId: z.string().optional(),
});
export type ChatSendReq = z.infer<typeof ChatSendReqSchema>;

export const ChatStopReqSchema = z.object({ sessionId: z.string().min(1) });
export type ChatStopReq = z.infer<typeof ChatStopReqSchema>;

export const ChatContinueReqSchema = z.object({ sessionId: z.string().min(1) });
export type ChatContinueReq = z.infer<typeof ChatContinueReqSchema>;

export const ChatChunkEventSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  delta: z.string(),
});
export type ChatChunkEvent = z.infer<typeof ChatChunkEventSchema>;

export const ChatToolEventSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  status: z.enum(['running', 'done', 'error']),
  args: z.unknown().optional(),
  resultSummary: z.string().optional(),
});
export type ChatToolEvent = z.infer<typeof ChatToolEventSchema>;

export const ChatStatusEventSchema = z.object({
  sessionId: z.string(),
  requestId: z.string().optional(),
  status: z.enum(['running', 'retrying', 'failed']),
  attempt: z.number().optional(),
  error: z.string().optional(),
});
export type ChatStatusEvent = z.infer<typeof ChatStatusEventSchema>;

export const ChatDoneEventSchema = z.object({ sessionId: z.string(), requestId: z.string() });
export type ChatDoneEvent = z.infer<typeof ChatDoneEventSchema>;

export const ChatErrorEventSchema = z.object({
  sessionId: z.string(),
  requestId: z.string().optional(),
  error: z.string(),
});
export type ChatErrorEvent = z.infer<typeof ChatErrorEventSchema>;

/** Main -> renderer chat push channels; separate from ai* event channels. */
export const IpcChatEventChannels = [
  Ipc.chatChunk,
  Ipc.chatToolEvent,
  Ipc.chatStatus,
  Ipc.chatDone,
  Ipc.chatError,
] as const;

export type ChatEvent =
  | { channel: typeof Ipc.chatChunk; payload: ChatChunkEvent }
  | { channel: typeof Ipc.chatToolEvent; payload: ChatToolEvent }
  | { channel: typeof Ipc.chatStatus; payload: ChatStatusEvent }
  | { channel: typeof Ipc.chatDone; payload: ChatDoneEvent }
  | { channel: typeof Ipc.chatError; payload: ChatErrorEvent };

// Single source of truth for invoke channels: channel name + request schema +
// response type. Adding an entry here forces both ends to implement it at
// compile time (IpcInvokeHandlers in main, RendererApi in preload).
// Event channels (aiChunk/aiDone/aiError) are main->renderer only and stay
// outside this contract; see IpcEventChannels.
export const IpcInvokeContract = {
  dataLoad: { ch: Ipc.dataLoad, res: null as unknown as AppData },
  taskUpsert: { ch: Ipc.taskUpsert, req: TaskSchema, res: null as unknown as AppData },
  taskDelete: { ch: Ipc.taskDelete, req: TaskDeleteReqSchema, res: null as unknown as AppData },
  orderSet: { ch: Ipc.orderSet, req: OrderSetReqSchema, res: null as unknown as void },
  projectCreate: {
    ch: Ipc.projectCreate,
    req: ProjectCreateReqSchema,
    res: null as unknown as AppData,
  },
  projectUpdate: {
    ch: Ipc.projectUpdate,
    req: ProjectUpdateReqSchema,
    res: null as unknown as AppData,
  },
  projectDelete: {
    ch: Ipc.projectDelete,
    req: ProjectDeleteReqSchema,
    res: null as unknown as AppData,
  },
  tagCreate: { ch: Ipc.tagCreate, req: TagCreateReqSchema, res: null as unknown as AppData },
  tagUpdate: { ch: Ipc.tagUpdate, req: TagUpdateReqSchema, res: null as unknown as AppData },
  tagDelete: { ch: Ipc.tagDelete, req: TagDeleteReqSchema, res: null as unknown as AppData },
  settingsUpdate: {
    ch: Ipc.settingsUpdate,
    req: SettingsUpdateReqSchema,
    res: null as unknown as AppData,
  },
  finishDay: { ch: Ipc.finishDay, req: FinishDayReqSchema, res: null as unknown as AppData },
  timerSync: { ch: Ipc.timerSync, req: TimerSyncReqSchema, res: null as unknown as void },
  importRun: { ch: Ipc.importRun, res: null as unknown as ImportRunResult },
  exportMarkdown: {
    ch: Ipc.exportMarkdown,
    req: ExportMarkdownReqSchema,
    res: null as unknown as ExportMarkdownResult,
  },
  selectAvatar: { ch: Ipc.selectAvatar, res: null as unknown as string | null },
  aiRegistry: { ch: Ipc.aiRegistry, res: null as unknown as ProviderInfo[] },
  aiTestProvider: {
    ch: Ipc.aiTestProvider,
    req: AiTestReqSchema,
    res: null as unknown as { ok: boolean; error?: string },
  },
  aiProviderKeyReveal: {
    ch: Ipc.aiProviderKeyReveal,
    req: AiTestReqSchema,
    res: null as unknown as { apiKey: string },
  },
  aiAnalyze: {
    ch: Ipc.aiAnalyze,
    req: AiAnalyzeReqSchema,
    res: null as unknown as { requestId: string },
  },
  chatSessionsList: {
    ch: Ipc.chatSessionsList,
    res: null as unknown as ChatSession[],
  },
  chatSessionCreate: {
    ch: Ipc.chatSessionCreate,
    req: ChatSessionCreateReqSchema,
    res: null as unknown as ChatSession,
  },
  chatSessionDelete: {
    ch: Ipc.chatSessionDelete,
    req: ChatSessionDeleteReqSchema,
    res: null as unknown as ChatSession[],
  },
  chatSend: {
    ch: Ipc.chatSend,
    req: ChatSendReqSchema,
    res: null as unknown as { requestId: string } | { error: string },
  },
  chatContinue: {
    ch: Ipc.chatContinue,
    req: ChatContinueReqSchema,
    res: null as unknown as { requestId: string } | { error: string },
  },
  chatStop: { ch: Ipc.chatStop, req: ChatStopReqSchema, res: null as unknown as void },
  appCheckUpdate: { ch: Ipc.appCheckUpdate, res: null as unknown as CheckUpdateResult },
  appOpenExternal: {
    ch: Ipc.appOpenExternal,
    req: OpenExternalReqSchema,
    res: null as unknown as void,
  },
  notifyPhaseComplete: {
    ch: Ipc.notifyPhaseComplete,
    req: NotifyPhaseCompleteReqSchema,
    res: null as unknown as void,
  },
  setAlwaysOnTopWindow: {
    ch: Ipc.setAlwaysOnTopWindow,
    req: SetAlwaysOnTopWindowReqSchema,
    res: null as unknown as void,
  },
} as const;

export type IpcInvokeKey = keyof typeof IpcInvokeContract;

export type IpcRes<K extends IpcInvokeKey> = (typeof IpcInvokeContract)[K]['res'];

/** Renderer-facing signature: zero-arg when the channel has no request schema. */
export type IpcInvokeFn<K extends IpcInvokeKey> = (typeof IpcInvokeContract)[K] extends {
  req: infer S;
}
  ? S extends z.ZodType
    ? (req: z.infer<S>) => Promise<IpcRes<K>>
    : never
  : () => Promise<IpcRes<K>>;

/** Main-process handler signature mirroring IpcInvokeFn. */
export type IpcHandlerFn<K extends IpcInvokeKey> = (typeof IpcInvokeContract)[K] extends {
  req: infer S;
}
  ? S extends z.ZodType
    ? (req: z.infer<S>) => Promise<IpcRes<K>> | IpcRes<K>
    : never
  : () => Promise<IpcRes<K>> | IpcRes<K>;

export type IpcInvokeHandlers = {
  [K in IpcInvokeKey]: IpcHandlerFn<K>;
};

/** Main -> renderer push channels; preload subscribes, main sends. */
export const IpcEventChannels = [Ipc.aiChunk, Ipc.aiDone, Ipc.aiError] as const;

/** UI push channels (hotkeys, timer updates); separate so ai/chat subscribers stay typed. */
export const IpcUiEventChannels = [Ipc.uiNewTask, Ipc.uiUpdateAvailable, Ipc.timerChanged] as const;

/** AppData sent to the renderer never contains real keys. */
export function maskDataForRenderer(data: AppData): AppData {
  return {
    ...data,
    settings: {
      ...data.settings,
      aiProviders: data.settings.aiProviders.map((p) => ({
        ...p,
        apiKeyEncrypted: '',
        hasApiKey: p.apiKeyEncrypted !== '',
      })),
    },
  };
}

export type { AppData, AppSettings, Task };
