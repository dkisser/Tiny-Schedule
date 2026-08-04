# Tiny-Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Tiny-Schedule, an Electron task-management app that imports Super Productivity backups, supports full task editing + time tracking, exports Markdown (task lists / worklog), and provides multi-provider AI analysis.

**Architecture:** Monorepo with `packages/shared` (types, IPC protocol, pure timer logic — zod-validated) and `packages/app` (electron-vite app). The Electron main process owns all disk I/O, JSON document storage, and AI HTTP calls; the renderer is pure UI talking to main through a typed preload bridge.

**Tech Stack:** Electron + electron-vite, React 19 + TypeScript, Tailwind v4 + shadcn/ui, Zustand, Bun workspaces, Biome, zod, pino (JSONL logs).

**Spec:** `docs/superpowers/specs/2026-08-04-tiny-schedule-design.md`

## Global Constraints

- 所有磁盘读写和 AI HTTP 请求只在主进程发生；渲染进程不直接碰磁盘/网络，API key 永远不进入渲染进程。
- IPC 协议只定义在 `packages/shared`，主/渲染两端共同依赖；请求参数与返回值用 zod 双向校验。
- 数据存储为 `userData/data.json`，原子写（临时文件 + rename），每次保存前旧文件复制为 `data.backup.json`；损坏时回退备份。
- 日志：pino NDJSON(JSONL) 写 `userData/logs/app-*.jsonl`（pino-roll 滚动）；关键动作必须记日志（导入、导出、AI 调用（不含 key）、计时开始/暂停/结束/结算、设置变更）。
- 退出行为：计时运行中关闭窗口 → 弹确认框（非强制拦截）→ 确认后先结算已耗时间到任务再退出；不得模仿 Super Productivity 的强制拦截。
- AI 超时策略：首 token 30s 超时；流式期间每收到 chunk 重置 60s 空闲计时；无总时长上限。
- 移除项（不做）：Support Us / Help / Donate、原版复杂设置、Boards/Habits/Metric UI、数据逐条合并导入、云同步。
- 代码规范：`bun run lint`（Biome）与 `bun run typecheck` 必须始终通过；每个任务结束前跑一次。
- 提交信息用英文，`feat:` / `fix:` / `chore:` / `test:` / `docs:` 前缀。
- 日期格式统一 `YYYY-MM-DD`（本地时区）；所有耗时单位毫秒。

---

### Task 1: Monorepo 脚手架与工具链

**Files:**
- Create: `package.json`, `.gitignore`, `biome.json`, `tsconfig.base.json`, `tsconfig.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `packages/app/package.json`, `packages/app/tsconfig.json`

**Interfaces:**
- Produces: bun workspace 根（`bun install` / `bun run lint` / `bun run typecheck` / `bun test`），后续所有任务依赖此骨架。

- [ ] **Step 1: 根 package.json（bun workspaces）**

```json
{
  "name": "tiny-schedule",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "bun run --cwd packages/app dev",
    "build": "bun run --cwd packages/app build",
    "test": "bun run --cwd packages/app test && bun run --cwd packages/shared test",
    "lint": "biome check .",
    "format": "biome check --write .",
    "typecheck": "tsc -b"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: .gitignore**

```
node_modules/
dist/
out/
*.log
.DS_Store
.vite/
```

- [ ] **Step 3: biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignoreUnknown": true },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always" } }
}
```

- [ ] **Step 4: tsconfig.base.json 与根 tsconfig.json**

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "composite": true,
    "noEmit": false,
    "emitDeclarationOnly": true,
    "declaration": true,
    "outDir": "${configDir}/dist-types"
  }
}
```

根 `tsconfig.json`（project references）:

```json
{
  "files": [],
  "references": [{ "path": "packages/shared" }, { "path": "packages/app" }]
}
```

- [ ] **Step 5: shared 包骨架**

`packages/shared/package.json`:

```json
{
  "name": "@tiny-schedule/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": { "test": "bun test" },
  "dependencies": { "zod": "^3.24.0" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

`packages/shared/src/index.ts`:

```ts
export const SHARED_READY = true;
```

- [ ] **Step 6: app 包骨架**

`packages/app/package.json`（依赖在后续任务用 `bun add` 安装，此处只建骨架）:

```json
{
  "name": "@tiny-schedule/app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "bun test"
  },
  "dependencies": { "@tiny-schedule/shared": "workspace:*" },
  "devDependencies": { "electron-vite": "^3.0.0", "typescript": "^5.7.0" }
}
```

`packages/app/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "paths": { "@/*": ["./src/renderer/src/*"] },
    "types": ["vite/client"]
  },
  "include": ["src", "electron.vite.config.ts"]
}
```

- [ ] **Step 7: 安装并验证**

Run:
```bash
bun install
bun run typecheck
bun run lint
```
Expected: 全部通过，无错误。若 Biome 对生成文件报错，用 `bun run format` 修复后重跑。

- [ ] **Step 8: Commit**

```bash
git add package.json .gitignore biome.json tsconfig.base.json tsconfig.json bun.lock packages/
git commit -m "chore: scaffold bun monorepo with biome and tsconfig"
```

---

### Task 2: Shared 数据模型与默认值

**Files:**
- Create: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/models.test.ts`

**Interfaces:**
- Produces: `Task`, `TimeEntry`, `Project`, `Tag`, `AppSettings`, `AiProviderConfig`, `ActiveTimer`, `AppData`, `ThemeMode`, `SYSTEM_TAG_IDS`, `defaultSettings()`, `emptyAppData()`。Task 3-20 全部依赖这些类型。

- [ ] **Step 1: 写失败测试**

`packages/shared/src/models.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { defaultSettings, emptyAppData, SYSTEM_TAG_IDS } from './models';

describe('emptyAppData', () => {
  test('has version 1 and empty collections', () => {
    const d = emptyAppData();
    expect(d.version).toBe(1);
    expect(d.tasks).toEqual({});
    expect(d.projects).toEqual({});
    expect(d.tags).toEqual({});
    expect(d.activeTimer).toBeNull();
    expect(d.misc).toEqual({});
  });

  test('includes INBOX_PROJECT', () => {
    const d = emptyAppData();
    expect(d.projects.INBOX_PROJECT?.title).toBe('Inbox');
  });

  test('includes system tags', () => {
    const d = emptyAppData();
    expect(d.tags[SYSTEM_TAG_IDS.today]?.title).toBe('Today');
    expect(d.tags[SYSTEM_TAG_IDS.important]).toBeDefined();
    expect(d.tags[SYSTEM_TAG_IDS.urgent]).toBeDefined();
  });

  test('returns fresh objects each call', () => {
    const a = emptyAppData();
    const b = emptyAppData();
    a.tasks.x = a.tasks.x ?? ({} as never);
    expect(Object.keys(b.tasks)).toHaveLength(0);
  });
});

describe('defaultSettings', () => {
  test('has sane defaults', () => {
    const s = defaultSettings();
    expect(s.userName).toBe('');
    expect(s.avatar).toBeNull();
    expect(s.theme).toBe('system');
    expect(s.aiProviders).toEqual([]);
    expect(s.aiPrompt).toBe('');
    expect(s.autoAiAnalyzeOnFinishDay).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/shared && bun test`
Expected: FAIL — `Cannot find module './models'`

- [ ] **Step 3: 实现 models.ts**

`packages/shared/src/models.ts`:

```ts
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

export interface AiProviderConfig {
  id: string; // unique instance id
  registryId: string; // id in PROVIDER_REGISTRY
  apiKeyEncrypted: string; // base64 of safeStorage-encrypted key (main process only)
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
      [INBOX_PROJECT_ID]: { id: INBOX_PROJECT_ID, title: 'Inbox', icon: 'inbox', isArchived: false },
    },
    tags: {
      [SYSTEM_TAG_IDS.today]: { id: SYSTEM_TAG_IDS.today, title: 'Today' },
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
```

更新 `packages/shared/src/index.ts`:

```ts
export * from './models';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/shared && bun test`
Expected: PASS（5 tests）

- [ ] **Step 5: 校验并提交**

Run: `bun run typecheck && bun run lint`
Expected: 通过。

```bash
git add packages/shared
git commit -m "feat(shared): add data models and defaults"
```

---

### Task 3: Shared 计时器纯逻辑（结算核心）

**Files:**
- Create: `packages/shared/src/timer.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/timer.test.ts`

**Interfaces:**
- Produces: `startTimer(taskId, now)`, `pauseTimer(t, now)`, `resumeTimer(t, now)`, `computeElapsed(t, now)`, `localDate(ts)`, `settleTimer(t, now)` → `{ ms, entry: TimeEntry }`, `applySettlement(task, settlement)` → `Task`。渲染进程计时 UI 与主进程退出结算共用这些函数。

- [ ] **Step 1: 写失败测试**

`packages/shared/src/timer.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { Task } from './models';
import {
  applySettlement,
  computeElapsed,
  localDate,
  pauseTimer,
  resumeTimer,
  settleTimer,
  startTimer,
} from './timer';

const T0 = 1_785_700_000_000;

describe('timer transitions', () => {
  test('start creates fresh timer', () => {
    const t = startTimer('task1', T0);
    expect(t).toEqual({ taskId: 'task1', startedAt: T0, accumulatedMs: 0, isPaused: false });
  });

  test('pause accumulates elapsed time', () => {
    const t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    expect(t.isPaused).toBe(true);
    expect(t.accumulatedMs).toBe(60_000);
    expect(t.pausedAt).toBe(T0 + 60_000);
  });

  test('pause is idempotent', () => {
    const t = startTimer('task1', T0);
    expect(pauseTimer(t, T0 + 1000)).toEqual(pauseTimer(pauseTimer(t, T0 + 1000), T0 + 9000));
  });

  test('resume restarts segment without losing accumulated time', () => {
    let t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    t = resumeTimer(t, T0 + 120_000);
    expect(t.isPaused).toBe(false);
    expect(t.startedAt).toBe(T0 + 120_000);
    expect(t.accumulatedMs).toBe(60_000);
    expect(computeElapsed(t, T0 + 150_000)).toBe(90_000);
  });

  test('computeElapsed excludes paused time', () => {
    const t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    expect(computeElapsed(t, T0 + 10 * 60_000)).toBe(60_000);
  });
});

describe('localDate', () => {
  test('formats local YYYY-MM-DD', () => {
    const d = new Date(2026, 7, 4, 9, 30); // Aug = month 7
    expect(localDate(d.getTime())).toBe('2026-08-04');
    expect(localDate(new Date(2026, 0, 1, 0, 0).getTime())).toBe('2026-01-01');
  });
});

describe('settlement', () => {
  test('settle running timer at now', () => {
    const t = startTimer('task1', T0);
    const s = settleTimer(t, T0 + 90_000);
    expect(s.ms).toBe(90_000);
    expect(s.entry.start).toBe(T0);
    expect(s.entry.end).toBe(T0 + 90_000);
    expect(s.entry.date).toBe(localDate(T0 + 90_000));
  });

  test('settle paused timer ends at pause time, not now', () => {
    const t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    const s = settleTimer(t, T0 + 300_000);
    expect(s.ms).toBe(60_000);
    expect(s.entry.end).toBe(T0 + 60_000);
  });

  test('applySettlement adds ms to task totals and appends entry', () => {
    const task: Task = {
      id: 'task1', title: 'T', projectId: 'p', tagIds: [], subTaskIds: [],
      isDone: false, timeEstimate: 0, timeSpent: 10_000,
      timeSpentOnDay: { '2026-08-04': 5_000 }, timeEntries: [], notes: '', created: 0,
    };
    const t = startTimer('task1', T0);
    const settled = applySettlement(task, settleTimer(t, T0 + 90_000));
    const day = localDate(T0 + 90_000);
    expect(settled.timeSpent).toBe(100_000);
    expect(settled.timeSpentOnDay[day]).toBe((day === '2026-08-04' ? 5_000 : 0) + 90_000);
    expect(settled.timeEntries).toHaveLength(1);
    expect(settled.timeEntries[0]?.ms).toBe(90_000);
    // original not mutated
    expect(task.timeSpent).toBe(10_000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/shared && bun test`
Expected: FAIL — `Cannot find module './timer'`

- [ ] **Step 3: 实现 timer.ts**

`packages/shared/src/timer.ts`:

```ts
import type { ActiveTimer, Task, TimeEntry } from './models';

export function startTimer(taskId: string, now: number): ActiveTimer {
  return { taskId, startedAt: now, accumulatedMs: 0, isPaused: false };
}

export function pauseTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (t.isPaused) return t;
  return {
    ...t,
    accumulatedMs: t.accumulatedMs + Math.max(0, now - t.startedAt),
    isPaused: true,
    pausedAt: now,
  };
}

export function resumeTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (!t.isPaused) return t;
  return { ...t, startedAt: now, isPaused: false, pausedAt: undefined };
}

export function computeElapsed(t: ActiveTimer, now: number): number {
  return t.accumulatedMs + (t.isPaused ? 0 : Math.max(0, now - t.startedAt));
}

export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

export interface Settlement {
  ms: number;
  entry: TimeEntry;
}

export function settleTimer(t: ActiveTimer, now: number): Settlement {
  const ms = computeElapsed(t, now);
  const end = t.isPaused ? (t.pausedAt ?? now) : now;
  return { ms, entry: { date: localDate(end), start: t.startedAt, end, ms } };
}

export function applySettlement(task: Task, settlement: Settlement): Task {
  const day = settlement.entry.date;
  return {
    ...task,
    timeSpent: task.timeSpent + settlement.ms,
    timeSpentOnDay: {
      ...task.timeSpentOnDay,
      [day]: (task.timeSpentOnDay[day] ?? 0) + settlement.ms,
    },
    timeEntries: [...task.timeEntries, settlement.entry],
  };
}
```

追加到 `packages/shared/src/index.ts`:

```ts
export * from './timer';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/shared && bun test`
Expected: PASS（9 tests）

- [ ] **Step 5: 校验并提交**

Run: `bun run typecheck && bun run lint`（仓库根目录）
Expected: 通过。

```bash
git add packages/shared
git commit -m "feat(shared): add timer transition and settlement logic"
```

---

### Task 4: Shared IPC 协议（zod schema + 类型化 API）

**Files:**
- Create: `packages/shared/src/ipc.ts`, `packages/shared/src/api.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/ipc.test.ts`

**Interfaces:**
- Produces: `Ipc`（channel 常量表）、各请求/响应 zod schema 及其推断类型（`TaskUpsertReq`, `SettingsUpdateReq`, `TimerSyncReq`, `ImportRunResult`, `ExportMarkdownReq/Result`, `AiAnalyzeReq`, `AiStreamEvent` 等）、`ProviderInfo`、`RendererApi` 接口。Task 5/12 的 preload 与 handler 直接实现此契约。

- [ ] **Step 1: 写失败测试**

`packages/shared/src/ipc.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { emptyAppData } from './models';
import {
  AppDataSchema,
  ExportMarkdownReqSchema,
  Ipc,
  SettingsUpdateReqSchema,
  TaskSchema,
  TimerSyncReqSchema,
} from './ipc';

describe('Ipc channels', () => {
  test('channels are unique', () => {
    const values = Object.values(Ipc);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('schemas', () => {
  test('TaskSchema round-trips a valid task', () => {
    const task = {
      id: 't1', title: 'x', projectId: 'p1', tagIds: [], subTaskIds: [],
      isDone: false, timeEstimate: 0, timeSpent: 0, timeSpentOnDay: {},
      timeEntries: [], notes: '', created: 0,
    };
    expect(TaskSchema.parse(task)).toEqual(task);
  });

  test('TaskSchema rejects missing title', () => {
    const bad = { id: 't1', projectId: 'p1' };
    expect(() => TaskSchema.parse(bad)).toThrow();
  });

  test('AppDataSchema accepts emptyAppData()', () => {
    expect(AppDataSchema.parse(emptyAppData()).version).toBe(1);
  });

  test('SettingsUpdateReq is partial', () => {
    expect(SettingsUpdateReqSchema.parse({ theme: 'dark' }).theme).toBe('dark');
    expect(() => SettingsUpdateReqSchema.parse({ theme: 'blue' })).toThrow();
  });

  test('TimerSyncReq accepts null timer', () => {
    expect(TimerSyncReqSchema.parse({ timer: null }).timer).toBeNull();
  });

  test('ExportMarkdownReq validates mode', () => {
    expect(ExportMarkdownReqSchema.parse({ mode: 'projectList', projectId: 'p' }).mode).toBe('projectList');
    expect(ExportMarkdownReqSchema.parse({ mode: 'worklog', from: '2026-08-01', to: '2026-08-04' }).mode).toBe('worklog');
    expect(() => ExportMarkdownReqSchema.parse({ mode: 'bogus' })).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/shared && bun test`
Expected: FAIL — `Cannot find module './ipc'`

- [ ] **Step 3: 实现 ipc.ts**

`packages/shared/src/ipc.ts`:

```ts
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
```

- [ ] **Step 4: 实现 api.ts（渲染进程契约）**

`packages/shared/src/api.ts`:

```ts
import type {
  AiAnalyzeReq,
  AiStreamEvent,
  ExportMarkdownReq,
  ExportMarkdownResult,
  ImportRunResult,
  ProviderInfo,
  SettingsUpdateReq,
  TaskPayload,
  TimerSyncReq,
} from './ipc';
import type { AppData } from './models';

export interface RendererApi {
  dataLoad(): Promise<AppData>;
  taskUpsert(task: TaskPayload): Promise<AppData>;
  taskDelete(id: string): Promise<AppData>;
  settingsUpdate(patch: SettingsUpdateReq): Promise<AppData>;
  finishDay(date: string): Promise<AppData>;
  timerSync(req: TimerSyncReq): Promise<void>;
  importRun(): Promise<ImportRunResult>;
  exportMarkdown(req: ExportMarkdownReq): Promise<ExportMarkdownResult>;
  selectAvatar(): Promise<string | null>; // data URL
  aiRegistry(): Promise<ProviderInfo[]>;
  aiTestProvider(providerId: string): Promise<{ ok: boolean; error?: string }>;
  aiAnalyze(req: AiAnalyzeReq): Promise<{ requestId: string }>;
  onAiEvent(cb: (ev: AiStreamEvent) => void): () => void;
}

export const RENDERER_API_KEY = 'tinyApi';

declare global {
  interface Window {
    tinyApi: RendererApi;
  }
}
```

追加到 `packages/shared/src/index.ts`:

```ts
export * from './ipc';
export * from './api';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/shared && bun test`
Expected: PASS（ipc.test.ts 7 tests；shared 全量含 models/timer 共 21 tests）

- [ ] **Step 6: 校验并提交**

Run: `bun run typecheck && bun run lint`
Expected: 通过。

```bash
git add packages/shared
git commit -m "feat(shared): add zod IPC protocol and renderer API contract"
```

---

### Task 5: Electron 应用壳（electron-vite，窗口能打开）

**Files:**
- Create: `packages/app/electron.vite.config.ts`
- Create: `packages/app/src/main/main.ts`
- Create: `packages/app/src/preload/index.ts`
- Create: `packages/app/src/renderer/index.html`, `packages/app/src/renderer/src/main.tsx`, `packages/app/src/renderer/src/App.tsx`
- Modify: `packages/app/package.json`（安装依赖）

**Interfaces:**
- Consumes: `RENDERER_API_KEY` from shared。
- Produces: 可运行的 `bun run dev`（Electron 窗口渲染 React），`is.dev` 环境加载 dev server URL。IPC handler 在 Task 12 接入，本任务 preload 只暴露空占位。

- [ ] **Step 1: 安装依赖**

```bash
cd packages/app
bun add react react-dom
bun add -D electron electron-vite vite @vitejs/plugin-react @types/react @types/react-dom
```

并在 `packages/app/package.json` 中确认 `"main": "./out/main/main.js"` 存在（加在顶层字段）。

- [ ] **Step 2: electron.vite.config.ts**

`packages/app/electron.vite.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)) },
    },
    plugins: [react(), tailwindcss()],
  },
});
```

（Tailwind 依赖在 Task 13 安装；若本步骤因缺少 `@tailwindcss/vite` 报错，先执行 `bun add -D tailwindcss @tailwindcss/vite`。）

- [ ] **Step 3: 主进程入口**

`packages/app/src/main/main.ts`:

```ts
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { is } from '@electron-toolkit/utils';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.on('ready-to-show', () => win.show());
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

安装辅助依赖：`bun add -D @electron-toolkit/utils`

- [ ] **Step 4: preload 占位**

`packages/app/src/preload/index.ts`:

```ts
import { contextBridge } from 'electron';
import { RENDERER_API_KEY, type RendererApi } from '@tiny-schedule/shared';

const api: RendererApi = {
  dataLoad: () => Promise.reject(new Error('not wired')),
  taskUpsert: () => Promise.reject(new Error('not wired')),
  taskDelete: () => Promise.reject(new Error('not wired')),
  settingsUpdate: () => Promise.reject(new Error('not wired')),
  finishDay: () => Promise.reject(new Error('not wired')),
  timerSync: () => Promise.reject(new Error('not wired')),
  importRun: () => Promise.reject(new Error('not wired')),
  exportMarkdown: () => Promise.reject(new Error('not wired')),
  selectAvatar: () => Promise.reject(new Error('not wired')),
  aiRegistry: () => Promise.reject(new Error('not wired')),
  aiTestProvider: () => Promise.reject(new Error('not wired')),
  aiAnalyze: () => Promise.reject(new Error('not wired')),
  onAiEvent: () => () => {},
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, api);
```

- [ ] **Step 5: 渲染进程骨架**

`packages/app/src/renderer/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>Tiny-Schedule</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/app/src/renderer/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`packages/app/src/renderer/src/App.tsx`:

```tsx
export default function App() {
  return <div style={{ padding: 24, fontFamily: 'sans-serif' }}>Tiny-Schedule 启动成功</div>;
}
```

`packages/app/src/renderer/src/styles.css`:

```css
body {
  margin: 0;
}
```

- [ ] **Step 6: 手动验证**

Run: `bun run dev`（仓库根目录）
Expected: Electron 窗口打开，显示 “Tiny-Schedule 启动成功”；终端无报错。确认后手动关闭。

Run: `bun run typecheck && bun run lint`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add packages/app
git commit -m "feat(app): electron-vite shell with main, preload and renderer"
```

---

### Task 6: pino JSONL 日志

**Files:**
- Create: `packages/app/src/main/logger.ts`
- Test: `packages/app/src/main/__tests__/logger.test.ts`

**Interfaces:**
- Produces: `createLogger(logsDir: string)` → pino Logger；日志写 `<logsDir>/app.log`（pino-roll 每日滚动、保留 14 天、单文件 ≤5MB）。后续所有 main 服务通过依赖注入使用它，关键动作日志字段：`{ action: string, ...detail }`，**禁止记录 API key**。

- [ ] **Step 1: 安装依赖**

```bash
cd packages/app && bun add pino pino-roll
```

- [ ] **Step 2: 写失败测试**

`packages/app/src/main/__tests__/logger.test.ts`:

```ts
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createLogger } from '../logger';

describe('createLogger', () => {
  test('writes NDJSON lines to file in logs dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tslog-'));
    const logger = createLogger(dir);
    logger.info({ action: 'app:start' }, 'started');
    logger.info({ action: 'timer:start', taskId: 't1' });
    // pino with file transport writes async; give it a moment
    await new Promise((r) => setTimeout(r, 500));
    const files = readdirSync(dir).filter((f) => f.startsWith('app'));
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(join(dir, files[0] as string), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(lines[0] as string);
    expect(first.action).toBe('app:start');
    expect(first.level).toBe(30);
    expect(typeof first.time).toBe('number');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd packages/app && bun test src/main/__tests__/logger.test.ts`
Expected: FAIL — `Cannot find module '../logger'`

- [ ] **Step 4: 实现 logger.ts**

`packages/app/src/main/logger.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export function createLogger(logsDir: string): Logger {
  mkdirSync(logsDir, { recursive: true });
  return pino({
    level: 'info',
    transport: {
      target: 'pino-roll',
      options: {
        file: join(logsDir, 'app.log'),
        frequency: 'daily',
        size: '5M',
        limit: { count: 14 },
      },
    },
  });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/app && bun test src/main/__tests__/logger.test.ts`
Expected: PASS。注意 pino transport 跑在 worker 中，若 bun test 下不稳定，测试里已加 500ms 等待；仍失败则在 logger 中改用同步 target（`pino/file`）并保留滚动说明。

- [ ] **Step 6: 校验并提交**

Run: `bun run typecheck && bun run lint`
Expected: 通过。

```bash
git add packages/app
git commit -m "feat(main): pino JSONL logger with daily rotation"
```

---

### Task 7: DataStore（JSON 文档存储，原子写 + 备份回退）

**Files:**
- Create: `packages/app/src/main/dataStore.ts`
- Test: `packages/app/src/main/__tests__/dataStore.test.ts`

**Interfaces:**
- Consumes: `AppData`, `emptyAppData()`, `AppDataSchema` from shared。
- Produces: `class DataStore { constructor(dir: string); load(): AppData; save(data: AppData): void; get(): AppData; update(fn: (d: AppData) => AppData): AppData }`。`get()` 返回内存缓存；`update` 修改内存并持久化。文件：`<dir>/data.json`，备份 `<dir>/data.backup.json`。

- [ ] **Step 1: 写失败测试**

`packages/app/src/main/__tests__/dataStore.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { emptyAppData } from '@tiny-schedule/shared';
import { DataStore } from '../dataStore';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'tsdata-'));
}

describe('DataStore', () => {
  test('load returns empty data when no file exists', () => {
    const store = new DataStore(tmpDir());
    const d = store.load();
    expect(d.version).toBe(1);
    expect(Object.keys(d.tasks)).toHaveLength(0);
  });

  test('save persists to data.json and reload reads it back', () => {
    const dir = tmpDir();
    const store = new DataStore(dir);
    store.load();
    const d = store.update((cur) => ({ ...cur, tasks: { ...cur.tasks, t1: { ...emptyTask(), id: 't1' } } }));
    expect(d.tasks.t1?.id).toBe('t1');
    const reloaded = new DataStore(dir).load();
    expect(reloaded.tasks.t1?.id).toBe('t1');
    // no temp files left behind
    const raw = readFileSync(join(dir, 'data.json'), 'utf8');
    expect(JSON.parse(raw).version).toBe(1);
  });

  test('save keeps previous file as data.backup.json', () => {
    const dir = tmpDir();
    const s1 = new DataStore(dir);
    s1.load();
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'first' } }));
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'second' } }));
    const backup = JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8'));
    expect(backup.settings.userName).toBe('first');
    expect(new DataStore(dir).load().settings.userName).toBe('second');
  });

  test('corrupt data.json falls back to backup', () => {
    const dir = tmpDir();
    const s1 = new DataStore(dir);
    s1.load();
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'good' } }));
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'newer' } }));
    writeFileSync(join(dir, 'data.json'), '{{{ not json');
    const d = new DataStore(dir).load();
    expect(d.settings.userName).toBe('good');
  });

  test('corrupt data.json and no backup returns empty data', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{{{ not json');
    const d = new DataStore(dir).load();
    expect(d).toEqual(emptyAppData());
  });

  test('invalid schema falls back to empty data', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), JSON.stringify({ version: 99 }));
    const d = new DataStore(dir).load();
    expect(d.version).toBe(1);
  });
});

function emptyTask() {
  return {
    id: '', title: 'x', projectId: 'INBOX_PROJECT', tagIds: [], subTaskIds: [],
    isDone: false, timeEstimate: 0, timeSpent: 0, timeSpentOnDay: {},
    timeEntries: [], notes: '', created: 0,
  };
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/app && bun test src/main/__tests__/dataStore.test.ts`
Expected: FAIL — `Cannot find module '../dataStore'`

- [ ] **Step 3: 实现 dataStore.ts**

`packages/app/src/main/dataStore.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppDataSchema, emptyAppData, type AppData } from '@tiny-schedule/shared';

export class DataStore {
  private cache: AppData | null = null;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private get filePath(): string {
    return join(this.dir, 'data.json');
  }

  private get backupPath(): string {
    return join(this.dir, 'data.backup.json');
  }

  load(): AppData {
    this.cache = this.readValidated(this.filePath)
      ?? this.readValidated(this.backupPath)
      ?? emptyAppData();
    return this.cache;
  }

  get(): AppData {
    if (!this.cache) return this.load();
    return this.cache;
  }

  update(fn: (current: AppData) => AppData): AppData {
    const next = fn(this.get());
    this.save(next);
    return next;
  }

  save(data: AppData): void {
    const validated = AppDataSchema.parse(data);
    if (existsSync(this.filePath)) {
      copyFileSync(this.filePath, this.backupPath);
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(validated), 'utf8');
    renameSync(tmp, this.filePath); // atomic on POSIX
    this.cache = validated;
  }

  private readValidated(path: string): AppData | null {
    if (!existsSync(path)) return null;
    try {
      return AppDataSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return null;
    }
  }
}
```

注意：`AppDataSchema` 在 shared Task 4 已定义（含 `version: literal(1)` 校验）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/app && bun test src/main/__tests__/dataStore.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 校验并提交**

Run: `bun run typecheck && bun run lint`
Expected: 通过。

```bash
git add packages/app
git commit -m "feat(main): JSON DataStore with atomic writes and backup fallback"
```

---

### Task 8: Super Productivity 备份导入与归一化

**Files:**
- Create: `packages/app/src/main/importer.ts`
- Create: `packages/app/src/main/__tests__/fixtures/backup.fixture.json`
- Test: `packages/app/src/main/__tests__/importer.test.ts`

**Interfaces:**
- Produces: `normalizeBackup(raw: unknown): { data: AppData; counts: { tasks, projects, tags } }`（无效输入抛 `Error('INVALID_BACKUP: ...')`）；`mergeImport(current: AppData, imported: AppData): AppData`（整库覆盖任务/项目/标签/原始区块，保留当前 settings 与 activeTimer）。

- [ ] **Step 1: 创建 fixture**

`packages/app/src/main/__tests__/fixtures/backup.fixture.json`（按真实备份结构手工裁剪）:

```json
{
  "timestamp": 1785700000000,
  "lastUpdate": 1785700000000,
  "crossModelVersion": 12,
  "data": {
    "task": {
      "ids": ["t1", "t2", "t3"],
      "entities": {
        "t1": {
          "id": "t1", "title": "写周报", "projectId": "p1", "tagIds": ["TODAY"],
          "subTaskIds": ["t3"], "timeSpent": 1800000, "timeEstimate": 3600000,
          "timeSpentOnDay": { "2026-08-03": 1800000 }, "isDone": false,
          "created": 1785600000000, "attachments": [], "dueDay": "2026-08-04"
        },
        "t2": {
          "id": "t2", "title": "已完成任务", "projectId": "p1", "tagIds": [],
          "subTaskIds": [], "timeSpent": 600000, "timeEstimate": 0,
          "timeSpentOnDay": {}, "isDone": true, "created": 1785500000000, "attachments": []
        },
        "t3": {
          "id": "t3", "title": "子任务", "projectId": "p1", "tagIds": [],
          "subTaskIds": [], "timeSpent": 0, "timeEstimate": 0,
          "timeSpentOnDay": {}, "isDone": false, "created": 1785600001000, "attachments": []
        }
      },
      "currentTaskId": null, "isDataLoaded": true
    },
    "project": {
      "ids": ["INBOX_PROJECT", "p1"],
      "entities": {
        "INBOX_PROJECT": { "id": "INBOX_PROJECT", "title": "Inbox", "icon": "inbox", "isArchived": false, "theme": { "primary": "#aaa" } },
        "p1": { "id": "p1", "title": "工作", "icon": "work", "isArchived": false, "theme": { "primary": "rgb(144, 187, 165)" } }
      }
    },
    "tag": {
      "ids": ["TODAY", "EM_IMPORTANT", "custom1"],
      "entities": {
        "TODAY": { "id": "TODAY", "title": "Today", "taskIds": ["t1"] },
        "EM_IMPORTANT": { "id": "EM_IMPORTANT", "title": "Important", "taskIds": [] },
        "custom1": { "id": "custom1", "title": "学习", "color": "#3b82f6", "taskIds": [] }
      }
    },
    "note": { "ids": [], "entities": {}, "todayOrder": [] },
    "planner": { "days": { "2026-08-03": ["t1"] } },
    "metric": { "ids": [], "entities": {} },
    "boards": { "boardCfgs": [] },
    "timeTracking": { "tag": { "TODAY": { "2026-08-03": { "s": 1785600000000, "e": 1785603600000, "b": 1, "bt": 300000 } } } },
    "simpleCounter": { "ids": [], "entities": {} },
    "taskRepeatCfg": { "ids": [], "entities": {} },
    "globalConfig": { "misc": { "customTheme": "default" } }
  }
}
```

- [ ] **Step 2: 写失败测试**

`packages/app/src/main/__tests__/importer.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { emptyAppData, SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { mergeImport, normalizeBackup } from '../importer';
import fixture from './fixtures/backup.fixture.json';

describe('normalizeBackup', () => {
  test('maps tasks with all fields', () => {
    const { data, counts } = normalizeBackup(fixture);
    expect(counts).toEqual({ tasks: 3, projects: 2, tags: 3 });
    const t1 = data.tasks.t1;
    expect(t1?.title).toBe('写周报');
    expect(t1?.timeSpent).toBe(1_800_000);
    expect(t1?.timeEstimate).toBe(3_600_000);
    expect(t1?.timeSpentOnDay['2026-08-03']).toBe(1_800_000);
    expect(t1?.dueDay).toBe('2026-08-04');
    expect(t1?.tagIds).toEqual(['TODAY']);
    expect(t1?.subTaskIds).toEqual(['t3']);
    expect(t1?.timeEntries).toEqual([]);
    expect(data.tasks.t3?.parentTaskId).toBe('t1');
    expect(data.tasks.t2?.isDone).toBe(true);
  });

  test('maps projects and keeps system tags', () => {
    const { data } = normalizeBackup(fixture);
    expect(data.projects.p1?.title).toBe('工作');
    expect(data.projects.p1?.primaryColor).toBe('rgb(144, 187, 165)');
    expect(data.tags[SYSTEM_TAG_IDS.today]?.title).toBe('Today');
    expect(data.tags.custom1?.title).toBe('学习');
  });

  test('preserves raw sections', () => {
    const { data } = normalizeBackup(fixture);
    expect(data.timeTracking).toEqual(fixture.data.timeTracking);
    expect(data.planner).toEqual(fixture.data.planner);
    expect(data.misc.simpleCounter).toEqual(fixture.data.simpleCounter);
  });

  test('task without projectId falls back to INBOX_PROJECT', () => {
    const broken = structuredClone(fixture);
    delete broken.data.task.entities.t2.projectId;
    const { data } = normalizeBackup(broken);
    expect(data.tasks.t2?.projectId).toBe('INBOX_PROJECT');
  });

  test('rejects invalid backups', () => {
    expect(() => normalizeBackup(null)).toThrow('INVALID_BACKUP');
    expect(() => normalizeBackup({ data: {} })).toThrow('INVALID_BACKUP');
    expect(() => normalizeBackup({ data: { task: { entities: 'x' } } })).toThrow('INVALID_BACKUP');
  });
});

describe('mergeImport', () => {
  test('replaces tasks/projects/tags but keeps settings and timer', () => {
    const current = emptyAppData();
    current.settings.userName = 'me';
    current.activeTimer = { taskId: 'x', startedAt: 1, accumulatedMs: 0, isPaused: false };
    const { data: imported } = normalizeBackup(fixture);
    const merged = mergeImport(current, imported);
    expect(merged.settings.userName).toBe('me');
    expect(merged.activeTimer?.taskId).toBe('x');
    expect(Object.keys(merged.tasks)).toHaveLength(3);
    expect(merged.projects.p1?.title).toBe('工作');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd packages/app && bun test src/main/__tests__/importer.test.ts`
Expected: FAIL — `Cannot find module '../importer'`

- [ ] **Step 4: 实现 importer.ts**

`packages/app/src/main/importer.ts`:

```ts
import {
  defaultSettings,
  INBOX_PROJECT_ID,
  type AppData,
  type Project,
  type Tag,
  type Task,
} from '@tiny-schedule/shared';

interface RawEntities<T> {
  ids?: unknown;
  entities?: Record<string, T & { id?: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface ImportCounts {
  tasks: number;
  projects: number;
  tags: number;
}

export function normalizeBackup(raw: unknown): { data: AppData; counts: ImportCounts } {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new Error('INVALID_BACKUP: missing data object');
  }
  const d = raw.data;
  const rawTasks = d.task as RawEntities<Record<string, unknown>> | undefined;
  const rawProjects = d.project as RawEntities<Record<string, unknown>> | undefined;
  const rawTags = d.tag as RawEntities<Record<string, unknown>> | undefined;
  if (!isRecord(rawTasks?.entities) || !isRecord(rawProjects?.entities) || !isRecord(rawTags?.entities)) {
    throw new Error('INVALID_BACKUP: missing task/project/tag entities');
  }

  const tasks: Record<string, Task> = {};
  for (const [id, t] of Object.entries(rawTasks.entities)) {
    tasks[id] = {
      id,
      title: typeof t.title === 'string' ? t.title : '(untitled)',
      projectId: typeof t.projectId === 'string' && t.projectId.length > 0 ? t.projectId : INBOX_PROJECT_ID,
      tagIds: Array.isArray(t.tagIds) ? (t.tagIds as string[]).filter((x) => typeof x === 'string') : [],
      subTaskIds: Array.isArray(t.subTaskIds) ? (t.subTaskIds as string[]) : [],
      isDone: t.isDone === true,
      dueDay: typeof t.dueDay === 'string' ? t.dueDay : undefined,
      timeEstimate: typeof t.timeEstimate === 'number' ? t.timeEstimate : 0,
      timeSpent: typeof t.timeSpent === 'number' ? t.timeSpent : 0,
      timeSpentOnDay: isRecord(t.timeSpentOnDay)
        ? Object.fromEntries(Object.entries(t.timeSpentOnDay as Record<string, unknown>).filter(([, v]) => typeof v === 'number') as [string, number][])
        : {},
      timeEntries: [],
      notes: typeof t.notes === 'string' ? t.notes : '',
      created: typeof t.created === 'number' ? t.created : Date.now(),
    };
  }
  // derive parentTaskId from subTaskIds
  for (const parent of Object.values(tasks)) {
    for (const subId of parent.subTaskIds) {
      const sub = tasks[subId];
      if (sub) sub.parentTaskId = parent.id;
    }
  }

  const projects: Record<string, Project> = {};
  for (const [id, p] of Object.entries(rawProjects.entities)) {
    const theme = isRecord(p.theme) ? p.theme : {};
    projects[id] = {
      id,
      title: typeof p.title === 'string' ? p.title : id,
      icon: typeof p.icon === 'string' ? p.icon : undefined,
      isArchived: p.isArchived === true,
      primaryColor: typeof theme.primary === 'string' ? theme.primary : undefined,
    };
  }
  if (!projects[INBOX_PROJECT_ID]) {
    projects[INBOX_PROJECT_ID] = { id: INBOX_PROJECT_ID, title: 'Inbox', icon: 'inbox', isArchived: false };
  }

  const tags: Record<string, Tag> = {};
  for (const [id, tg] of Object.entries(rawTags.entities)) {
    tags[id] = {
      id,
      title: typeof tg.title === 'string' ? tg.title : id,
      color: typeof tg.color === 'string' ? tg.color : undefined,
    };
  }

  const data: AppData = {
    version: 1,
    tasks,
    projects,
    tags,
    timeTracking: d.timeTracking ?? null,
    notes: d.note ?? null,
    planner: d.planner ?? null,
    metric: d.metric ?? null,
    boards: d.boards ?? null,
    misc: {
      simpleCounter: d.simpleCounter ?? null,
      taskRepeatCfg: d.taskRepeatCfg ?? null,
      issueProvider: d.issueProvider ?? null,
      reminders: d.reminders ?? null,
      menuTree: d.menuTree ?? null,
      importedAt: Date.now(),
    },
    settings: defaultSettings(),
    activeTimer: null,
  };

  return {
    data,
    counts: { tasks: Object.keys(tasks).length, projects: Object.keys(projects).length, tags: Object.keys(tags).length },
  };
}

/** Whole-library import: replace content, keep current settings + running timer. */
export function mergeImport(current: AppData, imported: AppData): AppData {
  return {
    ...imported,
    settings: current.settings,
    activeTimer: current.activeTimer,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/app && bun test src/main/__tests__/importer.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 6: 校验并提交**

Run: `bun run typecheck && bun run lint`
Expected: 通过。

```bash
git add packages/app
git commit -m "feat(main): normalize and merge Super Productivity backups"
```

---

### Task 9: Markdown 导出（项目任务清单 + 工作日志）

**Files:**
- Create: `packages/app/src/main/exporter.ts`, `packages/app/src/main/duration.ts`
- Test: `packages/app/src/main/__tests__/exporter.test.ts`

**Interfaces:**
- Produces: `formatDuration(ms): string`（如 `1h 30m` / `45m` / `0s`）、`exportProjectTaskList(data, projectId): string`、`exportWorklog(data, { from, to, projectId? }): string`。Task 12 的 export:markdown handler 调用它们。

- [ ] **Step 1: 写失败测试**

`packages/app/src/main/__tests__/exporter.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { emptyAppData, type AppData, type Task } from '@tiny-schedule/shared';
import { formatDuration } from '../duration';
import { exportProjectTaskList, exportWorklog } from '../exporter';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 't1', title: '任务A', projectId: 'p1', tagIds: ['TAGX'], subTaskIds: [],
    isDone: false, timeEstimate: 7_200_000, timeSpent: 3_600_000,
    timeSpentOnDay: {}, timeEntries: [], notes: '', created: 0, ...overrides,
  };
}

function makeData(tasks: Task[], withTag = true): AppData {
  const d = emptyAppData();
  d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
  if (withTag) d.tags.TAGX = { id: 'TAGX', title: '学习' };
  for (const t of tasks) d.tasks[t.id] = t;
  return d;
}

describe('formatDuration', () => {
  test('formats h/m/s', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45_000)).toBe('0m');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(7_200_000)).toBe('2h');
  });
});

describe('exportProjectTaskList', () => {
  test('groups by done state with metadata', () => {
    const open = makeTask({ id: 't1', dueDay: '2026-08-05' });
    const done = makeTask({ id: 't2', title: '任务B', isDone: true, tagIds: [] });
    const md = exportProjectTaskList(makeData([done, open]), 'p1');
    expect(md).toContain('# 工作');
    expect(md).toContain('## 进行中');
    expect(md).toContain('- [ ] 任务A');
    expect(md).toContain('`学习`');
    expect(md).toContain('截止 2026-08-05');
    expect(md).toContain('预估 2h');
    expect(md).toContain('实际 1h');
    expect(md).toContain('## 已完成');
    expect(md).toContain('- [x] 任务B');
    // done section appears after open section
    expect(md.indexOf('## 已完成')).toBeGreaterThan(md.indexOf('## 进行中'));
  });

  test('throws for unknown project', () => {
    expect(() => exportProjectTaskList(makeData([]), 'nope')).toThrow('UNKNOWN_PROJECT');
  });
});

describe('exportWorklog', () => {
  test('lists days in range with totals and day window', () => {
    const t = makeTask({
      timeSpentOnDay: { '2026-08-03': 3_600_000, '2026-08-04': 1_800_000 },
    });
    const d = makeData([t]);
    d.timeTracking = { tag: { TODAY: { '2026-08-03': { s: 1785600000000, e: 1785603600000 } } } };
    const md = exportWorklog(d, { from: '2026-08-03', to: '2026-08-04' });
    expect(md).toContain('# 工作日志');
    expect(md).toContain('## 2026-08-03');
    expect(md).toContain('合计 1h');
    expect(md).toContain('- 任务A | 1h');
    expect(md).toContain('## 2026-08-04');
    expect(md).toContain('合计 30m');
    expect(md).not.toContain('## 2026-08-05');
  });

  test('empty range produces empty-state message', () => {
    const md = exportWorklog(makeData([]), { from: '2026-08-01', to: '2026-08-02' });
    expect(md).toContain('没有工作记录');
  });

  test('projectId filter limits tasks', () => {
    const t1 = makeTask({ id: 't1', projectId: 'p1', timeSpentOnDay: { '2026-08-03': 3_600_000 } });
    const t2 = makeTask({ id: 't2', projectId: 'p2', timeSpentOnDay: { '2026-08-03': 2000 } });
    const d = makeData([t1, t2]);
    d.projects.p2 = { id: 'p2', title: '其他', isArchived: false };
    const md = exportWorklog(d, { from: '2026-08-03', to: '2026-08-03', projectId: 'p1' });
    expect(md).toContain('任务A');
    expect(md).toContain('合计 1h');
    expect(md).not.toContain('合计 0m');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/app && bun test src/main/__tests__/exporter.test.ts`
Expected: FAIL — `Cannot find module '../exporter'`

- [ ] **Step 3: 实现 duration.ts 与 exporter.ts**

`packages/app/src/main/duration.ts`:

```ts
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
}
```

`packages/app/src/main/exporter.ts`:

```ts
import type { AppData, Task } from '@tiny-schedule/shared';
import { formatClock, formatDuration } from './duration';

function tagLabel(data: AppData, tagId: string): string | null {
  const tag = data.tags[tagId];
  return tag ? `\`${tag.title}\`` : null;
}

function taskLine(data: AppData, t: Task): string {
  const parts: string[] = [];
  const tags = t.tagIds.map((id) => tagLabel(data, id)).filter(Boolean);
  if (tags.length > 0) parts.push(tags.join(' '));
  if (t.dueDay) parts.push(`截止 ${t.dueDay}`);
  if (t.timeEstimate > 0) parts.push(`预估 ${formatDuration(t.timeEstimate)}`);
  if (t.timeSpent > 0) parts.push(`实际 ${formatDuration(t.timeSpent)}`);
  const suffix = parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
  return `- [${t.isDone ? 'x' : ' '}] ${t.title}${suffix}`;
}

export function exportProjectTaskList(data: AppData, projectId: string): string {
  const project = data.projects[projectId];
  if (!project) throw new Error(`UNKNOWN_PROJECT: ${projectId}`);
  const tasks = Object.values(data.tasks).filter((t) => t.projectId === projectId && !t.parentTaskId);
  const open = tasks.filter((t) => !t.isDone);
  const done = tasks.filter((t) => t.isDone);
  const lines = [
    `# ${project.title}`,
    '',
    `> 导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 进行中',
    ...(open.length > 0 ? open.map((t) => taskLine(data, t)) : ['（无）']),
    '',
    '## 已完成',
    ...(done.length > 0 ? done.map((t) => taskLine(data, t)) : ['（无）']),
    '',
  ];
  return lines.join('\n');
}

interface WorklogOptions {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  projectId?: string;
}

function dayWindow(data: AppData, date: string): string | null {
  const tt = data.timeTracking as { tag?: Record<string, Record<string, { s?: number; e?: number }>> } | null;
  const entry = tt?.tag?.TODAY?.[date];
  if (!entry?.s || !entry?.e) return null;
  return `工作时间：${formatClock(entry.s)} - ${formatClock(entry.e)}`;
}

export function exportWorklog(data: AppData, opts: WorklogOptions): string {
  const { from, to, projectId } = opts;
  const dates: string[] = [];
  for (const t of Object.values(data.tasks)) {
    if (projectId && t.projectId !== projectId) continue;
    for (const date of Object.keys(t.timeSpentOnDay)) {
      if (date >= from && date <= to) dates.push(date);
    }
  }
  const uniqueDates = [...new Set(dates)].sort();

  const lines = [`# 工作日志 ${from} ~ ${to}`, ''];
  if (uniqueDates.length === 0) {
    lines.push('该时间段没有工作记录。', '');
    return lines.join('\n');
  }
  for (const date of uniqueDates) {
    const dayTasks = Object.values(data.tasks).filter((t) => {
      if (projectId && t.projectId !== projectId) return false;
      return (t.timeSpentOnDay[date] ?? 0) > 0;
    });
    const total = dayTasks.reduce((sum, t) => sum + (t.timeSpentOnDay[date] ?? 0), 0);
    lines.push(`## ${date}（合计 ${formatDuration(total)}）`);
    const window = dayWindow(data, date);
    if (window) lines.push(window);
    for (const t of dayTasks) {
      lines.push(`- ${t.title} | ${formatDuration(t.timeSpentOnDay[date] ?? 0)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/app && bun test src/main/__tests__/exporter.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: 校验并提交**

Run: `bun run typecheck && bun run lint`
Expected: 通过。

```bash
git add packages/app
git commit -m "feat(main): markdown export for project task lists and worklogs"
```

---

### Task 10: AI Provider 注册表与 Prompt 渲染

**Files:**
- Create: `packages/app/src/main/ai/providers.ts`, `packages/app/src/main/ai/prompts.ts`
- Test: `packages/app/src/main/__tests__/prompts.test.ts`

**Interfaces:**
- Produces: `PROVIDER_REGISTRY: ProviderDef[]`（`{ id, name, icon, baseUrl, models }`）、`getProviderDef(id)`、`DEFAULT_PROMPT`、`renderPrompt(template, vars)`、`buildAnalysisData(data, scope): string`。Task 11 的客户端与 Task 12 的 handler 依赖。

- [ ] **Step 1: 实现 providers.ts（无测试——静态数据）**

`packages/app/src/main/ai/providers.ts`:

```ts
import type { ProviderInfo } from '@tiny-schedule/shared';

export interface ProviderDef extends ProviderInfo {
  baseUrl: string;
}

// 新增 Provider 只需在此数组加一条（OpenAI 兼容协议）
export const PROVIDER_REGISTRY: ProviderDef[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    icon: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    icon: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    icon: 'custom',
    baseUrl: '',
    models: [],
  },
];

export function getProviderDef(id: string): ProviderDef | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id);
}

export function toProviderInfo(def: ProviderDef): ProviderInfo {
  return { id: def.id, name: def.name, icon: def.icon, models: def.models };
}
```

注意：`custom` 的 `baseUrl` 为空，表示用户需在设置里填自定义 baseUrl —— 因此 `AiProviderConfig` 需要 baseUrl 字段。回到 shared 补充：在 `packages/shared/src/models.ts` 的 `AiProviderConfig` 增加 `baseUrl?: string`，在 `packages/shared/src/ipc.ts` 的 `AiProviderSchema` 与 `SettingsUpdateReqSchema.aiProviders` 元素中增加 `baseUrl: z.string().optional()`。补完后重跑 `cd packages/shared && bun test` 确认仍全绿。

- [ ] **Step 2: 写失败测试**

`packages/app/src/main/__tests__/prompts.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { emptyAppData, SYSTEM_TAG_IDS, type Task } from '@tiny-schedule/shared';
import { buildAnalysisData, DEFAULT_PROMPT, renderPrompt } from '../ai/prompts';

function task(overrides: Partial<Task>): Task {
  return {
    id: 't1', title: '写周报', projectId: 'p1', tagIds: [], subTaskIds: [],
    isDone: false, timeEstimate: 3_600_000, timeSpent: 1_800_000,
    timeSpentOnDay: { '2026-08-04': 1_800_000 }, timeEntries: [], notes: '', created: 0,
    ...overrides,
  };
}

describe('renderPrompt', () => {
  test('replaces placeholders', () => {
    const out = renderPrompt('日期 {{date}} 数据 {{data}}', { date: '2026-08-04', data: '[]' });
    expect(out).toBe('日期 2026-08-04 数据 []');
  });

  test('empty template falls back to default', () => {
    const out = renderPrompt('', { date: '2026-08-04', data: '[]' });
    expect(out).toContain('2026-08-04');
    expect(out).toContain('[]');
    expect(out).toBe(renderPrompt(DEFAULT_PROMPT, { date: '2026-08-04', data: '[]' }));
  });
});

describe('buildAnalysisData', () => {
  test('today scope filters tasks touched today', () => {
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.tasks.t1 = task({});
    d.tasks.t2 = task({ id: 't2', title: '无关任务', timeSpentOnDay: { '2026-01-01': 100 } });
    const json = JSON.parse(buildAnalysisData(d, { scope: 'today', date: '2026-08-04' }));
    expect(json.tasks).toHaveLength(1);
    expect(json.tasks[0].title).toBe('写周报');
    expect(json.summary.totalSpentMs).toBe(1_800_000);
    expect(json.summary.doneCount).toBe(0);
  });

  test('week scope uses date range on timeSpentOnDay or dueDay', () => {
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.tasks.t1 = task({ timeSpentOnDay: { '2026-08-03': 100 } });
    d.tasks.t2 = task({ id: 't2', title: '只有截止日', dueDay: '2026-08-05', timeSpent: 0, timeSpentOnDay: {} });
    const json = JSON.parse(buildAnalysisData(d, { scope: 'week', date: '2026-08-04' }));
    expect(json.tasks.map((t: { title: string }) => t.title).sort()).toEqual(['只有截止日', '写周报']);
  });

  test('project scope filters by projectId', () => {
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.projects.p2 = { id: 'p2', title: '其他', isArchived: false };
    d.tasks.t1 = task({});
    d.tasks.t2 = task({ id: 't2', projectId: 'p2' });
    const json = JSON.parse(buildAnalysisData(d, { scope: 'project', date: '2026-08-04', projectId: 'p2' }));
    expect(json.tasks).toHaveLength(1);
    expect(json.project).toBe('其他');
  });

  test('includes tag titles and system tag mapping', () => {
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.tasks.t1 = task({ tagIds: [SYSTEM_TAG_IDS.today] });
    const json = JSON.parse(buildAnalysisData(d, { scope: 'today', date: '2026-08-04' }));
    expect(json.tasks[0].tags).toEqual(['Today']);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd packages/app && bun test src/main/__tests__/prompts.test.ts`
Expected: FAIL — `Cannot find module '../ai/prompts'`

- [ ] **Step 4: 实现 prompts.ts**

`packages/app/src/main/ai/prompts.ts`:

```ts
import type { AppData } from '@tiny-schedule/shared';
import { localDate } from '@tiny-schedule/shared';

export const DEFAULT_PROMPT = `你是一个效率分析助手。以下是用户 {{date}} 的任务与时间数据（JSON）：

{{data}}

请生成一份 Markdown 格式的报告，包含：
1. 概览：完成任务数、总耗时、时间主要花在哪里
2. 亮点与问题：各 1-2 条
3. 建议：2-3 条可执行的下一步
保持简洁，总长度不超过 300 字。`;

export interface PromptVars {
  date: string;
  data: string;
}

export function renderPrompt(template: string, vars: PromptVars): string {
  const tpl = template.trim().length > 0 ? template : DEFAULT_PROMPT;
  return tpl.replaceAll('{{date}}', vars.date).replaceAll('{{data}}', vars.data);
}

export interface AnalysisScope {
  scope: 'today' | 'week' | 'project';
  date: string; // anchor date YYYY-MM-DD
  projectId?: string;
}

function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return localDate(new Date(y, m - 1, d + delta).getTime());
}

function touchesRange(t: { timeSpentOnDay: Record<string, number>; dueDay?: string }, from: string, to: string): boolean {
  for (const day of Object.keys(t.timeSpentOnDay)) {
    if (day >= from && day <= to) return true;
  }
  return !!t.dueDay && t.dueDay >= from && t.dueDay <= to;
}

export function buildAnalysisData(data: AppData, scope: AnalysisScope): string {
  let from = scope.date;
  let to = scope.date;
  if (scope.scope === 'week') {
    const dow = new Date(scope.date).getDay(); // 0 = Sunday
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    from = addDays(scope.date, mondayOffset);
    to = addDays(from, 6);
  }

  const tasks = Object.values(data.tasks)
    .filter((t) => !t.parentTaskId)
    .filter((t) => {
      if (scope.scope === 'project') return t.projectId === scope.projectId;
      return touchesRange(t, from, to);
    })
    .map((t) => ({
      title: t.title,
      isDone: t.isDone,
      project: data.projects[t.projectId]?.title ?? t.projectId,
      tags: t.tagIds.map((id) => data.tags[id]?.title ?? id),
      dueDay: t.dueDay,
      timeEstimateMs: t.timeEstimate,
      timeSpentMs: t.timeSpent,
      timeSpentInRangeMs: Object.entries(t.timeSpentOnDay)
        .filter(([day]) => day >= from && day <= to)
        .reduce((sum, [, ms]) => sum + ms, 0),
    }));

  const payload = {
    range: scope.scope === 'today' ? scope.date : `${from} ~ ${to}`,
    project: scope.scope === 'project' ? (data.projects[scope.projectId ?? '']?.title ?? scope.projectId) : undefined,
    summary: {
      taskCount: tasks.length,
      doneCount: tasks.filter((t) => t.isDone).length,
      totalSpentMs: tasks.reduce((s, t) => s + t.timeSpentInRangeMs, 0),
    },
    tasks,
  };
  return JSON.stringify(payload, null, 2);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/app && bun test src/main/__tests__/prompts.test.ts && cd packages/shared && bun test`
Expected: 全部 PASS。

- [ ] **Step 6: 校验并提交**

Run: `bun run typecheck && bun run lint`
Expected: 通过。

```bash
git add packages/shared packages/app
git commit -m "feat(ai): provider registry and prompt rendering with analysis data builder"
```

---

### Task 11: OpenAI 流式客户端（分段超时）

**Files:**
- Create: `packages/app/src/main/ai/client.ts`
- Test: `packages/app/src/main/__tests__/aiClient.test.ts`

**Interfaces:**
- Produces: `streamChat(opts: StreamChatOptions): AsyncGenerator<string>`；opts 含 `{ baseUrl, apiKey, model, messages, fetchImpl?, firstTokenTimeoutMs?, idleTimeoutMs? }`。超时语义：首 token 默认 30s；每个 chunk 重置空闲计时（默认 60s）；无总时长上限。超时抛出 `Error('FIRST_TOKEN_TIMEOUT')` / `Error('IDLE_TIMEOUT')`；HTTP 非 2xx 抛 `Error('AI_HTTP_<status>')`。

- [ ] **Step 1: 写失败测试**

`packages/app/src/main/__tests__/aiClient.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { streamChat } from '../ai/client';

function sseStream(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(encoder.encode(chunks[i] as string));
      i += 1;
    },
  });
}

const okHeaders = { 'content-type': 'text/event-stream' };

function fakeFetch(body: ReadableStream<Uint8Array>, status = 200) {
  return async (_url: string, _init: RequestInit): Promise<Response> =>
    new Response(body, { status, headers: okHeaders });
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const c of gen) out += c;
  return out;
}

describe('streamChat', () => {
  test('yields deltas from SSE lines and stops at [DONE]', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\ndata: [DONE]\n\n',
    ]);
    const gen = streamChat({
      baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch(body),
    });
    expect(await collect(gen)).toBe('你好，世界');
  });

  test('handles chunks split across SSE boundaries', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"cont',
      'ent":"AB"}}]}\n\ndata: [DONE]\n\n',
    ]);
    const gen = streamChat({
      baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch(body),
    });
    expect(await collect(gen)).toBe('AB');
  });

  test('throws AI_HTTP_401 on unauthorized', async () => {
    const gen = streamChat({
      baseUrl: 'http://x/v1', apiKey: 'bad', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch(sseStream([]), 401),
    });
    await expect(collect(gen)).rejects.toThrow('AI_HTTP_401');
  });

  test('throws FIRST_TOKEN_TIMEOUT when no data arrives', async () => {
    let aborted = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.close(), 200);
      },
      cancel() { aborted = true; },
    });
    const gen = streamChat({
      baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch(stalled),
      firstTokenTimeoutMs: 50,
    });
    await expect(collect(gen)).rejects.toThrow('FIRST_TOKEN_TIMEOUT');
  });

  test('slow but steady stream is NOT aborted', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: [DONE]\n\n',
    ], 30); // each chunk slower than idle check granularity but under idle timeout
    const gen = streamChat({
      baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch(body),
      firstTokenTimeoutMs: 500,
      idleTimeoutMs: 500,
    });
    expect(await collect(gen)).toBe('ab');
  });

  test('sends expected request shape', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fetchImpl = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(sseStream(['data: [DONE]\n\n']), { status: 200, headers: okHeaders });
    };
    await collect(streamChat({
      baseUrl: 'http://x/v1', apiKey: 'sk-1', model: 'gpt-x',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    }));
    expect(captured.url).toBe('http://x/v1/chat/completions');
    expect((captured.init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-1');
    const body = JSON.parse(captured.init?.body as string);
    expect(body.model).toBe('gpt-x');
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toBe('hi');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/app && bun test src/main/__tests__/aiClient.test.ts`
Expected: FAIL — `Cannot find module '../ai/client'`

- [ ] **Step 3: 实现 client.ts**

`packages/app/src/main/ai/client.ts`:

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  fetchImpl?: typeof fetch;
  firstTokenTimeoutMs?: number; // default 30_000
  idleTimeoutMs?: number; // default 60_000
}

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const firstTokenMs = opts.firstTokenTimeoutMs ?? 30_000;
  const idleMs = opts.idleTimeoutMs ?? 60_000;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let receivedFirst = false;
  let abortError: Error | undefined;
  const controller = new AbortController();

  const schedule = (ms: number, kind: 'FIRST_TOKEN_TIMEOUT' | 'IDLE_TIMEOUT') => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      abortError = new Error(kind);
      controller.abort();
    }, ms);
  };

  schedule(firstTokenMs, 'FIRST_TOKEN_TIMEOUT');

  const res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true }),
    signal: controller.signal,
  }).catch((err: unknown) => {
    if (abortError) throw abortError;
    throw err instanceof Error ? err : new Error(String(err));
  });

  if (!res.ok || !res.body) {
    if (timeout) clearTimeout(timeout);
    throw new Error(`AI_HTTP_${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read().catch((err: unknown) => {
        if (abortError) throw abortError;
        throw err;
      });
      if (done) break;
      schedule(idleMs, 'IDLE_TIMEOUT');
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            if (!receivedFirst) {
              receivedFirst = true;
              schedule(idleMs, 'IDLE_TIMEOUT');
            }
            yield delta;
          }
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
}

/** Lightweight connectivity check used by “连接测试”. */
export async function testConnection(baseUrl: string, apiKey: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean; error?: string }> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/app && bun test src/main/__tests__/aiClient.test.ts`
Expected: PASS（6 tests）。若 FIRST_TOKEN_TIMEOUT 用例因流提前 close 而不触发，调整 stalled 流使其挂起超过 50ms 后再 close。

- [ ] **Step 5: 校验并提交**

Run: `bun run typecheck && bun run lint`
Expected: 通过。

```bash
git add packages/app
git commit -m "feat(ai): streaming chat client with staged first-token and idle timeouts"
```

---

### Task 12: IPC 接线（main handlers + preload + 渲染进程客户端）

**Files:**
- Create: `packages/app/src/main/ipcHandlers.ts`, `packages/app/src/main/keys.ts`, `packages/app/src/renderer/src/api.ts`
- Modify: `packages/app/src/main/main.ts`, `packages/app/src/preload/index.ts`

**Interfaces:**
- Consumes: DataStore、createLogger、normalizeBackup/mergeImport、exporter、providers/prompts/streamChat（Task 6-11）；`Ipc`、schemas、`maskDataForRenderer`（Task 4）。
- Produces: `registerIpcHandlers(deps)`、`encryptKey/decryptKey`；渲染进程通过 `window.tinyApi`（`api()` helper）访问全部功能。safeStorage 加密 API key（`keys.ts`）。

- [ ] **Step 1: keys.ts（safeStorage 加密）**

`packages/app/src/main/keys.ts`:

```ts
import { safeStorage } from 'electron';

export function encryptKey(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) return Buffer.from(plain, 'utf8').toString('base64');
  return safeStorage.encryptString(plain).toString('base64');
}

export function decryptKey(encryptedB64: string): string {
  if (!safeStorage.isEncryptionAvailable()) return Buffer.from(encryptedB64, 'base64').toString('utf8');
  return safeStorage.decryptString(Buffer.from(encryptedB64, 'base64'));
}
```

- [ ] **Step 2: ipcHandlers.ts**

`packages/app/src/main/ipcHandlers.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import {
  type AiAnalyzeReq,
  AiAnalyzeReqSchema,
  type AppData,
  applySettlement,
  dialog,
  type ExportMarkdownReq,
  ExportMarkdownReqSchema,
  type ImportRunResult,
  Ipc,
  maskDataForRenderer,
  type SettingsUpdateReq,
  SettingsUpdateReqSchema,
  settleTimer,
  SYSTEM_TAG_IDS,
  TaskDeleteReqSchema,
  TaskSchema,
  TimerSyncReqSchema,
  localDate,
} from '@tiny-schedule/shared';
import { BrowserWindow, dialog as electronDialog, ipcMain, safeStorage } from 'electron';
import type { DataStore } from './dataStore';
import { exportProjectTaskList, exportWorklog } from './exporter';
import { mergeImport, normalizeBackup } from './importer';
import { streamChat, testConnection } from './ai/client';
import { buildAnalysisData, renderPrompt } from './ai/prompts';
import { getProviderDef, PROVIDER_REGISTRY, toProviderInfo } from './ai/providers';
import { decryptKey, encryptKey } from './keys';

export interface IpcDeps {
  store: DataStore;
  logger: Logger;
  getWindow: () => BrowserWindow | null;
}

function masked(data: AppData): AppData {
  return maskDataForRenderer(data);
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { store, logger, getWindow } = deps;

  ipcMain.handle(Ipc.dataLoad, () => masked(store.get()));

  ipcMain.handle(Ipc.taskUpsert, (_e, raw: unknown) => {
    const task = TaskSchema.parse(raw);
    const next = store.update((d) => ({ ...d, tasks: { ...d.tasks, [task.id]: task } }));
    logger.info({ action: 'task:upsert', taskId: task.id, title: task.title });
    return masked(next);
  });

  ipcMain.handle(Ipc.taskDelete, (_e, raw: unknown) => {
    const { id } = TaskDeleteReqSchema.parse(raw);
    const next = store.update((d) => {
      const tasks = { ...d.tasks };
      delete tasks[id];
      // detach from parent's subTaskIds
      for (const t of Object.values(tasks)) {
        if (t.subTaskIds.includes(id)) {
          tasks[t.id] = { ...t, subTaskIds: t.subTaskIds.filter((s) => s !== id) };
        }
      }
      return { ...d, tasks };
    });
    logger.info({ action: 'task:delete', taskId: id });
    return masked(next);
  });

  ipcMain.handle(Ipc.settingsUpdate, (_e, raw: unknown) => {
    const patch = SettingsUpdateReqSchema.parse(raw);
    const next = store.update((d) => {
      const settings = { ...d.settings };
      if (patch.userName !== undefined) settings.userName = patch.userName;
      if (patch.avatar !== undefined) settings.avatar = patch.avatar;
      if (patch.theme !== undefined) settings.theme = patch.theme;
      if (patch.aiPrompt !== undefined) settings.aiPrompt = patch.aiPrompt;
      if (patch.autoAiAnalyzeOnFinishDay !== undefined) {
        settings.autoAiAnalyzeOnFinishDay = patch.autoAiAnalyzeOnFinishDay;
      }
      if (patch.aiProviders !== undefined) {
        settings.aiProviders = patch.aiProviders.map((p) => ({
          id: p.id,
          registryId: p.registryId,
          baseUrl: p.baseUrl,
          apiKeyEncrypted: encryptKey(p.apiKey),
          model: p.model,
          isDefault: p.isDefault,
        }));
      }
      return { ...d, settings };
    });
    logger.info({ action: 'settings:update', keys: Object.keys(patch) });
    return masked(next);
  });

  ipcMain.handle(Ipc.timerSync, (_e, raw: unknown) => {
    const { timer } = TimerSyncReqSchema.parse(raw);
    store.update((d) => ({ ...d, activeTimer: timer }));
    if (timer) logger.info({ action: 'timer:sync', taskId: timer.taskId, isPaused: timer.isPaused });
  });

  ipcMain.handle(Ipc.finishDay, () => {
    const today = localDate(Date.now());
    const next = store.update((d) => {
      const tasks = { ...d.tasks };
      for (const t of Object.values(tasks)) {
        if (!t.isDone && t.tagIds.includes(SYSTEM_TAG_IDS.today)) {
          tasks[t.id] = { ...t, tagIds: t.tagIds.filter((id) => id !== SYSTEM_TAG_IDS.today) };
        }
      }
      return { ...d, tasks, misc: { ...d.misc, lastFinishDay: today } };
    });
    logger.info({ action: 'day:finish', date: today });
    return masked(next);
  });

  ipcMain.handle(Ipc.importRun, async (): Promise<ImportRunResult> => {
    const win = getWindow();
    if (!win) return { ok: false, error: 'NO_WINDOW' };
    const picked = await electronDialog.showOpenDialog(win, {
      title: '导入 Super Productivity 备份',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: 'CANCELLED' };
    try {
      const raw = JSON.parse(await readFile(picked.filePaths[0] as string, 'utf8'));
      const { data: imported, counts } = normalizeBackup(raw);
      const next = store.update((d) => mergeImport(d, imported));
      logger.info({ action: 'import:run', counts, file: picked.filePaths[0] });
      void next;
      return { ok: true, counts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ action: 'import:run', error: message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(Ipc.exportMarkdown, async (_e, raw: unknown) => {
    const req = ExportMarkdownReqSchema.parse(raw);
    const win = getWindow();
    if (!win) return { savedPath: null, error: 'NO_WINDOW' };
    const data = store.get();
    let content: string;
    let defaultName: string;
    try {
      if (req.mode === 'projectList') {
        if (!req.projectId) return { savedPath: null, error: 'MISSING_PROJECT_ID' };
        content = exportProjectTaskList(data, req.projectId);
        defaultName = `${data.projects[req.projectId]?.title ?? 'project'}-任务清单.md`;
      } else {
        const from = req.from ?? '1970-01-01';
        const to = req.to ?? '2999-12-31';
        content = exportWorklog(data, { from, to, projectId: req.projectId });
        defaultName = `工作日志-${from}-${to}.md`;
      }
    } catch (err) {
      return { savedPath: null, error: err instanceof Error ? err.message : String(err) };
    }
    const save = await electronDialog.showSaveDialog(win, { defaultPath: defaultName });
    if (save.canceled || !save.filePath) return { savedPath: null };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(save.filePath, content, 'utf8');
    logger.info({ action: 'export:markdown', mode: req.mode, path: save.filePath });
    return { savedPath: save.filePath };
  });

  ipcMain.handle(Ipc.selectAvatar, async () => {
    const win = getWindow();
    if (!win) return null;
    const picked = await electronDialog.showOpenDialog(win, {
      title: '选择头像图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const buf = await readFile(picked.filePaths[0] as string);
    const ext = (picked.filePaths[0] as string).split('.').pop()?.toLowerCase() ?? 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${buf.toString('base64')}`;
  });

  ipcMain.handle(Ipc.aiRegistry, () => PROVIDER_REGISTRY.map(toProviderInfo));

  ipcMain.handle(Ipc.aiTestProvider, async (_e, raw: unknown) => {
    const { providerId } = await Promise.resolve(raw as { providerId: string });
    const cfg = store.get().settings.aiProviders.find((p) => p.id === providerId);
    if (!cfg) return { ok: false, error: 'PROVIDER_NOT_CONFIGURED' };
    const def = getProviderDef(cfg.registryId);
    const baseUrl = cfg.baseUrl ?? def?.baseUrl ?? '';
    if (!baseUrl) return { ok: false, error: 'MISSING_BASE_URL' };
    const result = await testConnection(baseUrl, decryptKey(cfg.apiKeyEncrypted));
    logger.info({ action: 'ai:testProvider', providerId, ok: result.ok });
    return result;
  });

  ipcMain.handle(Ipc.aiAnalyze, async (_e, raw: unknown) => {
    const req = AiAnalyzeReqSchema.parse(raw);
    const requestId = randomUUID();
    const data = store.get();
    const providers = data.settings.aiProviders;
    const cfg = req.providerId
      ? providers.find((p) => p.id === req.providerId)
      : providers.find((p) => p.isDefault) ?? providers[0];
    if (!cfg) {
      getWindow()?.webContents.send(Ipc.aiError, { requestId, error: 'NO_PROVIDER_CONFIGURED' });
      return { requestId };
    }
    const def = getProviderDef(cfg.registryId);
    const baseUrl = cfg.baseUrl ?? def?.baseUrl ?? '';
    const today = localDate(Date.now());
    const prompt = renderPrompt(data.settings.aiPrompt, {
      date: today,
      data: buildAnalysisData(data, { scope: req.scope, date: today, projectId: req.projectId }),
    });
    logger.info({ action: 'ai:analyze', requestId, scope: req.scope, providerId: cfg.id });
    void (async () => {
      const win = getWindow();
      let full = '';
      try {
        for await (const delta of streamChat({
          baseUrl,
          apiKey: decryptKey(cfg.apiKeyEncrypted),
          model: cfg.model,
          messages: [{ role: 'user', content: prompt }],
        })) {
          full += delta;
          win?.webContents.send(Ipc.aiChunk, { requestId, delta });
        }
        win?.webContents.send(Ipc.aiDone, { requestId, full });
        logger.info({ action: 'ai:analyze:done', requestId, length: full.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        win?.webContents.send(Ipc.aiError, { requestId, error: message, full });
        logger.error({ action: 'ai:analyze:error', requestId, error: message });
      }
    })();
    return { requestId };
  });
}
```

注意：上面代码 import 中的 `dialog`/`applySettlement`/`settleTimer`/`safeStorage` 为未用项，保存前删除未使用的 import（Biome 会报错）。保留的实际 import 列表：`AiAnalyzeReqSchema, AppData, ExportMarkdownReqSchema, ImportRunResult, Ipc, maskDataForRenderer, SettingsUpdateReqSchema, SYSTEM_TAG_IDS, TaskDeleteReqSchema, TaskSchema, TimerSyncReqSchema, localDate`（from shared）以及 electron 的 `BrowserWindow, dialog, ipcMain`。

- [ ] **Step 3: 更新 main.ts（服务装配 + 窗口 + 崩溃恢复日志）**

替换 `packages/app/src/main/main.ts` 为：

```ts
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { is } from '@electron-toolkit/utils';
import { DataStore } from './dataStore';
import { registerIpcHandlers } from './ipcHandlers';
import { createLogger } from './logger';

let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.on('ready-to-show', () => window.show());
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return window;
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const logger = createLogger(join(userData, 'logs'));
  const store = new DataStore(userData);
  store.load();
  logger.info({ action: 'app:start', activeTimer: store.get().activeTimer?.taskId ?? null });
  registerIpcHandlers({ store, logger, getWindow: () => win });
  win = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

说明：`activeTimer` 恢复逻辑在 Task 20（退出结算）统一处理，此处仅记录日志。

- [ ] **Step 4: 实现真实 preload**

替换 `packages/app/src/preload/index.ts` 为：

```ts
import { contextBridge, ipcRenderer } from 'electron';
import {
  Ipc,
  RENDERER_API_KEY,
  type RendererApi,
  type AiStreamEvent,
} from '@tiny-schedule/shared';

const api: RendererApi = {
  dataLoad: () => ipcRenderer.invoke(Ipc.dataLoad),
  taskUpsert: (task) => ipcRenderer.invoke(Ipc.taskUpsert, task),
  taskDelete: (id) => ipcRenderer.invoke(Ipc.taskDelete, { id }),
  settingsUpdate: (patch) => ipcRenderer.invoke(Ipc.settingsUpdate, patch),
  finishDay: (date) => ipcRenderer.invoke(Ipc.finishDay, { date }),
  timerSync: (req) => ipcRenderer.invoke(Ipc.timerSync, req),
  importRun: () => ipcRenderer.invoke(Ipc.importRun),
  exportMarkdown: (req) => ipcRenderer.invoke(Ipc.exportMarkdown, req),
  selectAvatar: () => ipcRenderer.invoke(Ipc.selectAvatar),
  aiRegistry: () => ipcRenderer.invoke(Ipc.aiRegistry),
  aiTestProvider: (providerId) => ipcRenderer.invoke(Ipc.aiTestProvider, { providerId }),
  aiAnalyze: (req) => ipcRenderer.invoke(Ipc.aiAnalyze, req),
  onAiEvent: (cb) => {
    const listener = (_e: unknown, ev: AiStreamEvent) => cb(ev);
    ipcRenderer.on(Ipc.aiChunk, listener as never);
    ipcRenderer.on(Ipc.aiDone, listener as never);
    ipcRenderer.on(Ipc.aiError, listener as never);
    return () => {
      ipcRenderer.removeListener(Ipc.aiChunk, listener as never);
      ipcRenderer.removeListener(Ipc.aiDone, listener as never);
      ipcRenderer.removeListener(Ipc.aiError, listener as never);
    };
  },
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, api);
```

注意：三个事件 channel 都走同一 listener；渲染进程按 `ev.delta/ev.full/ev.error` 字段区分。为此需要小改 shared：在 Task 4 的 `Ipc` 中 `aiChunk/aiDone/aiError` 已存在，payload 统一为 `AiStreamEvent`。

- [ ] **Step 5: 渲染进程 api helper**

`packages/app/src/renderer/src/api.ts`:

```ts
import type { RendererApi } from '@tiny-schedule/shared';

export function api(): RendererApi {
  if (!window.tinyApi) throw new Error('tinyApi not exposed — preload missing');
  return window.tinyApi;
}
```

- [ ] **Step 6: 手动端到端验证**

在 `packages/app/src/renderer/src/App.tsx` 临时加入验证代码：

```tsx
import { useEffect, useState } from 'react';
import { api } from './api';

export default function App() {
  const [status, setStatus] = useState('loading…');
  useEffect(() => {
    api()
      .dataLoad()
      .then((d) => setStatus(`loaded, version=${d.version}, projects=${Object.keys(d.projects).length}`))
      .catch((e) => setStatus(`error: ${e.message}`));
  }, []);
  return <div style={{ padding: 24 }}>{status}</div>;
}
```

Run: `bun run dev`
Expected: 窗口显示 `loaded, version=1, projects=1`。检查 `~/Library/Application Support/<app>/data.json`（app 名在 package.json `"name"` 决定，此处为 app 包 name 对应的目录）已生成。确认后把 App.tsx 恢复为占位版本。

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全部通过。

- [ ] **Step 7: Commit**

```bash
git add packages/app packages/shared
git commit -m "feat(ipc): wire main handlers, preload bridge and renderer client"
```

---

### Task 13: 渲染进程基础（Tailwind + shadcn/ui + 布局壳 + 主题）

**Files:**
- Modify: `packages/app/src/renderer/src/styles.css`, `packages/app/src/renderer/src/App.tsx`
- Create: `packages/app/components.json`, `packages/app/src/renderer/src/lib/utils.ts`, `packages/app/src/renderer/src/components/Layout.tsx`, `packages/app/src/renderer/src/stores/ui.ts`, `packages/app/src/renderer/src/theme.ts`

**Interfaces:**
- Produces: Tailwind v4 + shadcn 变量就绪的样式；`cn()` helper；`Layout`（左侧 Sidebar 插槽 + 顶部计时条插槽 + 主内容区）；`useUiStore`（view 状态：`{ type: 'today' | 'project' | 'tag' | 'upcoming' | 'settings' | 'ai' | 'export', id?: string }`）；`applyTheme(theme)`。Task 14-19 的页面都挂进 Layout。

- [ ] **Step 1: 安装 Tailwind v4 与 shadcn 依赖**

```bash
cd packages/app
bun add -D tailwindcss @tailwindcss/vite tw-animate-css
bun add clsx tailwind-merge lucide-react class-variance-authority
```

- [ ] **Step 2: styles.css（Tailwind v4 入口 + shadcn 变量）**

`packages/app/src/renderer/src/styles.css`:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:where(.dark, .dark *));

:root {
  --radius: 0.5rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground; }
}
```

- [ ] **Step 3: components.json（shadcn CLI 配置）**

`packages/app/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/renderer/src/styles.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

注意：shadcn 的 alias 解析相对于 `packages/app`，`@/` 已在 electron.vite.config.ts 与 tsconfig 中映射到 `src/renderer/src`。

安装首批组件：

```bash
cd packages/app
bunx shadcn@latest add button dialog input textarea select switch checkbox label dropdown-menu scroll-area separator -y
```

若 CLI 报错（如找不到框架类型），改为手动从 https://ui.shadcn.com/docs/components 拷贝上述组件源码到 `src/renderer/src/components/ui/`。

- [ ] **Step 4: lib/utils.ts**

`packages/app/src/renderer/src/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 5: UI store 与主题**

`packages/app/src/renderer/src/stores/ui.ts`:

```ts
import { create } from 'zustand';

export type View =
  | { type: 'today' }
  | { type: 'project'; id: string }
  | { type: 'tag'; id: string }
  | { type: 'upcoming' }
  | { type: 'ai' }
  | { type: 'export' }
  | { type: 'settings' };

export interface AiAutoRun {
  scope: 'today' | 'week' | 'project';
  providerId: string;
}

interface UiState {
  view: View;
  selectedTaskId: string | null;
  aiAutoRun: AiAutoRun | null;
  setView: (view: View) => void;
  selectTask: (taskId: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: { type: 'today' },
  selectedTaskId: null,
  aiAutoRun: null,
  setView: (view) => set({ view, selectedTaskId: null }),
  selectTask: (taskId) => set({ selectedTaskId: taskId }),
}));
```

`packages/app/src/renderer/src/theme.ts`:

```ts
import type { ThemeMode } from '@tiny-schedule/shared';

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    const dark = mode === 'dark' || (mode === 'system' && mq.matches);
    root.classList.toggle('dark', dark);
  };
  mq.removeEventListener('change', update);
  mq.addEventListener('change', update);
  update();
}
```

- [ ] **Step 6: Layout 组件**

`packages/app/src/renderer/src/components/Layout.tsx`:

```tsx
import type { ReactNode } from 'react';

export function Layout({ sidebar, timerBar, children }: {
  sidebar: ReactNode;
  timerBar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-60 shrink-0 border-r border-border bg-muted/30 overflow-y-auto">
        {sidebar}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border">{timerBar}</div>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
```

更新 `App.tsx` 使用 Layout（占位内容）：

```tsx
import { useEffect } from 'react';
import { Layout } from './components/Layout';
import { api } from './api';
import { applyTheme } from './theme';

export default function App() {
  useEffect(() => {
    api().dataLoad().then((d) => applyTheme(d.settings.theme)).catch(() => {});
  }, []);
  return (
    <Layout
      sidebar={<div className="p-3 text-sm text-muted-foreground">Sidebar 待实现</div>}
      timerBar={<div className="p-3 text-sm text-muted-foreground">计时条待实现</div>}
    >
      <div className="p-4">主内容区待实现</div>
    </Layout>
  );
}
```

- [ ] **Step 7: 手动验证**

Run: `bun run dev`
Expected: 窗口显示两栏布局（左 240px 侧栏 + 右侧顶部条 + 内容区），样式正常（无未加载的 CSS）。

Run: `bun run typecheck && bun run lint`
Expected: 通过。

- [ ] **Step 8: Commit**

```bash
git add packages/app
git commit -m "feat(renderer): tailwind v4 + shadcn foundation with layout shell"
```

---

### Task 14: 全局数据 store + Sidebar + 视图路由

**Files:**
- Create: `packages/app/src/renderer/src/stores/data.ts`, `packages/app/src/renderer/src/components/Sidebar.tsx`
- Modify: `packages/app/src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `api()`（Task 12）、`useUiStore`（Task 13）。
- Produces: `useDataStore`（`data: AppData | null; load(); upsertTask(task); deleteTask(id); updateSettings(patch); reload()`）；`Sidebar`（今日 / Upcoming / 项目列表带任务数角标 / 标签列表 / AI 分析 / 导入导出 / 设置入口）。App 按 view 分发页面（本任务用占位页面）。

- [ ] **Step 1: data store**

`packages/app/src/renderer/src/stores/data.ts`:

```ts
import type { AppData, AppSettings, Task } from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';

interface DataState {
  data: AppData | null;
  loading: boolean;
  load: () => Promise<void>;
  upsertTask: (task: Task) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  updateSettings: (patch: Partial<AppSettings> & { aiProviders?: ProviderDraft[] }) => Promise<void>;
}

// Renderer-side provider draft carries plain-text apiKey for editing
export interface ProviderDraft {
  id: string;
  registryId: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  isDefault: boolean;
}

export const useDataStore = create<DataState>((set) => ({
  data: null,
  loading: false,
  load: async () => {
    set({ loading: true });
    const data = await api().dataLoad();
    set({ data, loading: false });
  },
  upsertTask: async (task) => {
    const data = await api().taskUpsert(task);
    set({ data });
  },
  deleteTask: async (id) => {
    const data = await api().taskDelete(id);
    set({ data });
  },
  updateSettings: async (patch) => {
    const data = await api().settingsUpdate(patch);
    set({ data });
  },
}));
```

注意：settingsUpdate 的 zod schema（Task 4）要求 aiProviders 元素带 `apiKey` 明文字段；渲染进程侧 `ProviderDraft` 在 Task 18 设置页中维护明文输入，回传时直接放入 patch。已保存但用户未改 key 的 provider，其 apiKey 在 draft 中以占位串 `<unchanged>` 表示——主进程 handler 需识别：在 `ipcHandlers.ts` 的 settingsUpdate 中，若 `p.apiKey === '<unchanged>'`，保留旧的 `apiKeyEncrypted`。现在补上这段逻辑：

```ts
// ipcHandlers.ts settingsUpdate 内 aiProviders 映射处
settings.aiProviders = patch.aiProviders.map((p) => {
  const prev = d.settings.aiProviders.find((x) => x.id === p.id);
  return {
    id: p.id,
    registryId: p.registryId,
    baseUrl: p.baseUrl,
    apiKeyEncrypted: p.apiKey === '<unchanged>' && prev ? prev.apiKeyEncrypted : encryptKey(p.apiKey),
    model: p.model,
    isDefault: p.isDefault,
  };
});
```

同步在 shared 的 `SettingsUpdateReqSchema` provider 元素中确认 `apiKey: z.string()`（允许 `<unchanged>` 字面量，无需额外校验）。

- [ ] **Step 2: Sidebar**

`packages/app/src/renderer/src/components/Sidebar.tsx`:

```tsx
import { Bot, CalendarDays, Download, Inbox, Settings, Sun, Tag, Upload } from 'lucide-react';
import { SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useUiStore, type View } from '../stores/ui';

function NavItem({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        active ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50',
      )}
    >
      {children}
    </button>
  );
}

export function Sidebar() {
  const data = useDataStore((s) => s.data);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  if (!data) return null;

  const openCountByProject = new Map<string, number>();
  for (const t of Object.values(data.tasks)) {
    if (!t.isDone && !t.parentTaskId) {
      openCountByProject.set(t.projectId, (openCountByProject.get(t.projectId) ?? 0) + 1);
    }
  }
  const isActive = (v: View) => v.type === view.type && ('id' in v ? v.id === (view as { id?: string }).id : true);
  const systemTagIds = Object.values(SYSTEM_TAG_IDS);
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);
  const customTags = Object.values(data.tags).filter((t) => !systemTagIds.includes(t.id as never));

  return (
    <nav className="flex flex-col gap-1 p-2">
      <NavItem active={isActive({ type: 'today' })} onClick={() => setView({ type: 'today' })}>
        <Sun className="h-4 w-4" /> 今日
      </NavItem>
      <NavItem active={isActive({ type: 'upcoming' })} onClick={() => setView({ type: 'upcoming' })}>
        <CalendarDays className="h-4 w-4" /> Upcoming
      </NavItem>

      <div className="mt-3 px-2 text-xs font-medium text-muted-foreground">项目</div>
      {projects.map((p) => (
        <NavItem key={p.id} active={isActive({ type: 'project', id: p.id })} onClick={() => setView({ type: 'project', id: p.id })}>
          <Inbox className="h-4 w-4" />
          <span className="flex-1 truncate text-left">{p.title}</span>
          {(openCountByProject.get(p.id) ?? 0) > 0 && (
            <span className="rounded-full bg-secondary px-1.5 text-xs text-muted-foreground">
              {openCountByProject.get(p.id)}
            </span>
          )}
        </NavItem>
      ))}

      <div className="mt-3 px-2 text-xs font-medium text-muted-foreground">标签</div>
      {customTags.map((t) => (
        <NavItem key={t.id} active={isActive({ type: 'tag', id: t.id })} onClick={() => setView({ type: 'tag', id: t.id })}>
          <Tag className="h-4 w-4" style={t.color ? { color: t.color } : undefined} />
          <span className="truncate">{t.title}</span>
        </NavItem>
      ))}

      <div className="mt-3 border-t border-border pt-2">
        <NavItem active={isActive({ type: 'ai' })} onClick={() => setView({ type: 'ai' })}>
          <Bot className="h-4 w-4" /> AI 分析
        </NavItem>
        <NavItem active={isActive({ type: 'export' })} onClick={() => setView({ type: 'export' })}>
          <Download className="h-4 w-4" /> 导入 / 导出
        </NavItem>
        <NavItem active={isActive({ type: 'settings' })} onClick={() => setView({ type: 'settings' })}>
          <Settings className="h-4 w-4" /> 设置
        </NavItem>
      </div>
    </nav>
  );
}
```

（`Upload` import 未使用则删除，Biome 会提示。）

- [ ] **Step 3: App 分发视图**

替换 `packages/app/src/renderer/src/App.tsx`：

```tsx
import { useEffect } from 'react';
import { api } from './api';
import { Layout } from './components/Layout';
import { Sidebar } from './components/Sidebar';
import { useDataStore } from './stores/data';
import { useUiStore } from './stores/ui';
import { applyTheme } from './theme';

function Placeholder({ name }: { name: string }) {
  return <div className="p-4 text-muted-foreground">{name} 页面待实现</div>;
}

export default function App() {
  const data = useDataStore((s) => s.data);
  const load = useDataStore((s) => s.load);
  const view = useUiStore((s) => s.view);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (data) applyTheme(data.settings.theme);
  }, [data?.settings.theme]);

  if (!data) return <div className="p-4">加载中…</div>;

  const page =
    view.type === 'today' ? <Placeholder name="今日" /> :
    view.type === 'project' ? <Placeholder name="项目" /> :
    view.type === 'tag' ? <Placeholder name="标签" /> :
    view.type === 'upcoming' ? <Placeholder name="Upcoming" /> :
    view.type === 'ai' ? <Placeholder name="AI 分析" /> :
    view.type === 'export' ? <Placeholder name="导入导出" /> :
    <Placeholder name="设置" />;

  return (
    <Layout
      sidebar={<Sidebar />}
      timerBar={<div className="p-3 text-sm text-muted-foreground">计时条待实现</div>}
    >
      {page}
    </Layout>
  );
}
```

- [ ] **Step 4: 手动验证**

Run: `bun run dev`
Expected: 侧栏显示 Inbox 项目、系统过滤后无自定义标签（空库）、底部 AI/导入导出/设置；点击各项主区显示对应占位文案。

Run: `bun run typecheck && bun run lint`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/app
git commit -m "feat(renderer): data store and sidebar navigation with view routing"
```

---

### Task 15: 今日视图 + 任务卡片 + 快速添加任务

**Files:**
- Create: `packages/app/src/renderer/src/components/TaskList.tsx`, `packages/app/src/renderer/src/components/TaskCard.tsx`, `packages/app/src/renderer/src/components/AddTaskInput.tsx`, `packages/app/src/renderer/src/pages/TodayPage.tsx`, `packages/app/src/renderer/src/lib/tasks.ts`
- Modify: `packages/app/src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `useDataStore`, `useUiStore`, shadcn Button/Checkbox（Task 13/14）。
- Produces: `todayTasks(data): Task[]`（TODAY 标签 + dueDay=今天，排除子任务与已完成）、`tasksForProject/tag/upcoming` 选择器；`TaskCard`（标题/标签/耗时/预估、hover 出现 ▶ ✓ 🗑 操作）；`AddTaskInput`（回车创建任务，默认进当前上下文项目/标签 + TODAY）。Task 16 详情面板复用 `TaskCard` 的选中交互，Task 17 计时条复用 `useUiStore.selectedTaskId`。

- [ ] **Step 1: 任务选择器**

`packages/app/src/renderer/src/lib/tasks.ts`:

```ts
import { localDate, SYSTEM_TAG_IDS, type AppData, type Task } from '@tiny-schedule/shared';

export function isTopLevel(t: Task): boolean {
  return !t.parentTaskId;
}

export function todayTasks(data: AppData, now = Date.now()): Task[] {
  const today = localDate(now);
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => !t.isDone)
    .filter((t) => t.tagIds.includes(SYSTEM_TAG_IDS.today) || t.dueDay === today)
    .sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? ''));
}

export function projectTasks(data: AppData, projectId: string): Task[] {
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => Number(a.isDone) - Number(b.isDone) || b.created - a.created);
}

export function tagTasks(data: AppData, tagId: string): Task[] {
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => !t.isDone && t.tagIds.includes(tagId))
    .sort((a, b) => b.created - a.created);
}

export function upcomingTasks(data: AppData, now = Date.now()): Task[] {
  const today = localDate(now);
  return Object.values(data.tasks)
    .filter(isTopLevel)
    .filter((t) => !t.isDone && t.dueDay && t.dueDay > today)
    .sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? ''));
}

export function newTaskId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankTask(title: string, projectId: string, extraTagIds: string[] = []): Task {
  return {
    id: newTaskId(),
    title,
    projectId,
    tagIds: extraTagIds,
    subTaskIds: [],
    isDone: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: Date.now(),
  };
}
```

- [ ] **Step 2: TaskCard**

`packages/app/src/renderer/src/components/TaskCard.tsx`:

```tsx
import { Check, Play, Trash2 } from 'lucide-react';
import type { AppData, Task } from '@tiny-schedule/shared';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';

function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function TaskCard({ task, data, active }: { task: Task; data: AppData; active: boolean }) {
  const selectTask = useUiStore((s) => s.selectTask);
  const selectedTaskId = useUiStore((s) => s.selectedTaskId);
  const upsertTask = useDataStore((s) => s.upsertTask);
  const deleteTask = useDataStore((s) => s.deleteTask);
  const selected = selectedTaskId === task.id;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectTask(selected ? null : task.id)}
      onKeyDown={(e) => e.key === 'Enter' && selectTask(selected ? null : task.id)}
      className={cn(
        'group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 cursor-pointer',
        selected && 'ring-2 ring-ring',
        active && 'border-pink-400 bg-pink-50 dark:bg-pink-950/30',
      )}
    >
      <button
        type="button"
        aria-label="完成"
        className="text-muted-foreground hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          void upsertTask({ ...task, isDone: !task.isDone, doneAt: task.isDone ? undefined : Date.now() });
        }}
      >
        <Check className={cn('h-4 w-4 rounded-full border p-0.5', task.isDone && 'bg-primary text-primary-foreground')} />
      </button>
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-sm', task.isDone && 'line-through text-muted-foreground')}>{task.title}</div>
        <div className="mt-0.5 flex gap-1">
          {task.tagIds.map((id) => data.tags[id] && (
            <span key={id} className="rounded bg-secondary px-1.5 text-xs text-muted-foreground">{data.tags[id]?.title}</span>
          ))}
        </div>
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">
        {task.timeSpent > 0 && `${formatMs(task.timeSpent)} / `}
        {task.timeEstimate > 0 ? formatMs(task.timeEstimate) : ''}
      </div>
      <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
        <button type="button" aria-label="开始计时" className="hover:text-pink-500" onClick={(e) => { e.stopPropagation(); /* Task 17 接入 */ }}>
          <Play className="h-4 w-4" />
        </button>
        <button type="button" aria-label="删除" className="hover:text-destructive" onClick={(e) => { e.stopPropagation(); void deleteTask(task.id); }}>
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: TaskList 与 AddTaskInput**

`packages/app/src/renderer/src/components/TaskList.tsx`:

```tsx
import type { AppData, Task } from '@tiny-schedule/shared';
import { TaskCard } from './TaskCard';

export function TaskList({ tasks, data, activeTaskId }: { tasks: Task[]; data: AppData; activeTaskId?: string | null }) {
  if (tasks.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">暂无任务</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      {tasks.map((t) => <TaskCard key={t.id} task={t} data={data} active={t.id === activeTaskId} />)}
    </div>
  );
}
```

`packages/app/src/renderer/src/components/AddTaskInput.tsx`:

```tsx
import { useState } from 'react';
import { SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { Input } from './ui/input';
import { blankTask } from '../lib/tasks';
import { useDataStore } from '../stores/data';

export function AddTaskInput({ projectId, addToToday = false }: { projectId: string; addToToday?: boolean }) {
  const [title, setTitle] = useState('');
  const upsertTask = useDataStore((s) => s.upsertTask);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const tags = addToToday ? [SYSTEM_TAG_IDS.today] : [];
    await upsertTask(blankTask(trimmed, projectId, tags));
    setTitle('');
  };

  return (
    <Input
      value={title}
      placeholder="＋ 添加任务，回车确认"
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && void submit()}
    />
  );
}
```

- [ ] **Step 4: TodayPage**

`packages/app/src/renderer/src/pages/TodayPage.tsx`:

```tsx
import { CheckCircle2 } from 'lucide-react';
import { INBOX_PROJECT_ID, localDate } from '@tiny-schedule/shared';
import { AddTaskInput } from '../components/AddTaskInput';
import { TaskList } from '../components/TaskList';
import { Button } from '../components/ui/button';
import { todayTasks } from '../lib/tasks';
import { useDataStore } from '../stores/data';

function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function TodayPage() {
  const data = useDataStore((s) => s.data);
  if (!data) return null;
  const today = localDate(Date.now());
  const tasks = todayTasks(data);
  const workedToday = Object.values(data.tasks).reduce((sum, t) => sum + (t.timeSpentOnDay[today] ?? 0), 0);
  const estimateRemaining = tasks.reduce((sum, t) => sum + Math.max(0, t.timeEstimate - t.timeSpent), 0);
  const finishedToday = data.misc.lastFinishDay === today;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">今日</h1>
      <div className="mt-2 flex gap-6 text-sm text-muted-foreground">
        <span>预估剩余：{formatMs(estimateRemaining)}</span>
        <span>今日工作：{formatMs(workedToday)}</span>
      </div>
      {finishedToday && (
        <div className="mt-3 rounded-md bg-secondary px-3 py-2 text-sm text-muted-foreground">
          今天已结束（Finish Day 已完成）
        </div>
      )}
      <div className="mt-4">
        <TaskList tasks={tasks} data={data} />
      </div>
      <div className="mt-4">
        <AddTaskInput projectId={INBOX_PROJECT_ID} addToToday />
      </div>
      <div className="mt-8 flex justify-center">
        <Button variant="outline" disabled={finishedToday} onClick={() => { /* Task 19 接入 Finish Day */ }}>
          <CheckCircle2 className="mr-1 h-4 w-4" /> Finish Day
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: App 接入 TodayPage（其余视图占位）**

在 `App.tsx` 的 page 分发中，将 `view.type === 'today'` 分支改为 `<TodayPage />`，并 import。项目/标签/Upcoming 页面在 Task 16 之后接入——本任务先为它们提供内联复用：

在 App.tsx 中增加：

```tsx
import { TaskList } from './components/TaskList';
import { AddTaskInput } from './components/AddTaskInput';
import { projectTasks, tagTasks, upcomingTasks } from './lib/tasks';
```

并实现：

```tsx
function ProjectPage({ projectId }: { projectId: string }) {
  const data = useDataStore((s) => s.data);
  if (!data) return null;
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">{data.projects[projectId]?.title ?? '项目'}</h1>
      <div className="mt-4"><TaskList tasks={projectTasks(data, projectId)} data={data} /></div>
      <div className="mt-4"><AddTaskInput projectId={projectId} /></div>
    </div>
  );
}
```

标签页/Upcoming 同构（`tagTasks` / `upcomingTasks`，无 AddTaskInput 或默认 INBOX）。

- [ ] **Step 6: 手动验证**

Run: `bun run dev`
Expected: 今日视图显示指标与空状态；输入任务回车出现卡片（进入 Inbox + TODAY）；点 ✓ 完成；hover 出现删除；切换项目视图可见同任务。

Run: `bun run typecheck && bun run lint`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add packages/app
git commit -m "feat(renderer): today view with task cards and quick add"
```

---

### Task 16: 任务详情面板（编辑、子任务、标签、截止日、预估、备注）

**Files:**
- Create: `packages/app/src/renderer/src/components/TaskDetail.tsx`
- Modify: `packages/app/src/renderer/src/App.tsx`（主区改为 flex：列表区 + 右侧详情）

**Interfaces:**
- Consumes: `useDataStore`, `useUiStore.selectedTaskId`, shadcn Input/Textarea/Select。
- Produces: `TaskDetail`——选中任务时渲染在内容区右侧（宽度 380px），所有编辑失焦/回车即保存（upsertTask）。含：标题、完成开关、项目选择、标签多选（checkbox 列表）、截止日（date input）、预估时长（小时数输入）、备注 textarea、子任务列表（添加/完成/删除）。

- [ ] **Step 1: TaskDetail 组件**

`packages/app/src/renderer/src/components/TaskDetail.tsx`:

```tsx
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { INBOX_PROJECT_ID, type Task } from '@tiny-schedule/shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { blankTask } from '../lib/tasks';
import { useDataStore } from '../stores/data';

function hoursToMs(h: number): number {
  return Math.round(h * 3_600_000);
}

export function TaskDetail({ task }: { task: Task }) {
  const data = useDataStore((s) => s.data);
  const upsertTask = useDataStore((s) => s.upsertTask);
  const deleteTask = useDataStore((s) => s.deleteTask);
  const selectTask = useDataStore(() => null) as never; // placeholder, replaced below
  const [subTitle, setSubTitle] = useState('');
  if (!data) return null;

  const save = (patch: Partial<Task>) => void upsertTask({ ...task, ...patch });
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);
  const tags = Object.values(data.tags);
  const subTasks = task.subTaskIds.map((id) => data.tasks[id]).filter(Boolean) as Task[];

  const addSubTask = async () => {
    const title = subTitle.trim();
    if (!title) return;
    const sub = { ...blankTask(title, task.projectId), parentTaskId: task.id };
    await upsertTask(sub);
    await upsertTask({ ...task, subTaskIds: [...task.subTaskIds, sub.id] });
    setSubTitle('');
  };

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <Input
          defaultValue={task.title}
          onBlur={(e) => e.target.value.trim() && save({ title: e.target.value.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <Button variant="ghost" size="icon" aria-label="关闭" onClick={() => window.dispatchEvent(new CustomEvent('ts:close-detail'))}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={task.isDone}
          onChange={(e) => save({ isDone: e.target.checked, doneAt: e.target.checked ? Date.now() : undefined })}
        />
        已完成
      </label>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">项目</div>
        <select
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          value={task.projectId}
          onChange={(e) => save({ projectId: e.target.value })}
        >
          {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">标签</div>
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => {
            const on = task.tagIds.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => save({ tagIds: on ? task.tagIds.filter((id) => id !== t.id) : [...task.tagIds, t.id] })}
                className={on ? 'rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground' : 'rounded-full bg-secondary px-2 py-0.5 text-xs'}
              >
                {t.title}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 text-xs text-muted-foreground">截止日</div>
          <Input type="date" value={task.dueDay ?? ''} onChange={(e) => save({ dueDay: e.target.value || undefined })} />
        </div>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">预估（小时）</div>
          <Input
            type="number" min="0" step="0.5"
            defaultValue={task.timeEstimate > 0 ? task.timeEstimate / 3_600_000 : ''}
            onBlur={(e) => save({ timeEstimate: hoursToMs(Number(e.target.value) || 0) })}
          />
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">子任务</div>
        <div className="flex flex-col gap-1">
          {subTasks.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={s.isDone} onChange={(e) => void upsertTask({ ...s, isDone: e.target.checked })} />
              <span className={s.isDone ? 'line-through text-muted-foreground' : ''}>{s.title}</span>
              <button type="button" aria-label="删除子任务" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => { void deleteTask(s.id); }}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <Input placeholder="添加子任务" value={subTitle} onChange={(e) => setSubTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addSubTask()} />
          <Button variant="outline" size="icon" aria-label="添加" onClick={() => void addSubTask()}><Plus className="h-4 w-4" /></Button>
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">备注</div>
        <Textarea rows={6} defaultValue={task.notes} onBlur={(e) => save({ notes: e.target.value })} placeholder="支持 Markdown" />
      </div>
    </div>
  );
}
```

注意：上方 `selectTask` 占位行是错误写法，实际实现中关闭按钮直接用 `useUiStore`：

```tsx
import { useUiStore } from '../stores/ui';
// ...
const selectTask = useUiStore((s) => s.selectTask);
// 关闭按钮：onClick={() => selectTask(null)}
```

并删除 `window.dispatchEvent` 写法与未使用的 `INBOX_PROJECT_ID` import。

- [ ] **Step 2: App 布局接入详情面板**

在 `App.tsx` 中把 page 与详情面板并排：

```tsx
import { TaskDetail } from './components/TaskDetail';
// ...
const selectedTaskId = useUiStore((s) => s.selectedTaskId);
const selectedTask = selectedTaskId ? data.tasks[selectedTaskId] : null;
// Layout children:
<div className="flex h-full">
  <div className="min-w-0 flex-1 overflow-y-auto">{page}</div>
  {selectedTask && <TaskDetail task={selectedTask} />}
</div>
```

- [ ] **Step 3: 手动验证**

Run: `bun run dev`
Expected: 点击任务卡片右侧展开详情；改标题/标签/截止日/预估/备注刷新后仍保留；子任务可添加、勾选、删除；关闭按钮收起面板。

Run: `bun run typecheck && bun run lint`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add packages/app
git commit -m "feat(renderer): task detail panel with inline editing and subtasks"
```

---

### Task 17: 计时条 + 心跳持久化 + 卡片高亮

**Files:**
- Create: `packages/app/src/renderer/src/stores/timer.ts`, `packages/app/src/renderer/src/components/TimerBar.tsx`
- Modify: `packages/app/src/renderer/src/App.tsx`, `packages/app/src/renderer/src/components/TaskCard.tsx`

**Interfaces:**
- Consumes: shared 计时纯函数（Task 3）、`api().timerSync`（Task 12）、`useDataStore.upsertTask`。
- Produces: `useTimerStore`——`timer: ActiveTimer | null; elapsed: number; start(taskId); pause(); resume(); stop(); tick()`；启动时从 `data.activeTimer` 恢复；每次变更立即 `timerSync` 到主进程（即心跳语义：变更即持久化，另每 30s 强制 sync 一次）；`stop()` 时用 `settleTimer + applySettlement` 结算任务耗时并清空计时器。`TimerBar` 渲染在 Layout 顶部插槽。

- [ ] **Step 1: timer store**

`packages/app/src/renderer/src/stores/timer.ts`:

```ts
import {
  type ActiveTimer,
  type AppData,
  applySettlement,
  computeElapsed,
  pauseTimer,
  resumeTimer,
  settleTimer,
  startTimer,
} from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';
import { useDataStore } from './data';

interface TimerState {
  timer: ActiveTimer | null;
  now: number;
  restore: (data: AppData) => void;
  start: (taskId: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
  tick: () => void;
}

async function sync(timer: ActiveTimer | null) {
  await api().timerSync({ timer });
}

export const useTimerStore = create<TimerState>((set, get) => ({
  timer: null,
  now: Date.now(),

  restore: (data) => {
    set({ timer: data.activeTimer });
    const heartbeat = setInterval(() => {
      const t = get().timer;
      if (t) void sync(t);
    }, 30_000);
    const clock = setInterval(() => set({ now: Date.now() }), 1_000);
    void heartbeat; void clock; // intervals live for app lifetime
  },

  start: (taskId) => {
    const t = startTimer(taskId, Date.now());
    set({ timer: t, now: Date.now() });
    void sync(t);
  },

  pause: () => {
    const cur = get().timer;
    if (!cur) return;
    const t = pauseTimer(cur, Date.now());
    set({ timer: t });
    void sync(t);
  },

  resume: () => {
    const cur = get().timer;
    if (!cur) return;
    const t = resumeTimer(cur, Date.now());
    set({ timer: t });
    void sync(t);
  },

  stop: async () => {
    const cur = get().timer;
    if (!cur) return;
    const now = Date.now();
    const settlement = settleTimer(cur, now);
    const data = useDataStore.getState().data;
    const task = data?.tasks[cur.taskId];
    if (task && settlement.ms > 0) {
      await useDataStore.getState().upsertTask(applySettlement(task, settlement));
    }
    set({ timer: null });
    await sync(null);
  },

  tick: () => set({ now: Date.now() }),
}));

export function elapsedOf(timer: ActiveTimer | null, now: number): number {
  return timer ? computeElapsed(timer, now) : 0;
}
```

在 `App.tsx` 的 `load` 后调用 `useTimerStore.getState().restore(data)`：

```tsx
import { useTimerStore } from './stores/timer';
// useEffect load 后：
useEffect(() => {
  void load().then(() => {
    const data = useDataStore.getState().data;
    if (data) useTimerStore.getState().restore(data);
  });
}, [load]);
```

（`load()` 需要返回 Promise<void>——Task 14 的 data store 已满足。）

- [ ] **Step 2: TimerBar**

`packages/app/src/renderer/src/components/TimerBar.tsx`:

```tsx
import { Pause, Play, Square } from 'lucide-react';
import { Button } from './ui/button';
import { useDataStore } from '../stores/data';
import { elapsedOf, useTimerStore } from '../stores/timer';

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${`${h}`.padStart(2, '0')}:${`${m}`.padStart(2, '0')}:${`${sec}`.padStart(2, '0')}`;
}

export function TimerBar() {
  const timer = useTimerStore((s) => s.timer);
  const now = useTimerStore((s) => s.now);
  const pause = useTimerStore((s) => s.pause);
  const resume = useTimerStore((s) => s.resume);
  const stop = useTimerStore((s) => s.stop);
  const data = useDataStore((s) => s.data);

  if (!timer || !data) {
    return <div className="flex h-14 items-center px-4 text-sm text-muted-foreground">没有进行中的计时</div>;
  }
  const task = data.tasks[timer.taskId];
  const elapsed = elapsedOf(timer, now);

  return (
    <div className="flex h-14 items-center gap-3 bg-pink-50 px-4 dark:bg-pink-950/40">
      {timer.isPaused ? (
        <Button size="icon" aria-label="继续" onClick={resume}><Play className="h-5 w-5" /></Button>
      ) : (
        <Button size="icon" aria-label="暂停" onClick={pause}><Pause className="h-5 w-5" /></Button>
      )}
      <Button size="icon" variant="destructive" aria-label="停止并结算" onClick={() => void stop()}>
        <Square className="h-4 w-4" />
      </Button>
      <div className="min-w-0 flex-1 truncate text-sm font-medium">{task?.title ?? timer.taskId}</div>
      <div className="font-mono text-lg tabular-nums text-pink-600 dark:text-pink-400">{formatElapsed(elapsed)}</div>
      {task && task.timeEstimate > 0 && (
        <div className="text-xs text-muted-foreground">/ {formatElapsed(task.timeEstimate)}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: App 与 TaskCard 接线**

App.tsx：`timerBar={<TimerBar />}`，并给 TaskList 传 `activeTaskId={useTimerStore((s) => s.timer)?.taskId}`。

TaskCard 的 ▶ 按钮（Task 15 中预留）：

```tsx
import { useTimerStore } from '../stores/timer';
const startTimer = useTimerStore((s) => s.start);
// ▶ 按钮 onClick：
(e) => { e.stopPropagation(); startTimer(task.id); }
```

- [ ] **Step 4: 手动验证**

Run: `bun run dev`
Expected: 任务卡片点 ▶ → 顶部计时条出现并每秒跳动；暂停/继续正常；⏹ 停止后任务的耗时增加（卡片上显示）、`data.json` 中 task.timeEntries 新增一条、activeTimer 为 null；计时中切换页面计时条保持。杀掉 app 重启 → 计时器恢复运行（时间累计正确）。

Run: `bun run typecheck && bun run lint`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/app
git commit -m "feat(renderer): persistent timer bar with heartbeat sync and settlement"
```

---

### Task 18: 设置页（用户信息 / 主题 / AI Providers / Prompt）

**Files:**
- Create: `packages/app/src/renderer/src/pages/SettingsPage.tsx`, `packages/app/src/renderer/src/components/ProviderEditor.tsx`
- Modify: `packages/app/src/renderer/src/App.tsx`（settings 分支换为 SettingsPage）

**Interfaces:**
- Consumes: `useDataStore.updateSettings`、`api().aiRegistry/selectAvatar/aiTestProvider`、shadcn Input/Textarea/Switch/Select/Button。
- Produces: 三小节设置页。Provider 草稿用 `<unchanged>` 占位保留旧 key（Task 14 主进程已支持）。

- [ ] **Step 1: ProviderEditor**

`packages/app/src/renderer/src/components/ProviderEditor.tsx`:

```tsx
import { Trash2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProviderInfo } from '@tiny-schedule/shared';
import { api } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { ProviderDraft } from '../stores/data';

export function ProviderEditor({ draft, registry, onChange, onRemove }: {
  draft: ProviderDraft;
  registry: ProviderInfo[];
  onChange: (d: ProviderDraft) => void;
  onRemove: () => void;
}) {
  const def = registry.find((r) => r.id === draft.registryId);
  const [testResult, setTestResult] = useState<string | null>(null);

  const test = async () => {
    setTestResult('测试中…');
    const res = await api().aiTestProvider(draft.id);
    setTestResult(res.ok ? '✓ 连接成功' : `✗ ${res.error ?? '连接失败'}`);
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-secondary text-xs font-bold uppercase">
          {(def?.icon ?? '?').slice(0, 2)}
        </span>
        <span className="text-sm font-medium">{def?.name ?? draft.registryId}</span>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={draft.isDefault} onChange={(e) => onChange({ ...draft, isDefault: e.target.checked })} />
          默认
        </label>
        <Button variant="ghost" size="icon" aria-label="删除" onClick={onRemove}><Trash2 className="h-4 w-4" /></Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Input
          type="password" placeholder="API Key"
          value={draft.apiKey === '<unchanged>' ? '' : draft.apiKey}
          onChange={(e) => onChange({ ...draft, apiKey: e.target.value || '<unchanged>' })}
        />
        <Input
          placeholder="模型名，如 gpt-4o" list={`models-${draft.id}`}
          value={draft.model}
          onChange={(e) => onChange({ ...draft, model: e.target.value })}
        />
        <datalist id={`models-${draft.id}`}>
          {(def?.models ?? []).map((m) => <option key={m} value={m} />)}
        </datalist>
        {draft.registryId === 'custom' && (
          <Input
            className="col-span-2" placeholder="Base URL，如 https://api.example.com/v1"
            value={draft.baseUrl ?? ''}
            onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
          />
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void test()}><Zap className="mr-1 h-3 w-3" />连接测试</Button>
        {testResult && <span className="text-xs text-muted-foreground">{testResult}</span>}
      </div>
    </div>
  );
}
```

注意：测试前必须先保存（key 已加密落库）；在 SettingsPage 中点“保存 AI 设置”后再允许测试，或测试前自动保存——本实现采用“修改即保存”策略（onChange 后防抖 500ms 调 updateSettings），测试按钮总是读已保存状态。

- [ ] **Step 2: SettingsPage**

`packages/app/src/renderer/src/pages/SettingsPage.tsx`:

```tsx
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProviderInfo } from '@tiny-schedule/shared';
import { api } from '../api';
import { ProviderEditor } from '../components/ProviderEditor';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import type { ProviderDraft } from '../stores/data';
import { useDataStore } from '../stores/data';

export function SettingsPage() {
  const data = useDataStore((s) => s.data);
  const updateSettings = useDataStore((s) => s.updateSettings);
  const [registry, setRegistry] = useState<ProviderInfo[]>([]);
  const [drafts, setDrafts] = useState<ProviderDraft[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api().aiRegistry().then(setRegistry);
  }, []);

  // initialize drafts from saved providers (keys masked as <unchanged>)
  useEffect(() => {
    if (!data) return;
    setDrafts(data.settings.aiProviders.map((p) => ({
      id: p.id, registryId: p.registryId, apiKey: '<unchanged>', baseUrl: p.baseUrl, model: p.model, isDefault: p.isDefault,
    })));
  }, [data?.settings.aiProviders.length]);

  if (!data) return null;
  const { settings } = data;

  const saveProviders = (next: ProviderDraft[]) => {
    setDrafts(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void updateSettings({ aiProviders: next });
    }, 500);
  };

  const addProvider = (registryId: string) => {
    const next = [
      ...drafts.map((d) => ({ ...d, isDefault: false })),
      { id: `p_${Date.now().toString(36)}`, registryId, apiKey: '', model: registry.find((r) => r.id === registryId)?.models[0] ?? '', isDefault: drafts.length === 0 },
    ];
    void updateSettings({ aiProviders: next }).then(() => setDrafts(next));
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">设置</h1>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-muted-foreground">用户信息</h2>
        <div className="mt-2 flex items-center gap-4">
          {settings.avatar ? (
            <img src={settings.avatar} alt="头像" className="h-14 w-14 rounded-full object-cover" />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-lg">{settings.userName.slice(0, 1) || '?'}</div>
          )}
          <div className="flex flex-col gap-2">
            <Input
              placeholder="用户名" defaultValue={settings.userName}
              onBlur={(e) => void updateSettings({ userName: e.target.value })}
            />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void api().selectAvatar().then((url) => url && updateSettings({ avatar: url }))}>选择本地图片</Button>
              {settings.avatar && <Button variant="ghost" size="sm" onClick={() => void updateSettings({ avatar: null })}>移除</Button>}
            </div>
            <Input
              placeholder="或粘贴头像 URL" defaultValue={settings.avatar?.startsWith('http') ? settings.avatar : ''}
              onBlur={(e) => e.target.value.trim() && void updateSettings({ avatar: e.target.value.trim() })}
            />
          </div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">主题</h2>
        <div className="mt-2 flex gap-2">
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <Button
              key={mode}
              variant={settings.theme === mode ? 'default' : 'outline'}
              onClick={() => void updateSettings({ theme: mode })}
            >
              {mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : '跟随系统'}
            </Button>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">AI Providers</h2>
        <div className="mt-2 flex flex-col gap-3">
          {drafts.map((d) => (
            <ProviderEditor
              key={d.id} draft={d} registry={registry}
              onChange={(nd) => {
                let next = drafts.map((x) => (x.id === nd.id ? nd : x));
                if (nd.isDefault) next = next.map((x) => ({ ...x, isDefault: x.id === nd.id }));
                saveProviders(next);
              }}
              onRemove={() => saveProviders(drafts.filter((x) => x.id !== d.id))}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            {registry.map((r) => (
              <Button key={r.id} variant="outline" size="sm" onClick={() => addProvider(r.id)}>
                <Plus className="mr-1 h-3 w-3" />{r.name}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">AI 分析 Prompt（留空使用内置默认）</h2>
        <Textarea
          className="mt-2 font-mono text-xs" rows={6}
          placeholder={'支持占位符：{{date}} {{data}}'}
          defaultValue={settings.aiPrompt}
          onBlur={(e) => void updateSettings({ aiPrompt: e.target.value })}
        />
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox" checked={settings.autoAiAnalyzeOnFinishDay}
            onChange={(e) => void updateSettings({ autoAiAnalyzeOnFinishDay: e.target.checked })}
          />
          Finish Day 时自动触发 AI 分析
        </label>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: App 接入**

App.tsx 的 `settings` 分支改为 `<SettingsPage />`。

- [ ] **Step 4: 手动验证**

Run: `bun run dev`
Expected: 设置用户名/头像（本地图片）生效并持久化；切换主题即时生效（深色模式下界面变暗）；添加 OpenAI provider → 填 key 与模型 → 保存后连接测试返回成功/失败；自定义 provider 可填 baseUrl；重启后 provider 仍在且 key 不回显（password 框为空）。

Run: `bun run typecheck && bun run lint`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/app
git commit -m "feat(renderer): settings page with profile, theme and AI provider management"
```

---

### Task 19: 导入导出 UI + AI 分析面板 + Finish Day 流程

**Files:**
- Create: `packages/app/src/renderer/src/pages/ExportPage.tsx`, `packages/app/src/renderer/src/pages/AiPage.tsx`, `packages/app/src/renderer/src/components/FinishDayDialog.tsx`
- Modify: `packages/app/src/renderer/src/App.tsx`, `packages/app/src/renderer/src/pages/TodayPage.tsx`

**Interfaces:**
- Consumes: `api().importRun/exportMarkdown/aiAnalyze/onAiEvent/finishDay`（Task 12）、react-markdown 渲染流式输出。
- Produces: 导入/导出页（导入按钮 + 结果提示；导出两种模式表单）；AI 面板（范围选择 + 流式 Markdown + 复制）；FinishDayDialog（AI 分析 checkbox、自动触发 checkbox、provider 选择、无 provider 时跳转设置）。

- [ ] **Step 1: 安装 react-markdown**

```bash
cd packages/app && bun add react-markdown
```

- [ ] **Step 2: ExportPage**

`packages/app/src/renderer/src/pages/ExportPage.tsx`:

```tsx
import { Download, Upload } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { useDataStore } from '../stores/data';

export function ExportPage() {
  const data = useDataStore((s) => s.data);
  const load = useDataStore((s) => s.load);
  const [projectId, setProjectId] = useState('');
  const [message, setMessage] = useState('');

  if (!data) return null;
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);

  const runImport = async () => {
    setMessage('导入中…');
    const res = await api().importRun();
    if (res.ok && res.counts) {
      setMessage(`✓ 导入成功：${res.counts.tasks} 任务 / ${res.counts.projects} 项目 / ${res.counts.tags} 标签`);
      await load();
    } else if (res.error && res.error !== 'CANCELLED') {
      setMessage(`✗ 导入失败：${res.error}`);
    } else {
      setMessage('');
    }
  };

  const runExport = async (mode: 'projectList' | 'worklog') => {
    setMessage('导出中…');
    const res = await api().exportMarkdown(mode === 'projectList'
      ? { mode, projectId }
      : { mode, from: '1970-01-01', to: '2999-12-31' });
    setMessage(res.savedPath ? `✓ 已保存：${res.savedPath}` : (res.error ? `✗ ${res.error}` : ''));
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">导入 / 导出</h1>

      <section className="mt-6 rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium">导入 Super Productivity 备份</h2>
        <p className="mt-1 text-xs text-muted-foreground">整库导入，将覆盖当前任务/项目/标签数据（设置保留）。导入前会自动备份当前数据。</p>
        <Button className="mt-3" onClick={() => void runImport()}><Upload className="mr-1 h-4 w-4" />选择备份 JSON</Button>
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium">导出项目任务清单</h2>
        <div className="mt-3 flex gap-2">
          <select className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">选择项目…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          <Button disabled={!projectId} onClick={() => void runExport('projectList')}><Download className="mr-1 h-4 w-4" />导出 .md</Button>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium">导出工作日志（全部时间）</h2>
        <Button className="mt-3" onClick={() => void runExport('worklog')}><Download className="mr-1 h-4 w-4" />导出 .md</Button>
      </section>

      {message && <div className="mt-4 text-sm">{message}</div>}
    </div>
  );
}
```

- [ ] **Step 3: AiPage**

`packages/app/src/renderer/src/pages/AiPage.tsx`:

```tsx
import { Bot, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';

export function AiPage() {
  const data = useDataStore((s) => s.data);
  const setView = useUiStore((s) => s.setView);
  const [scope, setScope] = useState<'today' | 'week' | 'project'>('today');
  const [projectId, setProjectId] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const off = api().onAiEvent((ev) => {
      if (ev.requestId !== requestIdRef.current) return;
      if (ev.delta) setOutput((o) => o + ev.delta);
      if (ev.full !== undefined) setRunning(false);
      if (ev.error) {
        setError(ev.error === 'NO_PROVIDER_CONFIGURED' ? '尚未配置 AI Provider' : `分析失败：${ev.error}`);
        setRunning(false);
      }
    });
    return off;
  }, []);

  if (!data) return null;
  const hasProvider = data.settings.aiProviders.length > 0;
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);

  const run = async () => {
    setOutput(''); setError(''); setRunning(true);
    const { requestId } = await api().aiAnalyze({ scope, projectId: scope === 'project' ? projectId : undefined });
    requestIdRef.current = requestId;
  };

  const runWith = async (s: 'today' | 'week' | 'project', providerId: string) => {
    setScope(s);
    setOutput(''); setError(''); setRunning(true);
    const { requestId } = await api().aiAnalyze({ scope: s, providerId });
    requestIdRef.current = requestId;
  };

  // Finish Day 自动触发：Task 13 的 ui store 中的 aiAutoRun 交接
  useEffect(() => {
    const auto = useUiStore.getState().aiAutoRun;
    if (auto) {
      useUiStore.setState({ aiAutoRun: null });
      void runWith(auto.scope, auto.providerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">AI 分析</h1>
      {!hasProvider && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          尚未配置 AI Provider。
          <Button variant="link" className="px-1" onClick={() => setView({ type: 'settings' })}>去设置</Button>
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        <select className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={scope} onChange={(e) => setScope(e.target.value as never)}>
          <option value="today">今日日报</option>
          <option value="week">本周周报</option>
          <option value="project">指定项目</option>
        </select>
        {scope === 'project' && (
          <select className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">选择项目…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        )}
        <Button disabled={!hasProvider || running || (scope === 'project' && !projectId)} onClick={() => void run()}>
          <Bot className="mr-1 h-4 w-4" />{running ? '分析中…' : '开始分析'}
        </Button>
        {output && (
          <Button variant="outline" onClick={() => void navigator.clipboard.writeText(output)}><Copy className="h-4 w-4" /></Button>
        )}
      </div>
      {error && <div className="mt-3 text-sm text-destructive">{error}</div>}
      {output && (
        <div className="prose prose-sm dark:prose-invert mt-4 max-w-none rounded-lg border border-border p-4">
          <ReactMarkdown>{output}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
```

注：`prose` 排版类需要 `@tailwindcss/typography`：`bun add -D @tailwindcss/typography`，并在 styles.css 加 `@plugin "@tailwindcss/typography";`。

- [ ] **Step 4: FinishDayDialog**

`packages/app/src/renderer/src/components/FinishDayDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';

export function FinishDayDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const data = useDataStore((s) => s.data);
  const updateSettings = useDataStore((s) => s.updateSettings);
  const setView = useUiStore((s) => s.setView);
  const [analyze, setAnalyze] = useState(false);
  const [autoAnalyze, setAutoAnalyze] = useState(false);
  const [providerId, setProviderId] = useState('');

  useEffect(() => {
    if (open && data) {
      const def = data.settings.aiProviders.find((p) => p.isDefault) ?? data.settings.aiProviders[0];
      setProviderId(def?.id ?? '');
      setAnalyze(data.settings.autoAiAnalyzeOnFinishDay);
      setAutoAnalyze(data.settings.autoAiAnalyzeOnFinishDay);
    }
  }, [open, data]);

  if (!data) return null;
  const hasProvider = data.settings.aiProviders.length > 0;

  const confirm = async () => {
    await api().finishDay(new Date().toISOString());
    if (autoAnalyze !== data.settings.autoAiAnalyzeOnFinishDay) {
      await updateSettings({ autoAiAnalyzeOnFinishDay: autoAnalyze });
    }
    onClose();
    if (analyze && hasProvider) {
      // hand off an auto-run request to the AI page
      useUiStore.setState({ aiAutoRun: { scope: 'today', providerId }, view: { type: 'ai' }, selectedTaskId: null });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>结束今天？</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">未完成的“今日”任务将移回所属项目，明天可重新加入今日。</p>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={analyze} disabled={!hasProvider} onChange={(e) => setAnalyze(e.target.checked)} />
            触发 AI 日报分析
          </label>
          {analyze && hasProvider && (
            <select className="rounded-md border border-input bg-background px-2 py-1.5" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {data.settings.aiProviders.map((p) => <option key={p.id} value={p.id}>{p.model}{p.isDefault ? '（默认）' : ''}</option>)}
            </select>
          )}
          {!hasProvider && (
            <Button variant="link" className="justify-start px-0" onClick={() => { onClose(); setView({ type: 'settings' }); }}>
              尚未配置 AI Provider，去设置 →
            </Button>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={autoAnalyze} onChange={(e) => setAutoAnalyze(e.target.checked)} />
            以后自动触发 AI 分析（不再询问）
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => void confirm()}>结束今天</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: TodayPage 接入 FinishDayDialog；App 接入新页面**

TodayPage：加 `const [finishOpen, setFinishOpen] = useState(false)`；Finish Day 按钮 `onClick={() => setFinishOpen(true)}`；渲染 `<FinishDayDialog open={finishOpen} onClose={() => setFinishOpen(false)} />`。

App.tsx：`export` → `<ExportPage />`，`ai` → `<AiPage />`。

- [ ] **Step 6: 手动验证**

Run: `bun run dev`
Expected: 导出页选择真实备份导入成功并显示计数；导出项目清单/工作日志生成 .md 内容正确；AI 页未配置 provider 时提示并可跳转；配置后流式输出 Markdown；Finish Day 弹框、勾选、确认后今日任务消失、`misc.lastFinishDay` 写入、banner 显示。

Run: `bun run typecheck && bun run lint`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add packages/app
git commit -m "feat(renderer): import/export UI, AI analysis panel and finish day flow"
```

---

### Task 20: 退出确认与结算、README、验收清单

**Files:**
- Modify: `packages/app/src/main/main.ts`（close 拦截 + 结算）
- Create: `README.md`

**Interfaces:**
- Consumes: DataStore、shared `settleTimer/applySettlement`（Task 3/7）、electron dialog。
- Produces: 计时运行中关闭 → 确认框 → 结算 → 退出；README 含开发/构建命令。

- [ ] **Step 1: main.ts 增加退出结算**

在 main.ts 中加入（替换 `win = createWindow()` 之后的装配部分）：

```ts
import { dialog } from 'electron';
import { applySettlement, settleTimer } from '@tiny-schedule/shared';

let allowQuit = false;

function settleActiveTimer(store: DataStore, logger: Logger): void {
  const timer = store.get().activeTimer;
  if (!timer) return;
  const settlement = settleTimer(timer, Date.now());
  store.update((d) => {
    const task = d.tasks[timer.taskId];
    if (!task) return { ...d, activeTimer: null };
    return { ...d, tasks: { ...d.tasks, [task.id]: applySettlement(task, settlement) }, activeTimer: null };
  });
  logger.info({ action: 'timer:settle:quit', taskId: timer.taskId, ms: settlement.ms });
}

// createWindow 后：
win.on('close', (e) => {
  if (allowQuit) return;
  const timer = store.get().activeTimer;
  if (!timer) {
    allowQuit = true;
    return;
  }
  e.preventDefault();
  void dialog.showMessageBox(win as BrowserWindow, {
    type: 'question',
    buttons: ['结算并退出', '取消'],
    defaultId: 0,
    cancelId: 1,
    message: '计时器正在运行',
    detail: '退出将中断计时，已消耗的时间会结算到任务耗时。',
  }).then(({ response }) => {
    if (response === 0) {
      settleActiveTimer(store, logger);
      allowQuit = true;
      app.quit();
    }
  });
});
```

注意：macOS 的 Cmd+Q 会触发 `before-quit`，同样走窗口 close 流程；如平台行为不一致，在 `before-quit` 中也加同样的 timer 检查。

- [ ] **Step 2: README**

`README.md`:

```markdown
# Tiny-Schedule

本地优先的任务管理 + AI 分析桌面应用（Electron），可导入 Super Productivity 备份。

## 开发

要求：Node.js >= 20、Bun >= 1.1

```bash
bun install
bun run dev        # 启动 Electron 开发环境
bun test           # 运行全部测试
bun run lint       # Biome 检查
bun run typecheck  # TypeScript 项目引用构建
```

## 构建

```bash
bun run build      # 产出 packages/app/out
```

## 功能

- 任务管理：项目 / 标签 / 今日 / Upcoming / 子任务 / 计时
- 导入 Super Productivity 备份 JSON（整库覆盖，自动备份）
- Markdown 导出：项目任务清单、工作日志
- AI 分析：多 OpenAI 兼容 Provider（设置页配置 API key），日报/周报
- 设置：用户信息、Light/Dark/跟随系统主题、AI Provider 与自定义 Prompt
```

- [ ] **Step 3: 手动验收清单（全部走一遍）**

1. 全新启动 → 空库，侧栏只有 Inbox；
2. 导入 `~/Downloads/super-productivity-backup.json` → 项目/标签/任务全部出现，历史耗时保留；
3. 创建任务、编辑详情、加子任务、设截止日 → 重启后仍在；
4. 开始计时 → 暂停 → 继续 → 停止：耗时与 timeEntries 正确；
5. **计时运行中关闭窗口 → 弹确认框 → 确认后已耗时间结算进任务，data.json 中 activeTimer 为 null**；
6. 计时中 `kill -9` 强杀 app → 重启 → 计时器恢复（startedAt 未丢，elapsed 正确）；
7. 导出项目任务清单 / 工作日志 → 内容与界面数据一致；
8. 配置 AI provider → 连接测试 → 今日日报流式输出；未配置时 AI 页与 Finish Day 弹框都有跳转引导；
9. 主题切换 Light/Dark/System 即时生效并持久化；
10. Finish Day：勾选“自动触发” → 保存 → 今日任务移回项目，banner 显示；
11. `bun test && bun run lint && bun run typecheck` 全绿。

Run: `bun test && bun run typecheck && bun run lint`
Expected: 全部通过。

- [ ] **Step 4: Commit**

```bash
git add packages/app README.md
git commit -m "feat(app): quit confirmation with timer settlement, readme and acceptance"
```

---

## 验收即完成

全部 20 个任务完成后，应用满足设计规格全部条目：导入、完整任务管理、计时与退出结算、两种 Markdown 导出、多 Provider AI 分析、精简设置、JSONL 日志、共享 IPC 协议。
