# Tiny-Schedule

> 本地优先的任务管理 + AI 分析桌面应用，基于 Electron，可一键导入 Super Productivity 备份。

[English](./README.en.md) · [简体中文](#)

[![GitHub release](https://img.shields.io/github/v/release/dkisser/Tiny-Schedule?include_prereleases&sort=semver)](https://github.com/dkisser/Tiny-Schedule/releases)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-blueviolet)](https://github.com/dkisser/Tiny-Schedule/releases)
[![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.2-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![GitHub stars](https://img.shields.io/github/stars/dkisser/Tiny-Schedule)](https://github.com/dkisser/Tiny-Schedule/stargazers)

---

## 目录

- [为什么选择 Tiny-Schedule？](#为什么选择-tiny-schedule)
- [功能特性](#功能特性)
- [截图](#截图)
- [技术栈](#技术栈)
- [快速上手](#快速上手)
- [从 Super Productivity 导入](#从-super-productivity-导入)
- [AI Provider 与自定义 Prompt](#ai-provider-与自定义-prompt)
- [开发指南](#开发指南)
- [构建与发布](#构建与发布)
- [路线图](#路线图)
- [贡献](#贡献)
- [许可证](#许可证)
- [致谢](#致谢)

---

## 为什么选择 Tiny-Schedule？

一个**完全掌控数据**、**键盘流操作**、且能借助 **AI 自动复盘** 的桌面端任务管理器。

- 📦 **本地优先**：所有任务数据保存在本机 SQLite，不依赖任何云服务（除你显式配置的 AI Provider）。
- ⌨️ **键盘流**：参考 Super Productivity / Things 的快捷键体验。
- 🤖 **AI 复盘**：多 Provider OpenAI 兼容接口（OpenAI / DeepSeek / 任意兼容 endpoint），一键生成日报、周报。
- 🔁 **可迁移**：完整支持 Super Productivity 备份 JSON 整库导入 + 自动备份，避免数据被锁死。
- 📤 **可导出**：Markdown 工作日志与项目任务清单，方便贴入 Notion、Obsidian、博客。

### 与同类产品对比

| 维度 | Tiny-Schedule | Super Productivity | Things 3 | TickTick |
|---|---|---|---|---|
| 本地优先 | ✅ | ✅ | ✅ | ❌（强制云） |
| AI 日报/周报 | ✅ 多 Provider | ❌ | ❌ | ⚠️ 限定云 |
| Super Productivity 迁移 | ✅ 整库导入 | — | ❌ | ❌ |
| Markdown 导出 | ✅ | ⚠️ | ⚠️ | ⚠️ |
| 开源 | ✅ Apache-2.0 | ✅ MIT | ❌ | ❌ |
| 平台 | macOS | 全平台 | macOS / iOS | 全平台 |

---

## 功能特性

### 📋 任务管理
- 项目（Project）/ 标签（Tag）/ 今日（Today）/ Upcoming / 子任务
- 子任务层级、子任务完成进度
- 任务备注、重复任务
- 拖拽排序

### ⏱ 计时 / 时间追踪
- 单任务计时（Active Timer），窗口/系统休眠时自动暂停
- 时间历史可回溯、可统计

### 🤖 AI 分析
- 日报、周期复盘
- 多 OpenAI 兼容 Provider（设置页配置 API key、base URL、模型）
- 自定义 Prompt 模板
- 流式输出、对话视图

### 📥 导入
- Super Productivity 备份 JSON 整库覆盖导入
- 导入前自动备份当前数据

### 📤 导出
- Markdown 项目任务清单
- Markdown 工作日志（含计时明细）

### 🎨 主题
- Light / Dark / 跟随系统
- UI 规范统一（按钮、图标、间距，见 `docs/ui-guidelines.md`）

### ⚙️ 其他
- 设置页：用户信息、AI Provider、自定义 Prompt
- 自动更新检查（macOS GitHub Releases）

---

## 截图

> 📌 **截图位**：待补图。提交 PR 时建议放入 `docs/screenshots/` 目录并在此处引用。
> 推荐尺寸：1280×800 PNG 或 WebP，命名 `today.png` / `ai.png` / `settings.png` / `export.png`。

```markdown
<!-- 解除注释后即可生效 -->
<!-- ![今日页](docs/screenshots/today.png) -->
<!-- ![AI 日报](docs/screenshots/ai.png) -->
```

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | [Electron 43](https://www.electronjs.org/) + [electron-vite](https://electron-vite.org/) |
| 渲染层 | React 19 + TypeScript 5.7 |
| 样式 | Tailwind CSS 4 + Radix UI + lucide-react |
| 状态 | Zustand 5 |
| 数据 | 本机 SQLite（通过 IPC） |
| AI | [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)（多 Provider OpenAI 兼容） |
| Markdown | cherry-markdown / react-markdown / remark-gfm |
| 打包 | electron-builder（DMG, macOS arm64 + x64） |
| 工具链 | Bun ≥ 1.2 · Biome 2 · TypeScript Project References |
| 测试 | Bun Test |

---

## 快速上手

> 仅支持 macOS（GitHub Releases 提供 arm64 / x64 DMG）。其他平台需自行从源码构建。

1. 进入 [Releases](https://github.com/dkisser/Tiny-Schedule/releases) 下载最新 `.dmg`。
2. 挂载 DMG，把 `Tiny Schedule.app` 拖入 Applications。
3. 首次启动可能遇到 Gatekeeper 拦截：
   - **推荐**：在 Applications 中 **右键** `Tiny Schedule.app` → **打开** → 确认"打开"。
   - **彻底**：先退出 app，再执行 `sudo xattr -rd com.apple.quarantine "/Applications/Tiny Schedule.app"`。
4. 启动后进入 **设置页** → 填入你的 AI Provider（API key、base URL、模型），即可使用 AI 分析。

> 📥 如果你已经在用 Super Productivity，参见下一节 [从 Super Productivity 导入](#从-super-productivity-导入)。

---

## 从 Super Productivity 导入

Tiny-Schedule 支持 **整库覆盖导入** Super Productivity 的备份 JSON：

1. 在 Super Productivity 中导出备份 JSON（设置 → 备份）。
2. 在 Tiny-Schedule 设置页选择"导入"，选择该 JSON。
3. 应用会自动备份当前数据，再覆盖导入 SP 数据。
4. 完成后任务、项目、标签、子任务、计时历史即可使用。

> ⚠️ 导入为**整库覆盖**，不是增量合并；导入前会自动备份，必要时可回滚。

---

## AI Provider 与自定义 Prompt

在 **设置 → AI Provider** 中可配置：

- **多 Provider**：任意 OpenAI 兼容接口（OpenAI、DeepSeek、Azure OpenAI、自部署、Ollama 等）。
- **API key / base URL / 模型** 自由组合。
- **测试连接**：内置连通性测试按钮。
- **自定义 Prompt**：日报、周报、复盘 prompt 均可自定义。

应用内置的 Chat 视图采用流式输出，逐块渲染，体验接近 ChatGPT。

---

## 开发指南

环境要求：**Node.js ≥ 20**、**Bun ≥ 1.2**

```bash
bun install
bun run dev        # 启动 Electron 开发环境
bun test           # 运行全部测试
bun run lint       # Biome 检查
bun run typecheck  # TypeScript 项目引用构建
```

仓库采用 monorepo 形式（bun workspaces）：

```
Tiny-Schedule/
├── packages/
│   ├── app/      # Electron 主进程 + 渲染层
│   └── shared/   # 共享类型（Zod schemas）
├── scripts/      # 仓库级脚本（IPC 字面量校验等）
├── docs/         # UI 规范、设计稿
└── .github/      # GitHub Actions（仅 release.yml）
```

---

## 构建与发布

### 本地构建

```bash
bun run build      # 产出 packages/app/out
bun run release:dir   # 仅展开 .app 到 packages/app/release/
bun run release      # 产出 .dmg 到 packages/app/release/，不发布
```

> `release` 脚本默认 `--publish never`，仅做本地验证；上传到 GitHub Releases 的逻辑只在 CI 中以 `--publish always` 执行。

### 发布到 GitHub Releases

通过 [electron-builder](https://www.electron.build/) 打包 macOS `.dmg`，由 GitHub Actions 在推送 `v*` tag 时自动发布到 [Releases](https://github.com/dkisser/Tiny-Schedule/releases)。

**打 tag 触发**：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Actions 中的 `release.yml` 会在 `macos-latest` runner 上：跑 lint/typecheck/test → 用 electron-vite 编译 → 用 electron-builder 产出 `Tiny Schedule-<version>-arm64.dmg` 与 `Tiny Schedule-<version>-x64.dmg` → 自动创建同名 GitHub Release 并上传。

**首次安装（个人未签名）**：

未做 Apple Developer ID 签名与公证，macOS Gatekeeper 会拦截。可任选其一：

- **右键打开（推荐）**：挂载 `.dmg` → 把 `Tiny Schedule.app` 拖入 Applications → 在 Applications 中 **右键** `Tiny Schedule.app` → **打开** → 在弹窗中再次确认"打开"。后续双击即可正常启动。
- **清除隔离属性（更彻底）**：若右键仍被拦截，先在 Applications 退出 app，然后执行：

  ```bash
  sudo xattr -rd com.apple.quarantine "/Applications/Tiny Schedule.app"
  ```

  之后双击即可正常启动。

---

## 路线图

- [ ] Windows / Linux 打包（electron-builder 配置已留位）
- [ ] 同步层（可选，用户自托管 WebDAV / S3）
- [ ] 插件系统（自定义 Prompt / 自定义导出器）
- [ ] 多语种 UI（i18n 框架预留）
- [ ] Social preview 图片

---

## 贡献

欢迎贡献。开发前请阅读：

- [`AGENTS.md`](./AGENTS.md) — UI 规范入口
- [`docs/ui-guidelines.md`](./docs/ui-guidelines.md) — 按钮 / 图标 / 间距约定
- [`CLAUDE.md`](./CLAUDE.md) — 项目专属 Claude Code 指令

建议流程：fork → 新建分支 → 提交 PR（commit message 遵循 [Conventional Commits](https://www.conventionalcommits.org/)）。

---

## 许可证

[Apache-2.0](./LICENSE) © 2026 dkisser

---

## 致谢

- [Super Productivity](https://github.com/johannesjo/super-productivity) — 数据模型与 UX 灵感来源
- [Electron](https://www.electronjs.org/) · [electron-vite](https://electron-vite.org/) · [electron-builder](https://www.electron.build/)
- [Radix UI](https://www.radix-ui.com/) · [Tailwind CSS](https://tailwindcss.com/) · [lucide-react](https://lucide.dev/)
- [Zustand](https://github.com/pmndrs/zustand)
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)
- [Cherry Markdown](https://github.com/Tencent/cherry-markdown) · [react-markdown](https://github.com/remarkjs/react-markdown)

如果这个项目对你有帮助，欢迎点 ⭐ 或在 [Issues](https://github.com/dkisser/Tiny-Schedule/issues) 反馈想法。