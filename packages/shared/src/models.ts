export type ThemeMode = 'light' | 'dark' | 'system';

export interface TimeEntry {
  date: string; // YYYY-MM-DD
  start: number; // epoch ms
  end: number; // epoch ms
  ms: number;
}

export interface Task {
  id: string;
  title: string;
  projectId: string;
  tagIds: string[];
  // Snapshots of project/tag display names at assignment time; later renames
  // or deletions of projects/tags must not propagate into existing tasks.
  projectTitle?: string;
  tagSnapshots?: Record<string, { title: string; color?: string }>;
  subTaskIds: string[];
  parentTaskId?: string;
  isDone: boolean;
  doneAt?: number;
  dueDay?: string; // YYYY-MM-DD
  timeEstimate: number; // ms
  timeSpent: number; // ms
  timeSpentOnDay: Record<string, number>; // date -> ms
  timeEntries: TimeEntry[];
  notes: string;
  created: number; // epoch ms
}

export interface FollowUpEntry {
  id: string;
  at: number; // epoch ms
  text: string;
}

// 长期等待外部反馈的事项（如 ICP 审核）：与 Task 完全分开，不参与计时/今日。
export interface FollowUp {
  id: string;
  title: string;
  notes: string; // markdown，在等谁/背景说明
  entries: FollowUpEntry[]; // 跟进记录时间线，按 at 升序追加
  createdAt: number; // epoch ms，开始等待的时间
  nextFollowUpDay?: string; // YYYY-MM-DD，下次跟进日期
  isResolved: boolean;
  resolvedAt?: number; // epoch ms
}

// 想法生命周期：open 是唯一可分流的状态；done/discarded 可重新打开；
// converted/closed 是终态（closed 可修改结论）；incubating 的唯一出口是给结论。
export type IdeaStatus = 'open' | 'done' | 'discarded' | 'converted' | 'incubating' | 'closed';

// 验证中想法的演进日志条目（结构对齐 FollowUpEntry）。
export interface IdeaEntry {
  id: string;
  createdAt: number; // epoch ms
  text: string;
}

export interface IdeaVerdict {
  result: 'validated' | 'invalidated' | 'partial';
  text?: string;
  closedAt: number; // epoch ms
}

// 灵光一闪的想法：与 Task 完全分开，不参与计时/今日；出口：转任务/完成/废弃/升级为项目。
export interface Idea {
  id: string;
  title: string;
  notes: string; // markdown 备注
  createdAt: number; // epoch ms
  // 旧数据无 status 字段，由 IdeaSchema 在解析时派生：convertedAt 存在 → converted，否则 → open。
  status: IdeaStatus;
  convertedAt?: number; // epoch ms；设置即表示已转为任务
  convertedTaskId?: string; // 转化生成的任务 id
  projectId?: string; // incubating/closed 时关联的专属项目（一对一）
  validationGoal?: string; // 可选验证目标：怎么算验证成功
  timeline?: IdeaEntry[]; // 演进日志，按 createdAt 升序追加
  verdict?: IdeaVerdict; // closed 时的验证结论
  incubatedAt?: number; // epoch ms，升级为项目的时间（验证中区排序用）
  resolvedAt?: number; // epoch ms，进入 done/discarded/closed 的时间（已了结区排序用）
}

export const PROJECT_TITLE_MAX_LENGTH = 32;

export interface Project {
  id: string;
  title: string;
  icon?: string;
  isArchived: boolean;
  // `null` is a legitimate "unset" value (cleared via the color picker);
  // `undefined` is the legacy "never set" state from older backups.
  primaryColor?: string | null;
}

export interface Tag {
  id: string;
  title: string;
  color?: string;
}

export interface AiSummary {
  id: string;
  scope: 'today' | 'week' | 'project';
  projectId?: string;
  createdAt: number; // epoch ms
  content: string; // markdown
}

export interface ChatSession {
  id: string;
  title: string; // 首条用户消息前 30 字；新会话为 ''
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
  providerId?: string; // 缺省跟随全局默认 provider
  messages: unknown[]; // pi-agent-core AgentMessage[] 原样序列化
}

export interface AiProviderConfig {
  id: string; // unique instance id
  registryId: string; // id in PROVIDER_REGISTRY
  apiKeyEncrypted: string; // base64 of safeStorage-encrypted key (main process only)
  // Renderer-facing flag computed by maskDataForRenderer; never persisted.
  hasApiKey?: boolean;
  baseUrl?: string; // for custom providers; empty/absent means use registry default
  model: string;
  isDefault: boolean;
}

export interface AppSettings {
  userName: string;
  avatar: string | null; // data URL
  theme: ThemeMode;
  aiProviders: AiProviderConfig[];
  aiPrompt: string; // empty string = use built-in default prompt
  autoAiAnalyzeOnFinishDay: boolean;
  idlePauseEnabled: boolean;
  idlePauseMinutes: number;
}

export type TimerMode = 'free' | 'pomodoro';
export type PomodoroPhase = 'focus' | 'break';

export interface ActiveTimer {
  taskId: string;
  startedAt: number; // epoch ms of current running segment
  accumulatedMs: number; // ms accumulated from previous segments
  isPaused: boolean;
  pausedAt?: number; // epoch ms when paused
  sessionStartedAt?: number; // epoch ms of the very first segment; absent in legacy data
  autoPausedBy?: 'sleep' | 'idle'; // set only by automatic pauses
  // Pomodoro fields (all optional; absent => free-mode timer).
  mode?: TimerMode; // absent on legacy data => treated as 'free'
  phase?: PomodoroPhase; // current phase when mode === 'pomodoro'
  phaseStartedAt?: number; // epoch ms when the current phase segment started (mirrors startedAt)
  phaseAccumulatedMs?: number; // ms accumulated in current phase from previous segments (mirrors accumulatedMs)
  phaseDurationMs?: number; // target length of the current phase
  cyclesCompleted?: number; // number of focus phases completed in this session
  // ms accumulated in `focus` phases across pauses and phase boundaries. Only
  // set on pomodoro timers; absent on legacy/free timers. Used to exclude
  // break time from the settled TimeEntry.
  focusAccumulatedMs?: number;
}

export interface AppData {
  version: 1;
  tasks: Record<string, Task>;
  projects: Record<string, Project>;
  tags: Record<string, Tag>;
  followUps: Record<string, FollowUp>;
  ideas: Record<string, Idea>;
  timeTracking: unknown; // preserved raw from backup
  notes: unknown;
  planner: unknown;
  metric: unknown;
  boards: unknown;
  misc: Record<string, unknown>; // raw backup sections we don't model yet
  settings: AppSettings;
  activeTimer: ActiveTimer | null;
}

export const SYSTEM_TAG_IDS = {
  today: 'TODAY',
  important: 'EM_IMPORTANT',
  urgent: 'EM_URGENT',
} as const;

export const INBOX_PROJECT_ID = 'INBOX_PROJECT';

export function defaultSettings(): AppSettings {
  return {
    userName: '',
    avatar: null,
    theme: 'system',
    aiProviders: [],
    aiPrompt: '',
    autoAiAnalyzeOnFinishDay: false,
    idlePauseEnabled: true,
    idlePauseMinutes: 5,
  };
}

export function emptyAppData(): AppData {
  return {
    version: 1,
    tasks: {},
    projects: {
      [INBOX_PROJECT_ID]: {
        id: INBOX_PROJECT_ID,
        title: 'Inbox',
        icon: 'inbox',
        isArchived: false,
      },
    },
    tags: {
      [SYSTEM_TAG_IDS.important]: { id: SYSTEM_TAG_IDS.important, title: 'Important' },
      [SYSTEM_TAG_IDS.urgent]: { id: SYSTEM_TAG_IDS.urgent, title: 'Urgent' },
    },
    timeTracking: null,
    notes: null,
    planner: null,
    metric: null,
    boards: null,
    misc: {},
    followUps: {},
    ideas: {},
    settings: defaultSettings(),
    activeTimer: null,
  };
}
