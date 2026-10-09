# 桌面壳从 Electron 迁到 Tauri，Rust 只做薄壳

安装包体积成为约束：Electron 版 dmg 实测 189 MB（arm64）、安装后 .app 约 615 MB，而全部业务代码打包后只有 main 192 KB + preload 124 KB + renderer 约 10 MB——超过 95% 是 Electron 运行时本身，继续在其上优化打包没有余地。决定迁到 Tauri（macOS 用系统 WKWebView），成功标准定为 dmg < 20 MB、功能 parity、启动不慢于现状。

架构上采用**薄 Rust 壳**：Electron main 进程的 35 个 invoke handler 里，绝大多数（数据 CRUD、AI 调用、导入导出、迁移）是"纯 TS 逻辑碰巧跑在 Node 里"，并不依赖 Node 特有 API，它们全部搬进 webview 里的 renderer；Rust 只做系统胶水——窗口、通知、文件对话框、alwaysOnTop、更新检查、spawn event-helper，以及一座 SSE 桥（见 Consequences）。`packages/shared` 原样保留：应用只剩一个 TS 运行时后，跨进程共享的问题自然消解，shared 变成新 app 的内部依赖，现有测试一行不动。

## Considered Options

- **保留 Node 作为 sidecar（"后端不换"）**：被否决。把 Node 运行时打进包里体积直接 +50 MB 以上，等于白换；Tauri 里 Electron main 进程本来就不存在，"后端不换"没有第三种实现。
- **Python 作为 sidecar**：被否决。打包 Python 解释器 +30~100 MB，与减体积的目标正面冲突；依赖系统 Python 则脆弱（macOS 自带 Python 已弃用）。
- **厚 Rust 核（领域逻辑用 Rust 重写）**：被否决。`timer.ts`/`completeTask.ts` 的计时状态机已有实现与测试，重写是纯风险无收益；chat agent 依赖的 `@earendil-works/pi-agent-core` 是 JS 库、搬不进 Rust，结果注定是混合架构，不如一开始就把边界画在"业务全 TS、系统胶水全 Rust"。
- **继续用 Electron、只优化打包**：被否决。体积大头是 Chromium + Node 运行时本身，不是应用代码（见上），优化不动。

## Consequences

- **CORS 决定 AI 链路形态**：OpenAI 兼容 API 一般不发 CORS 头，webview 里的裸 `fetch` 调不通。AI 日报与 chat agent 的 SSE 流由 Rust 侧 reqwest 接收、按事件推给前端——正好复刻现有 `aiChunk/chatChunk` 等 11 个推送通道的模式；官方 `tauri-plugin-http` 只够非流式请求。
- **数据零迁移是硬要求**：复刻 data.json 的全量 JSON + tmp+rename 原子写 + AES-256-GCM 加密 key 方案；数据路径显式钉在旧目录 `~/Library/Application Support/@tiny-schedule/app/`（Electron 的 `userData` 取打包后 package.json 的 `name` 字段即 `@tiny-schedule/app`，而非 productName——迁移实施时经 asar 取证核实），不能用 Tauri 按 bundle id 解析出的默认路径（`.../com.dkisser.tinyschedule`），否则老用户数据"丢失"。dev 构建用 `@tiny-schedule/app-dev/` 独立目录。
- **更新机制 v1 复刻现状**：手动检查 GitHub releases API + 提示，几十行 reqwest；官方 updater 插件（自动下载安装）列为后续增强，因为它引入永久性的更新签名密钥管理负担。
- **迁移期新旧并存**：新建 `packages/tauri-app` 与 Electron 版并存，渲染层尽量平移，两边可同时打开做行为对照；parity 验收通过后，单独提交删除 Electron。event-helper（Swift，macOS 日历写入）原样保留，改由 Rust `Command` spawn。
- **平台仍是 macOS-only**，但选型不堵死 Windows：通知、对话框等一律用 Tauri 官方跨平台插件，不用 mac-only crate。
- **渲染层技术栈不变**：React 19 + zustand + tailwind 平移；cherry-markdown 等依赖原样带走（它影响 webview 内存，不影响安装包体积）。
