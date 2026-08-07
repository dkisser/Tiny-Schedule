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

export interface Project {
  id: string;
  title: string;
  icon?: string;
  isArchived: boolean;
  primaryColor?: string;
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
}

export interface ActiveTimer {
  taskId: string;
  startedAt: number; // epoch ms of current running segment
  accumulatedMs: number; // ms accumulated from previous segments
  isPaused: boolean;
  pausedAt?: number; // epoch ms when paused
}

export interface AppData {
  version: 1;
  tasks: Record<string, Task>;
  projects: Record<string, Project>;
  tags: Record<string, Tag>;
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
    settings: defaultSettings(),
    activeTimer: null,
  };
}
