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
