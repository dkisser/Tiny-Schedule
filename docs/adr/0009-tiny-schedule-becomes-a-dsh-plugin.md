# Tiny-Schedule 成为 dsh 插件

Tiny-Schedule 不再是一个独立的 Tauri 桌面应用，而是 **DeepSeek Harness（dsh）的一个 bundle 插件**。我们决定：把任务追踪与分析/复盘域搬进 dsh，由 dsh 提供 agent 运行时与对话界面，Tauri 壳退役。

理由有四。其一，壳的成本是持续的：React renderer、Tauri 薄壳（约 3.8k 行 Rust）、打包发布链，而这些能力 dsh 已经有了——而且是更好的版本（多 provider、插件生态、会话持久化、MCP、代码运行时）。其二，用户要的是"和 AI 适配"：把域做成 dsh 的工具集，agent 就能直接查、直接改，而不是隔着 IPC 读一个 GUI 背后的数据文件。其三，交互的重心已经从"操作界面"变成"提问"：今日/四象限/长期池本来就是查询（ADR-0007），让 agent 回答比让用户点更自然；界面退化为对话旁边的两个视图。其四，dsh 的插件模型足够承载它：bundle + storage domain + slot，宿主能力（agent 运行时、调度、存储、Web）全部现成。

## Considered Options

- **无头内核重写（保留 CLI，不做插件）**：被否决。仍然要自己实现存储、鉴权、交互与分发；而且拿不到 dsh 的 agent 运行时，等于把"和 AI 适配"这件事重新做一遍。
- **纯 MCP server（把自己的域暴露成 MCP）**：被否决。MCP 只有客户端形态；要让 dsh 的 agent 用上，仍然得在 dsh 侧装一个 MCP 客户端插件，而且拿不到 dsh 的界面挂载点，四个视图无处安放。
- **保持现有 GUI，另做一个 dsh 插件**：被否决。两套数据源必然分叉（老 app 继续写 `data.json`，插件写自己的 storage），用户会同时面对两个真相。
- **直接在 dsh 仓库里写插件（贡献上游）**：被否决（现阶段）。域是私人的，迭代节奏与上游不一致；先以独立包存在，需要时再 subtree split 成独立仓库。

## Consequences

- **顶层只有两个域：任务与想法。** 今日 / 四象限 / 长期池不是三个概念，是**同一份任务的三个投影**（ADR-0007 的延续）；标签行因此只放「任务」「想法」两个入口。
- **数据搬家且只搬一次**：老 `data.json` 只读迁移进 dsh 的 storage domain（`~/.dsh/storages/task_tracker.json`），旧的 Electron 遗留 blob（约 110 KB）随之丢弃。迁移后老 app 与插件不再同步，老 app 应当退役。
- **时间只有一份真源**：时间条目是表，任务的"今日投入/总投入"是读时派生，不再两处存。
- **计时器不再自动暂停**：dsh 是纯 Node，没有宿主睡眠/闲置检测，计时器变成显式的 start/pause/stop。这是一个**能力退化**，必须在界面上说明。
- **没有定时复盘**：复盘由用户在对话里主动发起，dsh 的 agent 依据插件提供的数据生成；插件不提供调度器。
- **插件是 out-of-tree 的**：浏览器半边走 dsh 的 closure-factory 打包约定（`exports["./client"]` + `dsh.client` 声明），数据到浏览器走插件自注册的 HTTP 路由，而不是 dsh 内部的 Remote 代码生成（那条链路是 in-repo 机制，对外部包的支持未经验证）。
- **dsh 版本强耦合**：插件依赖 dsh 的 `0.1.0-rc.7` 系列包，而 dsh 仍在 developer preview，破坏性变更频繁；依赖必须钉死版本。
- **同一时刻只能有一个 dsh 进程持有该 domain**：json 后端没有跨进程写锁。
