import { z } from 'zod';
import type { AppData, ChatSession } from '../domain/appData';
import { FollowUpSchema } from '../domain/followUp';
import { PROJECT_TITLE_MAX_LENGTH } from '../domain/project';
import { ActiveTimerSchema, TaskSchema } from '../domain/task';

/**
 * 项目名的 wire 约束。必须与 domain 侧强制的常量同源：schema 放宽而 service
 * 截断的话，用户会看到"保存成功"但落库的是被静默砍掉的名字，且两个同前缀的
 * 名字会撞成同名项目。
 */
const projectTitleSchema = z.string().trim().min(1).max(PROJECT_TITLE_MAX_LENGTH);

export const Ipc = {
  dataLoad: 'data:load',
  taskUpsert: 'task:upsert',
  taskDelete: 'task:delete',
  followUpUpsert: 'followUp:upsert',
  followUpDelete: 'followUp:delete',
  followUpResolve: 'followUp:resolve',
  followUpReopen: 'followUp:reopen',
  ideaUpsert: 'idea:upsert',
  ideaDelete: 'idea:delete',
  ideaComplete: 'idea:complete',
  ideaDiscard: 'idea:discard',
  ideaReopen: 'idea:reopen',
  ideaConvertToTask: 'idea:convertToTask',
  ideaUpgradeToProject: 'idea:upgradeToProject',
  ideaAddEntry: 'idea:addEntry',
  ideaDeleteEntry: 'idea:deleteEntry',
  ideaUpdateEntry: 'idea:updateEntry',
  ideaCloseWithVerdict: 'idea:closeWithVerdict',
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
  timingStop: 'timing:stop',
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
  calendarAddTask: 'calendar:addTask',
  appCheckUpdate: 'app:checkUpdate',
  appOpenExternal: 'app:openExternal',
  uiUpdateAvailable: 'ui:updateAvailable',
  storeWritable: 'store:writable',
  notifyPhaseComplete: 'notify:phaseComplete',
  setAlwaysOnTopWindow: 'window:setAlwaysOnTop',
} as const;

export type IpcChannel = (typeof Ipc)[keyof typeof Ipc];

export const TaskDeleteReqSchema = z.object({ id: z.string().min(1) });

export const FollowUpDeleteReqSchema = z.object({ id: z.string().min(1) });

export const IdeaDeleteReqSchema = z.object({ id: z.string().min(1) });

/**
 * ideaUpsert 收紧后的编辑形状：只剩非状态字段。
 *
 * 状态与一切转移结果（status/convertedAt/convertedTaskId/projectId/verdict/
 * incubatedAt/resolvedAt）都不在这里——它们只能由下面的意图命令写入。这正是
 * ADR-0003 想要的：读契约的人不必再自己推断"哪些字段能改"。
 *
 * 注意这是**请求** schema，不是持久化 schema：data.json 里的想法仍按完整的
 * IdeaSchema 校验，格式不变。
 */
export const IdeaEditSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  notes: z.string(),
  createdAt: z.number(),
  /**
   * `undefined` = 不动这个字段，`null` = 清空。两者必须分开：主进程把 edit
   * 实现成"只覆盖调用方真正设置的键"，否则渲染进程每次都显式带上
   * `validationGoal: undefined` 就会把已存的值抹掉；而把清空也编码成
   * undefined 的话，合并就退化成覆盖，同一个 bug 换个方向再犯一次。
   */
  validationGoal: z.string().nullable().optional(),
  // No `timeline` here on purpose. The log is a list the renderer mutates, and
  // a field edit carrying the renderer's whole snapshot of it rolled the list
  // back whenever a debounced commit landed after an entry was added. It has
  // its own commands: ideaAddEntry / ideaUpdateEntry / ideaDeleteEntry.
});
export type IdeaEdit = z.infer<typeof IdeaEditSchema>;

/**
 * IdeaEditSchema 里可被显式置 null 清空的字段。
 *
 * 新增可空字段时**必须**同时登记在这里：主进程的 edit() 把 null 一律当作
 * "清空"跳过合并，再按这张表把键整个摘掉。漏登记的话该字段会静默变成
 * 不可清空——而"清空验证目标"的 UI 路径恰恰就是发一个 null。
 */
export const IDEA_CLEARABLE_FIELDS = ['validationGoal'] as const;

// ---------------------------------------------------------------------------
// 想法的意图命令
//
// 写契约不再说"任何形状的想法都能 upsert"，而是把领域语言（完成/废弃/重新打开/
// 转为任务/升级为项目/给出结论）直接说成通道。终态规则因此从"需要被校验"变成
// "契约里根本不存在这个操作"——主进程侧的守卫只对下面这组命令生效。
// ---------------------------------------------------------------------------

/** 想法终态规则拒绝时返回的判别联合，沿用契约既有的 { ok, error } 惯例。 */
/**
 * A refusal is a normal return value, not an exception (ADR-0003).
 *
 * WRITE_REFUSED rides in the same branch as the domain rejections because the
 * caller's response is identical: nothing happened, so the dialog stays open
 * and the message explains why. That is the point of putting it here rather
 * than in a separate flag — a separate flag is one more thing a caller can
 * forget to check, and forgetting is invisible.
 */
export type IdeaCommandRejection = { ok: false; error: string };

/**
 * 跟进状态命令的结果。刻意不用 `AppData | null`：渲染进程把返回值整份当成
 * 数据集采纳，null 会让 App 停在"加载中"且无从区分"这条跟进没了"和"还没加载"。
 */
export type FollowUpCommandResult =
  | { ok: true; data: AppData }
  | { ok: false; error: 'FOLLOW_UP_NOT_FOUND' | 'WRITE_REFUSED' };

export const IdeaIdReqSchema = z.object({ id: z.string().min(1) });
export type IdeaIdReq = z.infer<typeof IdeaIdReqSchema>;

export const IdeaConvertToTaskReqSchema = z.object({
  id: z.string().min(1),
  /** 覆盖转换后任务的标题；缺省沿用想法标题。 */
  title: z.string().trim().min(1).optional(),
});
export type IdeaConvertToTaskReq = z.infer<typeof IdeaConvertToTaskReqSchema>;

export const IdeaUpgradeToProjectReqSchema = z.object({
  id: z.string().min(1),
  title: projectTitleSchema,
  icon: z.string().optional(),
  primaryColor: z.string().optional(),
  /** 验证目标：怎么算验证成功（CONTEXT.md 的"验证目标"）。 */
  validationGoal: z.string().optional(),
});
export type IdeaUpgradeToProjectReq = z.infer<typeof IdeaUpgradeToProjectReqSchema>;

/** The two follow-up state commands take the same body as a delete: an id. */
/**
 * The two follow-up state commands' request body. Declared independently of
 * FollowUpDeleteReqSchema on purpose: an alias is the same object, so a field
 * added to the delete schema would go on changing these commands' wire shape
 * with nothing to notice.
 */
export const FollowUpIdReqSchema = z.object({ id: z.string().min(1) });

/**
 * The follow-up *field* edit. Derived from FollowUpSchema by omission so the
 * two cannot drift: isResolved/resolvedAt advance only through the
 * resolve/reopen commands, so a write-back of the renderer's snapshot cannot
 * silently undo a 办结 the user already performed.
 */
export const FollowUpEditSchema = FollowUpSchema.omit({
  isResolved: true,
  resolvedAt: true,
  // null clears, undefined leaves alone. The renderer always builds this
  // payload by hand, so an omitted key is the only way to say "don't touch",
  // and clearing a date input has to stay expressible.
  nextFollowUpDay: true,
}).extend({ nextFollowUpDay: z.string().nullable().optional() });

/**
 * FollowUpEditSchema fields that may be explicitly nulled to clear them.
 * Register a newly nullable field here, or it will silently be unclearable.
 */
export const FOLLOW_UP_CLEARABLE_FIELDS = ['nextFollowUpDay'] as const;
// z.input, not z.infer: entries carries a .default([]) so it is required in the
// *output* type but optional in the request.
export type FollowUpEdit = z.input<typeof FollowUpEditSchema>;

export const IdeaAddEntryReqSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
});
export type IdeaAddEntryReq = z.infer<typeof IdeaAddEntryReqSchema>;

export const IdeaDeleteEntryReqSchema = z.object({
  id: z.string().min(1),
  entryId: z.string().min(1),
});
export type IdeaDeleteEntryReq = z.infer<typeof IdeaDeleteEntryReqSchema>;

export const IdeaUpdateEntryReqSchema = z.object({
  id: z.string().min(1),
  entryId: z.string().min(1),
  text: z.string().trim().min(1),
});
export type IdeaUpdateEntryReq = z.infer<typeof IdeaUpdateEntryReqSchema>;

export const IdeaCloseWithVerdictReqSchema = z.object({
  id: z.string().min(1),
  result: z.enum(['validated', 'invalidated', 'partial']),
  text: z.string().optional(),
});
export type IdeaCloseWithVerdictReq = z.infer<typeof IdeaCloseWithVerdictReqSchema>;

export const OrderSetReqSchema = z.object({
  viewKey: z.string().min(1),
  ids: z.array(z.string()),
});
export type OrderSetReq = z.infer<typeof OrderSetReqSchema>;

export const ProjectCreateReqSchema = z.object({
  title: projectTitleSchema,
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
  title: projectTitleSchema.optional(),
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

export const CalendarAddTaskInputSchema = z.object({
  taskId: z.string().min(1),
});
export type CalendarAddTaskInput = z.infer<typeof CalendarAddTaskInputSchema>;

export const CalendarAddTaskOutputSchema = z.union([
  z.object({ ok: z.literal(true), eventId: z.string() }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['no-dueDay', 'permission-denied', 'calendar-app-unavailable', 'unknown']),
    message: z.string(),
  }),
]);
export type CalendarAddTaskOutput = z.infer<typeof CalendarAddTaskOutputSchema>;

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

/**
 * 想法命令的返回值。领域拒绝（如对已闭环的想法执行 reopen）走 ok:false 分支，
 * 系统错误继续 throw —— 与 importRun/aiTestProvider 的既有惯例一致。
 */
export type IdeaCommandResult = { ok: true; data: AppData } | IdeaCommandRejection;

/** 转为任务额外带回生成的任务：渲染进程据此高亮/跳转，无需再猜 id。 */
export type IdeaConvertResult =
  | ({ ok: true; taskId: string } & WriteOutcome)
  | IdeaCommandRejection;
/** The same, plus the id of the project created in the same atomic write. */

/** 升级为项目额外带回新建的项目：原子转换的另一半，调用方需要它的 id。 */
export type IdeaUpgradeResult =
  | ({ ok: true; projectId: string } & WriteOutcome)
  | IdeaCommandRejection;

/**
 * 停止计时的拒绝码，各自对应一件不同的事，调用方要能分开：
 * - NO_ACTIVE_TIMER：本来就没有在计时。
 * - TIMER_MISMATCH：主进程跑的不是调用方指定的那次（渲染进程的换表与心跳
 *   sync() 之间发生了竞态）。此时**有**计时器在跑，所以复用 NO_ACTIVE_TIMER
 *   会让调用方以为无事发生，从而错过那次没被结算的时长。
 * - TASK_NOT_FOUND / TASK_ALREADY_DONE：计时被丢弃，data 带回落库后的状态。
 */
/**
 * 控制流写通道的返回（ADR-0004）。
 *
 * 只有**返回值被当作控制流**的通道才用这个形状：调用方会拿它决定关不关弹窗、
 * 记不记录、TimerBar 动不动。其余写通道返回裸 AppData，因为它们的结果只用来
 * 刷新界面，而"这个应用现在还在保存吗"是一个全局状态，由 store 模式推送
 * （Ipc.storeWritable + StoreUnreadableBanner），不需要逐次携带。
 *
 * 判别式把"成功"和"落盘"合成一个真相：`ok: true` 蕴含 persisted，被拒绝时
 * 结果与既有领域拒绝同构（`{ ok: false, error }`），所以调用点原有的
 * `if (!result.ok)` 一行都不用改，也不存在"ok 为真但其实没存下来"的组合。
 *
 * 诚实地说：类型系统无法强制一次布尔判断——判别联合摆在那里，不检查也能编译。
 * 这里能保证的是把需要检查的通道从二十个缩到五个，且每个都紧挨着一个本来就
 * 存在的分支。不要指望它替代 review。
 */
export type WriteOutcome = { ok: true; data: AppData } | { ok: false; error: 'WRITE_REFUSED' };

/**
 * 停止计时的结算结果。主进程自己跑 settleTimer，因此这里是"记了多少"的权威答案，
 * 而不是渲染进程的预测值；与 quit / auto-pause 路径共用同一份结算语义。
 *
 * 拒绝分支也带 data：主进程在拒绝前可能已经丢弃了 activeTimer（任务已完成的
 * 情况就是这样），渲染进程必须拿到落库后的数据集才能收敛，否则会一直显示着
 * 一次结算根本没动过的旧 timeSpent。
 */
export type TimingStopResult =
  | { ok: true; data: AppData; settledMs: number; persisted: boolean }
  | {
      ok: false;
      /**
       * What was true of the *timer*. WRITE_REFUSED is the exception: it
       * describes the store, and it is the one code where a settlement that
       * should have happened did not.
       */
      error:
        | 'NO_ACTIVE_TIMER'
        | 'TIMER_MISMATCH'
        | 'TASK_NOT_FOUND'
        | 'TASK_ALREADY_DONE'
        | 'WRITE_REFUSED';
      data: AppData;
      /**
       * Whether the store accepted the write. Orthogonal to `error`: a stop
       * that dropped the timer because its task was done is still worth
       * reporting accurately when the refusal means the drop never landed.
       */
      persisted: boolean;
    };

export const TimingStopReqSchema = z.object({
  /**
   * 调用方要结算的那次计时所属的任务。带上它，主进程就只会结算**这一次**：
   * 渲染进程换表与心跳 sync() 之间的竞态就不会把时长记到刚起步的新表上。
   * 省略则结算当前 activeTimer（quit / 无人等待的路径）。
   */
  taskId: z.string().min(1).optional(),
});
export type TimingStopReq = z.infer<typeof TimingStopReqSchema>;

// Single source of truth for invoke channels: channel name + request schema +
// response type. Adding an entry here forces both ends to implement it at
// compile time (IpcInvokeHandlers in main, RendererApi in preload).
// Event channels (aiChunk/aiDone/aiError) are main->renderer only and stay
// outside this contract; see IpcEventChannels.
export const IpcInvokeContract = {
  dataLoad: { ch: Ipc.dataLoad, res: null as unknown as AppData },
  taskUpsert: {
    ch: Ipc.taskUpsert,
    req: TaskSchema,
    // `settledMs` is the authoritative answer to "how much time did this write
    // record", so the renderer can report it instead of predicting it.
    // `persisted` says whether it reached the disk at all — without it the
    // renderer reports a save that a refused store silently discarded.
    res: null as unknown as
      | ({ settledMs: number } & WriteOutcome)
      | { ok: false; error: 'WRITE_REFUSED' },
  },
  taskDelete: {
    ch: Ipc.taskDelete,
    req: TaskDeleteReqSchema,
    res: null as unknown as AppData,
  },
  followUpUpsert: {
    ch: Ipc.followUpUpsert,
    req: FollowUpEditSchema,
    res: null as unknown as AppData,
  },
  followUpDelete: {
    ch: Ipc.followUpDelete,
    req: FollowUpDeleteReqSchema,
    res: null as unknown as AppData,
  },
  followUpResolve: {
    ch: Ipc.followUpResolve,
    // Not FollowUpDeleteReqSchema: a field added to the delete schema would
    // otherwise silently change the wire shape of this command.
    req: FollowUpIdReqSchema,
    res: null as unknown as FollowUpCommandResult,
  },
  followUpReopen: {
    ch: Ipc.followUpReopen,
    req: FollowUpIdReqSchema,
    res: null as unknown as FollowUpCommandResult,
  },
  ideaUpsert: {
    ch: Ipc.ideaUpsert,
    req: IdeaEditSchema,
    res: null as unknown as AppData,
  },
  ideaDelete: {
    ch: Ipc.ideaDelete,
    req: IdeaDeleteReqSchema,
    res: null as unknown as AppData,
  },
  ideaComplete: {
    ch: Ipc.ideaComplete,
    req: IdeaIdReqSchema,
    res: null as unknown as IdeaCommandResult,
  },
  ideaDiscard: {
    ch: Ipc.ideaDiscard,
    req: IdeaIdReqSchema,
    res: null as unknown as IdeaCommandResult,
  },
  ideaReopen: {
    ch: Ipc.ideaReopen,
    req: IdeaIdReqSchema,
    res: null as unknown as IdeaCommandResult,
  },
  ideaConvertToTask: {
    ch: Ipc.ideaConvertToTask,
    req: IdeaConvertToTaskReqSchema,
    res: null as unknown as IdeaConvertResult,
  },
  ideaUpgradeToProject: {
    ch: Ipc.ideaUpgradeToProject,
    req: IdeaUpgradeToProjectReqSchema,
    res: null as unknown as IdeaUpgradeResult,
  },
  ideaAddEntry: {
    ch: Ipc.ideaAddEntry,
    req: IdeaAddEntryReqSchema,
    res: null as unknown as IdeaCommandResult,
  },
  ideaDeleteEntry: {
    ch: Ipc.ideaDeleteEntry,
    req: IdeaDeleteEntryReqSchema,
    res: null as unknown as IdeaCommandResult,
  },
  ideaUpdateEntry: {
    ch: Ipc.ideaUpdateEntry,
    req: IdeaUpdateEntryReqSchema,
    res: null as unknown as IdeaCommandResult,
  },
  ideaCloseWithVerdict: {
    ch: Ipc.ideaCloseWithVerdict,
    req: IdeaCloseWithVerdictReqSchema,
    res: null as unknown as IdeaCommandResult,
  },
  orderSet: { ch: Ipc.orderSet, req: OrderSetReqSchema, res: null as unknown as void },
  projectCreate: {
    ch: Ipc.projectCreate,
    req: ProjectCreateReqSchema,
    // The id comes back with the dataset: the renderer used to recover it by
    // diffing the whole project list, which picks the wrong project if two
    // creations interleave.
    res: null as unknown as
      | ({ ok: true; projectId: string } & WriteOutcome)
      | { ok: false; error: 'WRITE_REFUSED' },
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
  timingStop: {
    ch: Ipc.timingStop,
    req: TimingStopReqSchema,
    res: null as unknown as TimingStopResult,
  },
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
  calendarAddTask: {
    ch: Ipc.calendarAddTask,
    req: CalendarAddTaskInputSchema,
    res: null as unknown as CalendarAddTaskOutput,
  },
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
export const IpcUiEventChannels = [
  Ipc.uiNewTask,
  Ipc.uiUpdateAvailable,
  Ipc.timerChanged,
  Ipc.storeWritable,
] as const;

/**
 * The store's read-only mode, pushed rather than returned (ADR-0004).
 *
 * Not a per-write outcome: data.json being unparseable is a *condition the app
 * is in*, not a property of any one save. Carrying it on every channel's
 * return value made each new channel another place to forget, and forgetting
 * is invisible — it type-checks, passes tests, and shows the user a save that
 * never happened.
 *
 * `reason` is the parse/IO failure, kept for the banner: "保存失败，请重试"
 * asks the user to retry something that cannot succeed until they repair the
 * file.
 */
export type StoreWritablePayload = { writable: boolean; reason: string | null };

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
