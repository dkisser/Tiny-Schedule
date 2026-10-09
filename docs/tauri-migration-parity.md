# Tauri 迁移：功能 parity 验收清单

本文件是 [ADR 0005](./adr/0005-tauri-thin-rust-shell.md) 的验收证据。底本是
`packages/shared/src/ipc.ts` 的 `IpcInvokeContract`——它是跨进程契约的唯一真相，
35 个 invoke 与 11 个推送通道都以它为准。Electron 版已于本 wave 删除，表中的
"Electron 原实现"一列指删除前 `packages/app` 里的位置（git 历史 `f6ecdf1` 可查）。

**结论：35/35 invoke 语义等价，11 个推送通道全部已重建新形态（`timer:changed` 的
死订阅已删除，见下方"已知缺口"第 4 项），已知缺口共 5 项（第 3 节）。**

---

## 后续：移植到 main 的 domain/contract 架构

本文件的对照表记录的是**迁移当时**的契约（35 invoke / 5 订阅），下表因此保持原样，不随后续演进改写——它的价值在于记录"当时对每个通道做了什么判断"，而不是描述今天的契约规模。

其后 main 完成了一次架构重构：`packages/shared` 拆成 `domain/`（纯领域模型与不变量）+ `contract/`（IPC 契约），主进程拆成 `handlers/` + `services/` + `infra/`。Tauri 分支是在这次重构之前分叉的，无法机械合并（132 处冲突），因此改为语义移植：把 Tauri 版重新构建到新基线上，并吸收 main 在此期间的行为修复。

契约规模的相应变化：

| | 迁移当时 | 移植之后 | 差异来源 |
|---|---|---|---|
| invoke | 35 | 48 | main 新增的想法命令集 9 个、`followUpResolve`/`Reopen` 2 个、`timingStop`、`storeWritable` |
| 订阅 | 5 | 6 | ADR-0004 新增 `onStoreWritable` |

下节"已知缺口"第 1 项（Dock 退出导致的离线时长误计）已在本 PR 修复，见该节末。

---


## 一、35 个 invoke 逐行对照

实现位置一列给的是 `packages/tauri-app/src/api/` 下的切片文件与行号（相对该
文件）。证据一列指向具体测试用例。

### 数据 CRUD 切片（17 个）— `src/api/data.ts`

所有 17 个 handler 都从 `DataStore`（webview 内的文件系统 store）读写，取代
Electron 的 `ipcMain.handle` 循环。原先集中在 IPC 循环里的 zod 校验，现在在每个
调用点按契约 schema 逐个 `parse()`（`data.ts:70`），保证畸形请求在触达 store
之前就抛。

| # | 契约 key | 通道 | Tauri 实现 | 语义等价证据 |
|---|---|---|---|---|
| 1 | `dataLoad` | `data:load` | `data.ts:79` | `api/data.test.ts:64` dataLoad 返回掩码数据，apiKeyEncrypted 不进渲染层 |
| 2 | `taskUpsert` | `task:upsert` | `data.ts:81` | `api/data.test.ts:113` 完成时结算计时；`:136` 重存已完成任务不结算；`:84` CRUD 往返落盘 |
| 3 | `taskDelete` | `task:delete` | `data.ts:96` | `api/data.test.ts:104` 从父任务 subTaskIds 摘除该 id |
| 4 | `followUpUpsert` | `followUp:upsert` | `data.ts:112` | `api/data.test.ts:292` followUp/idea CRUD 往返 |
| 5 | `followUpDelete` | `followUp:delete` | `data.ts:121` | `api/data.test.ts:292` 同上 |
| 6 | `ideaUpsert` | `idea:upsert` | `data.ts:131` | `api/data.test.ts:292` 同上 |
| 7 | `ideaDelete` | `idea:delete` | `data.ts:140` | `api/data.test.ts:292` 同上 |
| 8 | `orderSet` | `order:set` | `data.ts:150` | `api/data.test.ts:233` 按视图存顺序且不碰 tasks |
| 9 | `projectCreate` | `project:create` | `data.ts:158` | `api/data.test.ts:150` 标题截断 + 分配 id |
| 10 | `projectUpdate` | `project:update` | `data.ts:184` | `api/data.test.ts:159` 拒绝改系统 Inbox；`:168` 只合并请求里出现的字段 |
| 11 | `projectDelete` | `project:delete` | `data.ts:208` | `api/data.test.ts:179` 其任务迁到 Inbox |
| 12 | `tagCreate` | `tag:create` | `data.ts:225` | `api/data.test.ts:38` 切片恰好实现这 17 个、无多余 |
| 13 | `tagUpdate` | `tag:update` | `data.ts:234` | `api/data.test.ts:38` 同上 |
| 14 | `tagDelete` | `tag:delete` | `data.ts:249` | `api/data.test.ts:190` 删除标签后任务 tagIds 保留，chip 仍可见 |
| 15 | `settingsUpdate` | `settings:update` | `data.ts:261` | `api/data.test.ts:203` 新 key 加密、`<unchanged>` 保留原密文 |
| 16 | `finishDay` | `day:finish` | `data.ts:308` | `api/data.test.ts:245` 未完成的今日任务顺延到明天 |
| 17 | `timerSync` | `timer:sync` | `data.ts:328` + `api.ts:159` 包装 | `api/data.test.ts:260` 拒绝为已完成任务持久化计时；`:276` 正常计时落盘；`api.test.ts:148` 被扫除的计时以 null 抵达订阅者 |

`timerSync` 是唯一被两层包起来的 invoke：`data.ts` 只负责把修正后的计时落盘，
`api.ts` 因为拥有事件总线而负责广播这次丢弃（Electron 里由 main 进程推
`timerChanged`）。分工理由见 `api.ts:26-36`。

### AI / chat 切片（10 个）— `src/api/ai.ts`

| # | 契约 key | 通道 | Tauri 实现 | 语义等价证据 |
|---|---|---|---|---|
| 18 | `aiRegistry` | `ai:registry` | `ai.ts:180` | `api/ai.test.ts:180` 返回内置 Provider，不泄漏 baseUrl |
| 19 | `aiTestProvider` | `ai:testProvider` | `ai.ts:182` | `api/ai.test.ts:188` 报 HTTP 状态但不泄漏 key；`:200` 未配置时不发请求 |
| 20 | `aiProviderKeyReveal` | `ai:providerKeyReveal` | `ai.ts:223` | `api/ai.test.ts:211` 返回明文 key，未知 Provider 返回空 |
| 21 | `aiAnalyze` | `ai:analyze` | `ai.ts:230` | `api/ai.test.ts:220` chunk* 后单个 done 带全文并持久化历史；`:249` 流中断发 aiError 带部分文本；`:268` 无 Provider 时不发网络请求 |
| 22 | `chatSessionsList` | `chat:sessionsList` | `ai.ts:298` | `api/ai.test.ts:351` create/list/delete 经 store 往返 |
| 23 | `chatSessionCreate` | `chat:sessionCreate` | `ai.ts:300` | `api/ai.test.ts:351`；`:365` 首条消息成为会话标题（截断 30 字） |
| 24 | `chatSessionDelete` | `chat:sessionDelete` | `ai.ts:305` | `api/ai.test.ts:351` 同上 |
| 25 | `chatSend` | `chat:send` | `ai.ts:310` | `api/ai.test.ts:392` 未知会话报错而非抛异常；`:402` 无 Provider 时请求前就拒绝 |
| 26 | `chatContinue` | `chat:continue` | `ai.ts:319` | `api/ai.test.ts:392` 同上错误语义 |
| 27 | `chatStop` | `chat:stop` | `ai.ts:324` | `api/ai.test.ts:418` 无 run 时解析而非抛异常 |

AI 链路有三处结构性差异，都不是行为差异（`ai.ts:26-38`）：没有 IPC 层（推送走本地
事件总线，payload 经同一套共享 schema 校验，与 preload 交给渲染层的字节一致）；
key 的边界从"跨进程"变成"同进程内只有本模块解出明文"；`store.update` 落文件系统
所以原本同步的 handler 全部 await。`aiProviderKeyReveal` 的语义边界变化写在
`ai.ts:200-222`——它现在应读作 UI 便利而非权限闸门。

### 文件切片（3 个）— `src/api/files.ts`

| # | 契约 key | 通道 | Tauri 实现 | 语义等价证据 |
|---|---|---|---|---|
| 28 | `importRun` | `import:run` | `files.ts:52` | `api/files.test.ts:116` 合并进空 store 并落盘；`:137` 已有任务时先询问；`:166` 空 store 不弹窗；`:181` 导入覆盖的计时被丢弃并广播；`:174` 非备份文件报 INVALID_BACKUP |
| 29 | `exportMarkdown` | `export:markdown` | `files.ts:85` | `api/files.test.ts:289` 写出项目清单；`:316` 取消保存框不写文件且不报错（用 error 字段有无区分"用户退出"与"失败"）；`:327` worklog 默认全区间 |
| 30 | `selectAvatar` | `avatar:select` | `files.ts:111` | `api/files.test.ts:363` 返回带 mime 的 data URL；`:369` jpg/jpeg 都映射 image/jpeg；`:387` 取消返回 null |

对话框替换：`dialog.showOpenDialog` → `plugin-dialog` 的 `open()`，
`showSaveDialog` → `save()`，`fs.promises` → `plugin-fs`。围绕它们的决策逻辑（合并
确认、默认文件名、mime 推导）未变。

### 系统切片（3 个）— `src/api/system.ts`

| # | 契约 key | 通道 | Tauri 实现 | 语义等价证据 |
|---|---|---|---|---|
| 31 | `appOpenExternal` | `app:openExternal` | `system.ts:69` | `api/system.test.ts:101` 打开 https；`:107` 其余 scheme 一律拒绝且不碰 opener |
| 32 | `appCheckUpdate` | `app:checkUpdate` | `system.ts:74` + `bridge/updater.ts` | `api/system.test.ts:128` 对运行版本报更新；`:140` 只提示、绝不返回下载链接；`:157` 离线降级成 error。传输层从 `electron.net.fetch` 换成 `tauri-plugin-http`（决策逻辑不动，见 `updater.ts:11-19`） |
| 33 | `calendarAddTask` | `calendar:addTask` | `system.ts:87` → Rust `calendar.rs` | `api/system.test.ts:184` 发项目前缀标题+dueDay+notes；`:202` 无项目不加前缀；`:210`/`:219` 无 dueDay / 未知 id 在调 Rust 前就拒绝；`:226` invoke 拒绝转成 `unknown` 而非抛出 |

### 计时与窗口切片（2 个）

| # | 契约 key | 通道 | Tauri 实现 | 语义等价证据 |
|---|---|---|---|---|
| 34 | `notifyPhaseComplete` | `notify:phaseComplete` | `api/timer.ts:127` | 走 `tauri-plugin-notification`。权限拒绝只 warn 不抛——触发它的对话框本来就在屏幕上（`timer.ts:85-93`）。无单测覆盖，见下方"覆盖说明" |
| 35 | `setAlwaysOnTopWindow` | `window:setAlwaysOnTop` | `api/window.ts:16` → Rust `host.rs:31` | Rust 侧同样在 enable 后 `show()`，与 Electron 的 `setAlwaysOnTop` + `show()` 一致。启用浮层时 `floating` vs `screen-saver` 的平台差异由 Tauri 内部吸收 |

---

## 二、11 个推送通道的新形态

Electron 里这些是 main → renderer 的单向推送（`webContents.send`）。Tauri 下没有
第二个进程，只有三种新形态：**Rust emit**（系统胶水产生）、**本地事件总线**（产生者
与消费者同在 webview）、**Rust SSE 桥**（流式响应的转发）。

| # | 通道 | 原形态 | 新形态 | 产生点 | 订阅入口 |
|---|---|---|---|---|---|
| 1 | `ai:chunk` | `webContents.send` | 本地事件总线 | `api/ai.ts:268` | `onAiEvent`（`ai.ts:347`） |
| 2 | `ai:done` | `webContents.send` | 本地事件总线 | `api/ai.ts:285` | 同上 |
| 3 | `ai:error` | `webContents.send` | 本地事件总线 | `api/ai.ts:243`, `:291` | 同上 |
| 4 | `chat:chunk` | `webContents.send` | 本地事件总线 | `api/ai.ts:167`（chatAgent sink） | `onChatEvent`（`ai.ts:354`） |
| 5 | `chat:toolEvent` | `webContents.send` | 本地事件总线 | `api/ai.ts:169` | 同上 |
| 6 | `chat:status` | `webContents.send` | 本地事件总线 | `api/ai.ts:170` | 同上 |
| 7 | `chat:done` | `webContents.send` | 本地事件总线 | `api/ai.ts:171` | 同上 |
| 8 | `chat:error` | `webContents.send` | 本地事件总线 | `api/ai.ts:172` | 同上 |
| 9 | `ui:newTask` | `webContents.send` | **Rust emit** | `src-tauri/src/menu.rs:64`（菜单项 id 与事件名同为一个常量 `ui:new-task`，Rust 测试 `menu.rs:151` 钉住这层绑定） | `onNewTask`（`api/timer.ts:130`） |
| 10 | `ui:updateAvailable` | `webContents.send` | **本地事件总线** | `bridge/updater.ts` 启动检查 | `onUpdateAvailable`（`api/system.ts:85`） |
| 11 | `timer:changed` | `webContents.send` | 本地事件总线 | `api.ts` 的本地总线：`api/files.ts` 的导入扫除 + `timerSync` 包装里的 store 丢弃 | `onTimerChanged`（`api.ts`） |

事件总线不用 Tauri `emit` 是有意的：生产者与消费者同在一个 webview，走一遍
Rust 事件总线只会多出一次序列化/反序列化而没有收益（`ai.ts:70-77`）。监听器错误
按回调隔离，一个坏订阅者不会中断整条事件流——这与 Rust 侧 emit 到已销毁窗口是
no-op 的性质相同。

第 11 行 `timer:changed` 曾是唯一的例外中的例外：它既没有 Rust 生产端，也没有本地
生产者，订阅永远不会触发。该死代码已删除，本地总线是它现在唯一且真实的生产者。
详见第三节第 4 项。

### 三条 Rust → webview 系统事件（不在契约里，但 parity 必需）

契约只描述 main → renderer 通道，而 Tauri 的系统胶水产生了三条新通道：

| 事件 | 产生点 | 订阅入口 | 用途 |
|---|---|---|---|
| `system:idle` | `src-tauri/src/idle.rs:81`（每 20s） | `bridge/systemEvents.ts:200` | macOS 空闲秒数读数 |
| `app:close-requested` | `src-tauri/src/close.rs:132` | `bridge/systemEvents.ts:209` | 退出请求，需渲染层确认 |
| `sse://{request_id}` | `src-tauri/src/sse.rs:153` | `bridge/sseFetch.ts` | AI/chat 的 SSE 流中继 |

最后一条是 ADR 0003 里 CORS 决定的直接后果：OpenAI 兼容 API 一般不发 CORS 头，
webview 里的裸 `fetch` 调不通，所以流由 Rust 侧 reqwest 接收、按事件转发。
`sseFetch.test.ts` 有 25 个用例覆盖分块边界、取消、错误分类与并发隔离。

---

## 三、已知缺口

共 5 项：1 项真实行为回归（Dock 退出）、2 项语义退化、1 项平台分发缺陷、1 项死代码。
其中第 1 项的最终行为取决于 Fix-A 的睡眠计费修复，见其末尾的交接说明。

### 1. Dock 右键退出绕过退出确认，且离线时长会被完整计满

**现象**：从 Dock 图标右键 → 退出，有计时在跑时不会弹确认框。

**范围**：仅 Dock 右键这一条路径。Cmd+Q 与菜单栏"退出"**已覆盖**。

**根因**：`on_exit_requested` 只在有东西抛出 `RunEvent::ExitRequested` 时才跑。
`menu.rs` 为此绕开了 `PredefinedMenuItem::quit`，改装带显式 `CmdOrCtrl+Q` 加速键
的自定义项，其点击走 `AppHandle::exit` 从而确实触发该事件——这是 tauri#9198 的
workaround。但 Dock 右键走的是同一条 `applicationShouldTerminate:` 路径，tao 没有
实现这个 delegate 方法，于是直接落到 `LoopDestroyed` → `RunEvent::Exit`，没有任何
拦截点。

**上游状态**：tauri#9198 自 2024-03-16 起 open，修复它的 PR tao#1003 未合入。要在
本仓库关掉它，要么 `unsafe` 覆写 `NSApplication` delegate，要么 fork tao。

**⚠️ 更正**：本节此前写的是"Dock 退出丢掉的是这次会话尚未结算的时长……丢的只是
退出前那几十秒"，并以"下次启动 `restore` 会读回 `activeTimer` 并继续计时"论证数据
无损坏。**这个论证不成立**，现更正如下。

`restore` 走 `dropStaleTiming`，它只在任务 `isDone` 时丢弃计时器。对未完成的任务，
计时器带着 `isPaused: false, startedAt: <退出时刻>` 被原样恢复；而 `computeElapsed`
是 `accumulatedMs + (isPaused ? 0 : now - startedAt)`——**整段离线时长被完整计入
工时**。实测（用仓库自身的 `@tiny-schedule/shared`）：

```
Dock 退出后 8 小时重开，elapsed = 8.00 h（任务 isDone=false，dropStaleTiming 保留）
dropStaleTiming 保留了它？ true
```

即这不是"丢失几十秒"，而是"凭空多出 8 小时"：用户在 Dock 上误退出一次，第二天打开
就看到一个荒谬的工时数。原版的 `before-quit` 覆盖了 Dock 路径（会结算），所以这是
真实的 parity 回归。

**修复归属（跨 worker 依赖）**：Dock 路径本身要堵住需要 `unsafe` 或 fork tao，与本
轮"无 unsafe"的约束冲突，因此实际修复取另一条路——在 `restore` 里检测"恢复时计时器
处于运行态且距 `startedAt` 已超过阈值"，把它转成 `autoPausedBy: 'sleep'` 的暂停态、
不结算（与 ADR-0002"恢复路径只清不记"的既有哲学一致）。**该改动属于 Fix-A（前端
侧）**，且它与 Fix-A 的 C1（睡眠检测把整段睡眠时长计入工时）修复**联动**：两条都
落在 `systemEvents.ts` / `stores/timer.ts` 的恢复与暂停语义上，C1 定下"睡眠期间的
墙钟时间如何处理"的原则，本项必须服从同一原则，否则会出现"睡眠不计费、但退出后
离线计费"这种自相矛盾的行为。**本节描述的最终行为以 Fix-A 的实现为准**，此处只
记录缺口与约束。

**为何记录而不绕过 Dock 路径**：workaround 的代价是 `unsafe` 的 macOS-only 代码，而
本应用是单窗口工具，Cmd+Q 是压倒性的主流退出手势。证据记录在
`src-tauri/src/close.rs:29-49` 的模块文档里。

#### 已修复

缺口记录后未修复，直到本次移植才落地。修复按上文那条路走：`systemEventsLogic.ts`
新增纯函数 `isOfflineResume(timer, now)`，`stores/timer.ts` 的 `restore` 在
`dropStaleTiming` 之后调用它——运行态且距 `startedAt` 超过
`SUSPEND_THRESHOLD_MS`（30 秒，与实时睡眠检测共用同一个阈值，避免"睡眠不计费、
退出后离线计费"的自相矛盾）时，转成 `autoPauseTimer(..., 'sleep', now - startedAt)`
的暂停态并落盘，不结算。

实测（未完成的任务，退出后 8 小时重开）：

```
修复前 computeElapsed = 8 小时
修复后 isPaused = true | autoPausedBy = sleep
修复后 computeElapsed = 0 小时
```

暂停前的真实工作时长（`accumulatedMs`）完整保留，用户显式恢复后才继续计时。Dock
路径本身的拦截仍未做（需 `unsafe` 或 fork tao），但它造成的数据损坏已经消除：无论
从哪条路径退出，重开时都不会把离线时间计成工时。

### 2. `aiProviderKeyReveal` 语义退化：明文 key 与加密数据同处一个堆

**现象**：契约里 `aiProviderKeyReveal` 是跨进程边界的一次解密——Electron 版它在 main
进程里用 AES-256-GCM 解密，只把明文交给 renderer。现在解密发生在 renderer 自己的
进程里（`src/api/ai.ts` 直接调 `decryptKey`），因此**明文 key 与它加密的数据、以及
其他所有可读内存同处一个堆**。

**为什么这仍然是"语义等价"**：返回值、错误行为、未知 Provider 返回空串等对外可观测
的行为都一致，`api/ai.test.ts:211` 仍覆盖。变的是**信任边界**，不是契约语义。

**为何不能算严重缺口**：ADR 0003 决定了应用只剩一个 TS 运行时，明文 key 在 renderer
里是既定结果——渲染层本来就要用它发请求。真正的缓解不在这一层，而在"webview 被攻
破时损失多大"，这也是 `src-tauri/src/sse.rs` 模块文档里 SSE 桥信任模型的论证前提
（攻击者此时已经能直接读到 key，再加一层出站限制并不能切断这条链）。

### 3. `event-helper` 是 arm64-only，x64 dmg 里的日历写入不可用

**现象**：`packages/tauri-app/bin/event-helper` 只构建了 arm64 版本。x86_64 的 dmg
里装的仍是同一个 arm64 二进制，Intel Mac 或 Rosetta 下的用户点"添加到日历"时 spawn
失败，被 `calendar.rs` 归成 `code: 'unknown'`，用户只看到一个笼统错误。

**证据**（`file` 命令实测）：

```
$ file packages/tauri-app/bin/event-helper
packages/tauri-app/bin/event-helper: Mach-O 64-bit executable arm64
```

根因是 `scripts/build-event-helper.sh` 执行 `swift build -c release` 而没有传
`--arch`；在 Apple Silicon 上构建时产出的自然是 arm64-only。

**未修的原因**：构建脚本在 `scripts/`，不在本 wave 的改动范围（本 wave 只动
`src-tauri/**` 与文档）。修法是把脚本改成 `swift build --arch arm64 --arch x86_64`
产出 universal binary，属独立一次改动。

### 4. `timer:changed` 死订阅——已删除

**现象**：第二节表格第 11 行此前写的是"**Rust emit + 本地总线并联**"。**这个描述不
成立**：Rust 侧从未 emit 过这个事件（全 Rust 侧 grep 的 emit 目标只有 `sse://…`、
`app:close-requested`、`ui:new-task`、`system:idle` 四个），`HOST_EVENTS.timerChanged`
也没有本地生产者。`api.ts` 的 `listen` 订阅是一个永不触发的死代码。

**已修复**：删除了 `api/timer.ts` 的 `HOST_EVENTS.timerChanged` 常量、该切片里的
`onTimerChanged`，以及 `api.ts` 里把本地总线与 Rust `listen` 并联的那个包装。

**为什么可以整条删掉而不是只删 Rust 那一半**：这个通道原本有两个来源——Rust 主机事件，
与本地总线。本地总线是**有**生产者的（`api/files.ts` 的导入扫除，以及 `api.ts` 里
`timerSync` 的包装：当 store 拒绝保留一个已完成任务的计时器时，必须把丢弃通知渲染层，
否则它的时钟会继续为一个什么都没持久化的计时器走秒）。而 sleep/空闲自动暂停——当初
促成"并联"的那个场景——其决策已整体搬到 `bridge/systemEvents.ts`，它经 `api()` 写入，
因此走的正是同一条本地总线，不需要第二个来源。

**结果**：`onTimerChanged` 仍在契约里（`shared/src/api.ts` 的 5 个 `on*` 之一，UI 与
`stores/timer.ts` 都在订阅），但它的实现只剩本地总线，由 `api.ts` 直接提供而不是任何
切片。第二节表格第 11 行相应改为"仅本地事件总线"。

### 5. Cmd+W 从"确认并退出"变为"隐藏"——申报过的漂移，非疏漏

**现象**：Electron 版按 Cmd+W（关闭按钮）时若有计时在跑会弹确认框，确认后退出。
Tauri 版按 Cmd+W 是**隐藏窗口**，不退出、不结算。

**这是刻意的设计，不是遗漏**，依据是 macOS 惯例：Cmd+W 关闭的是"文档/窗口"，应用
本身留在 Dock 与菜单栏里；只有 Cmd+Q 才退出。实现见 `src-tauri/src/close.rs:105`
（`CloseRequested` → `window.hide()`），`:89` 的 `on_window_event` 是它的补充。
计时因此继续在跑，与"应用还在运行"的语义一致——隐藏一个仍在计时的应用不该让它
暂停，暂停该由用户显式操作触发。

**为何记在这里**：它是与原版的可观测行为差异，且已经过设计判断，记为**申报过的漂移**，
以免日后被当作回归"修回去"。Cmd+Q 仍然是"确认后退出"，那条路径与原版一致。

### 覆盖说明（非缺口）

`notifyPhaseComplete` 与 `setAlwaysOnTopWindow` 没有切片级单测。这两个是薄转发
（前者到 `tauri-plugin-notification`，后者到一条 8 行的 Rust command），逻辑风险
低；它们的"存在且可调用"由 `api.test.ts:50`/`:56` 的契约完整性测试保证。后者
另有 Rust 侧的调用路径间接覆盖。记录在此是为了让清单本身可审计，而不是声称"全部
逐条有独立测试"。

---

## 四、契约完整性如何被守住

`packages/shared/src/ipc.ts` **零改动**——W3.5 已确认。契约的完整性由两个方向的
静态保证：

- **类型方向**：`DataInvokeKey` / `AiInvokeKey` / `TimerInvokeKey` 用
  `Extract<IpcInvokeKey, ...>` 从契约派生，切片少实现一个键就编译不过。
- **运行时方向**：`api.test.ts` 断言契约恰好是 35 invoke + 5 订阅（`:42`，钉死
  数字防止 shared 悄悄缩小表面积）、每个键存在可调（`:50`/`:56`）、没有一个是抛
  `not implemented` 的桩（`:64`）、对象只含契约里的键（`:72`）、切片之间无重复
  认领也无遗漏（`:81`）。

---

## 五、event-helper 的位置变更

macOS 日历写入用的 Swift CLI（`event-helper`）原在 `packages/app` 下，是 Electron
包的一部分，但它与 Electron 毫无关系——Tauri 侧由 Rust `Command` spawn 它
（`src-tauri/src/calendar.rs`）。删除 Electron 包时它被 `git mv` 整体搬进
`packages/tauri-app/`（Swift 源码 + 产物 + 构建脚本），路径引用同步更新：

- `tauri.conf.json` 的 `bundle.resources`：`../../app/bin/event-helper` → `../bin/event-helper`
- `src-tauri/src/calendar.rs` 的 dev 候选路径：同上
- 根 `package.json` 的 `build:event-helper`：指向 `packages/tauri-app`
- `.gitignore` / `biome.json` 里的路径

历史保留（`git mv` 而非删+建）。它是这个 app 的专属组件，随 app 包自洽。

⚠️ 该二进制是 **arm64-only**（`file` 实测：`Mach-O 64-bit executable arm64`），因为
`scripts/build-event-helper.sh` 的 `swift build -c release` 没有指定 `--arch`。x86_64
dmg 里的日历写入因此不可用——详见第三节第 3 项。

---

## 六、复现验收

```bash
bun run lint         # Biome
bun run typecheck    # tsc -b（shared + tauri-app 两个 project reference）
bun run test         # 318 个用例（tauri-app 199 + shared 119）
cargo check --all-targets
cargo clippy --all-targets -- -D warnings
cargo test           # 24 个 Rust 用例
bun run release      # 双架构 dmg，每个 < 20 MB 门禁
```

dmg 体积门禁同时钉在 `release.yml` 的 "Enforce size budget (< 20 MB per dmg)" 步骤，
CI 上不过即失败。