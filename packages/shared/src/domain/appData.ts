import { z } from 'zod';
import { type FollowUp, FollowUpSchema } from './followUp';
import { type Idea, IdeaSchema } from './idea';
import type { Project, Tag } from './project';
import { INBOX_PROJECT_ID, ProjectSchema, TagSchema } from './project';
import { type ActiveTimer, ActiveTimerSchema, type Task, TaskSchema } from './task';

export type ThemeMode = 'light' | 'dark' | 'system';

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
  /** dueDay 距今 ≤ 该天数即视为紧急（四象限横轴）。 */
  urgencyThresholdDays: number;
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

export const AiProviderSchema = z.object({
  id: z.string(),
  registryId: z.string(),
  apiKeyEncrypted: z.string(),
  hasApiKey: z.boolean().optional(),
  baseUrl: z.string().optional(),
  model: z.string(),
  isDefault: z.boolean(),
});

export const SettingsSchema = z.object({
  userName: z.string(),
  avatar: z.string().nullable(),
  theme: z.enum(['light', 'dark', 'system']),
  aiProviders: z.array(AiProviderSchema),
  aiPrompt: z.string(),
  autoAiAnalyzeOnFinishDay: z.boolean(),
  // Defaults backfill legacy persisted settings that predate idle auto-pause.
  idlePauseEnabled: z.boolean().default(true),
  idlePauseMinutes: z.number().default(5),
  // Defaults backfill legacy persisted settings that predate the quadrant board.
  urgencyThresholdDays: z.number().default(2),
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
  // Default backfills data.json files written before the FollowUp module existed.
  followUps: z.record(z.string(), FollowUpSchema).default({}),
  // Default backfills data.json files written before the Idea module existed.
  ideas: z.record(z.string(), IdeaSchema).default({}),
  settings: SettingsSchema,
  activeTimer: ActiveTimerSchema.nullable(),
});

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
    urgencyThresholdDays: 2,
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
    tags: {},
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
