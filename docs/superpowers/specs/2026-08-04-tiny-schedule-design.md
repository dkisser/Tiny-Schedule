# Tiny-Schedule 设计文档

日期：2026-08-04

## 1. 概述

Tiny-Schedule 是一款参考 [Super Productivity](https://github.com/super-productivity/super-productivity) 的本地化任务管理桌面应用（Electron），核心目标：

- 完整的任务管理（创建/编辑/完成/子任务/标签/项目）+ 计时器；
- 支持导入 Super Productivity 备份 JSON（全量导入，核心模块展示）；
- 新增两个核心能力：**数据导出为 Markdown**（项目任务清单 / 工作日志两种模式）与 **AI 分析**（MVP 先做日报/周报，后续扩展项目进度与优先级建议）；
- 精简设置：用户信息、主题、AI Provider 管理。

明确移除：Support Us、Help、以及原版 Settings 中的其余复杂配置。

## 2. 技术栈

| 类别 | 选型 |
|---|---|
| 应用形态 | Electron 桌面应用（保留），本地运行 |
| 前端 | React + TypeScript + Vite |
| UI | Tailwind CSS + shadcn/ui |
| 状态管理 | Zustand（渲染进程 UI 状态） |
| 包管理 / 脚本 | Bun workspaces（monorepo） |
| 代码规范 | Biome |
| 运行时 | Node.js（Electron 内置） |
| 日志 | pino（NDJSON/JSONL 输出）+ pino-roll 滚动 |
| IPC 协议校验 | zod（shared 层 schema，双向校验） |

## 3. 架构（方案 B：主进程负责数据与网络）

```
┌─────────────────── Electron Main (Node.js) ───────────────────┐
│  DataService     —— 数据存取（JSON 文档存储，userData 目录）      │
│  ImportService   —— 解析 Super Productivity 备份 JSON          │
│  ExportService   —— 生成 Markdown（项目清单 / 工作日志）          │
│  AIService       —— OpenAI 协议调用（流式），API key 只存主进程    │
│  FileBridge      —— 打开/保存文件对话框、头像本地文件读取          │
│  Logger          —— pino JSONL 关键动作日志                     │
└──────────────┬────────────────────────────────────────────────┘
               │ IPC（preload contextBridge，shared 层 zod schema 双向校验）
┌──────────────▼──────────────── Renderer (React) ──────────────┐
│  纯 UI：任务列表、项目、今日、计时器、设置、AI 分析面板              │
│  渲染进程不直接碰磁盘和网络                                        │
└────────────────────────────────────────────────────────────────┘
```

要点：

- 所有磁盘读写与 AI HTTP 请求在主进程完成，API key 不进入渲染进程上下文。
- 存储使用 JSON 文档文件（`userData/data.json`），不引入 SQLite 原生模块，避免 Electron 原生编译问题。
- 渲染进程通过 preload 暴露的类型安全 API 调用主进程。

### 3.1 Monorepo 结构与共享协议层

```
Tiny-Schedule/
├─ packages/
│  ├─ shared/     # IPC 协议（zod schema：channel 名、参数、返回值）、数据模型类型、日志类型
│  ├─ main/       # Electron 主进程：DataService / AIService / Import / Export / Logger
│  └─ renderer/   # React UI (Vite)
├─ biome.json
├─ bun workspace / tsconfig references
```

- IPC 协议统一定义在 `packages/shared`，主进程与渲染进程共同依赖；协议变更时 TypeScript 编译期两边同时报错，避免散弹式修改。
- zod schema 对请求参数与返回值双向运行时校验。

### 3.2 JSONL 日志

- 使用 pino（默认输出即 NDJSON/JSONL），配 pino-roll 做文件滚动，不自造轮子。
- 日志目录：`userData/logs/app-*.jsonl`。
- 记录关键动作：导入、导出、AI 调用（不含 key）、计时开始/暂停/结束/结算、设置变更。

## 4. 数据模型与导入

### 4.1 归一化模型（存于 `userData/data.json`）

| 集合 | 关键字段 | 来源 |
|---|---|---|
| tasks | id, title, projectId, tagIds, isDone, dueDay, timeEstimate, timeSpent, timeSpentOnDay{date:ms}, subTaskIds, created | task.entities |
| projects | id, title, icon, isArchived, theme（仅主色） | project.entities |
| tags | id, title, taskIds | tag.entities |
| notes / planner / metric / boards 等 | 原样保留，暂不展示 | 备份同名节点 |
| settings | userName, avatar, theme, aiProviders[], aiPrompt, autoAiAnalyzeOnFinishDay | 新增 |

### 4.2 导入规则

- 校验顶层结构（`data` + `crossModelVersion`），版本不兼容时给出明确错误提示；
- ID 冲突处理：整库导入，如本地已有数据则提示“覆盖 / 取消”（不做逐条合并，YAGNI）；
- 系统标签保留语义：TODAY → 今日、EM_IMPORTANT → 重要、EM_URGENT → 紧急；
- 导入前自动备份当前 `data.json` 为 `data.backup.json`。

## 5. UI 结构与页面

两栏布局：左侧 Sidebar + 右侧内容区；右侧顶部计时条全局常驻。

```
┌──────────┬────────────────────────────────────────┐
│ Sidebar  │ 顶部计时条（常驻、最醒目）                 │
│ 📋 项目ⁿ  │ ▶/⏸/⏹ | 当前任务 | 00:13:42 / 3h | 番茄状态 │
│ 🏷 标签   │ ──────────────────────────────────── │
│ 🔍 搜索   │ 内容区（今日 / 项目 / 标签 / 设置 / AI）   │
│ 📅 Upcoming│ 今日：时间指标 + 任务卡片 + Finish Day   │
│ 🤖 AI分析 │ 右侧面板位：任务详情 / 项目笔记（内联或抽屉）│
│ 📥 导入/导出│                                       │
│ ⚙ 设置   │                                        │
└──────────┴────────────────────────────────────────┘
```

### 5.1 计时条与计时行为

- 计时条置顶常驻：任何页面可见当前任务、已耗时/预估，开始/暂停/停止按钮最大最醒目；进行中任务卡片同步高亮。
- 今日视图顶部显示三个时间指标：预估剩余 / 今日工作 / 连续工作。
- **退出行为**（明确不做 Super Productivity 式强制拦截）：
  - 计时运行中关闭窗口 → 弹出确认提示（非强制拦截）；
  - 用户确认后，先把已消耗时间结算到任务耗时（timeSpentOnDay / timeSpent）再退出；番茄钟跑一半退出同理，已跑部分照算；
  - 计时采用“开始时间戳 + 每 30s 心跳持久化”，App 崩溃重启后自动补结算，不丢时间。

### 5.2 任务管理

- 任务卡片列表：标题、标签、耗时/预估；悬停显示操作（开始计时、完成、删除）；
- 任务详情（选中任务时展示，内联面板或抽屉）：标题、备注（Markdown）、子任务、标签、截止日、时间预估、开始/结束时间记录；
- 支持新建、编辑、完成、删除任务；项目视图、标签视图、今日视图、Upcoming（按 dueDay）。

### 5.3 Finish Day 流程

1. 点击 Finish Day → 弹出确认框：
   - ☑ 是否触发 AI 日报分析；
   - ☑ “以后自动触发 AI 分析”（勾选后下次不再询问，直接分析）；
   - Provider 选择下拉（本次用哪个 Provider）。
2. 若未配置任何 Provider：确认框提示并一键跳转设置页，配置完成后再回来继续。
3. 确认后：结算今日计时 → AI 日报流式生成展示 → 今日视图进入“已完成”状态。

### 5.4 导入 / 导出

- 侧栏入口 → 文件对话框；
- 导入：选择 Super Productivity 备份 JSON；
- 导出：选模式（项目任务清单 / 工作日志）与项目范围，保存为 `.md`。

## 6. Markdown 导出

两种模式（MVP 均实现）：

1. **项目任务清单**：`# 项目名` 下的任务列表，含标题、完成状态、标签、截止日、预估/实际耗时；
2. **工作日志（Worklog）**：按日期分组，每行列出日期、开始/结束、时长、任务标题（含子任务），数据来自 timeSpentOnDay 与时间记录。

导出为纯函数实现（数据 → Markdown 字符串），便于单测。

## 7. AI Provider 架构与 AI 分析

### 7.1 Provider 注册表（代码内置，可扩展）

```ts
// packages/main/src/ai/providers.ts —— 新增 Provider 只需在此加一条
export const PROVIDER_REGISTRY = [
  { id: 'openai',   name: 'OpenAI',   icon: 'openai.svg',   baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', icon: 'deepseek.svg', baseUrl: 'https://api.deepseek.com/v1' },
  // …后续新增 Provider 改这一个文件即可
]
```

- 全部走 OpenAI Chat Completions 协议，统一 `fetch + SSE 流式`实现；
- 用户配置项：API key（必填，主进程加密存储）、模型名（文本输入 + 常见模型建议列表）、是否默认；
- 操作：添加（选 Provider 带图标）/ 设默认 / 删除 / 连接测试（调 `/models` 或最小请求验证 key）；
- 无“启用/禁用”开关（冗余，不设）。

### 7.2 AI 分析

- 主进程 `AIService.analyze({ scope, promptTemplate, providerId })`：收集数据（任务、耗时、完成情况）→ 渲染 Prompt → 流式返回；
- 范围：今日 / 本周 / 指定项目（MVP 先做日报/周报）；
- 渲染进程 AI 面板：范围选择 + 流式 Markdown 渲染 + 复制 / 保存为 .md；
- Prompt 配置（设置页 AI 小节）：支持自定义多行 Prompt，占位符 `{{date}}`、`{{data}}`；未配置时使用内置默认 Prompt（含数据结构说明 + 输出格式要求）。

### 7.3 超时策略（分段，不设总时长上限）

- 连接 / 首 token 超时：发起请求后 30s 内无响应判超时（覆盖 key 错误、域名不通）；
- 流式空闲超时：开始输出后每收到 chunk 重置计时，连续 60s 无数据才判中断；
- 慢输出只要持续有数据就一直等，生成 5 分钟也不会被掐断。

## 8. 设置页（三小节）

1. **用户信息**：用户名 + 头像（URL 或本地文件，本地文件经主进程读取存储）；
2. **主题**：Light / Dark / 跟随系统；
3. **AI**：Provider 列表管理（添加/删除/设默认/连接测试）、默认 Provider、自定义分析 Prompt、“Finish Day 自动触发 AI 分析”开关。

## 9. 错误处理

- **导入**：非法 JSON / 结构不符 → 明确错误提示，不破坏现有数据；导入前自动备份。
- **数据写入**：原子写（临时文件 + rename）+ 写前备份；启动时校验数据，损坏则回退备份并提示。
- **计时结算**：心跳持久化，崩溃重启后自动补结算。
- **AI 调用**：401/429/网络错误分类提示，附“去设置”入口；流式中断保留已生成内容。
- **IPC**：shared 层 zod 双向校验，协议不一致在开发期即暴露。

## 10. 测试策略

- **单测（Bun test）**：核心纯逻辑——备份解析/归一化、Markdown 导出（两种模式）、计时结算逻辑、Prompt 渲染。价值最高、最易出错。
- **集成测试**：日志写入、数据存储读写回环。
- **手动验收清单**：导入真实备份 → 编辑任务 → 计时 → 中途退出验证结算 → 导出 .md → AI 分析全流程。
- UI 组件不写单测（MVP 性价比低）。

## 11. 范围外（明确不做）

- Support Us / Help / Donate；
- 原版 Settings 的复杂配置（快捷键、提醒、同步、番茄详细配置等）；
- 数据逐条合并导入、多用户档案、云同步；
- Boards / Habits / Metric 等模块的 UI（数据仅保留）。
