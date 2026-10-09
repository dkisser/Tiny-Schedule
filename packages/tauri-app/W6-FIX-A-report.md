# W6-Fix-A — TS 侧 Critical/High 修复报告

Worker `term_98d8bdf8`，task `task_d9247f4e3b1d`。基线 `cfdf49b`。

## 结论

11 项全部落地，cherry-markdown 懒加载也做了（brief 允许"改动小就做"）。
lint / typecheck / bun test（tauri-app 232 + shared 130）全绿。

关键验证：**三个 Critical 的测试都做了变异测试**——逐个撤销修复后确认对应测试转红，
所以它们能证伪，不是恒真断言。

| # | 发现 | 状态 | 证据 |
|---|---|---|---|
| C1 | 睡眠计费回归 | 修 | 5 个测试；变异后 5 红 |
| C2 | `load()` 丢缓存 | 修 | 2 个测试；变异后 1 红 |
| C3 | `update` 并发丢写 | 修 | 4 个测试；变异后 3 红 |
| C4 | StrictMode 双倍订阅 | 修 | `restore` 返回 teardown，App effect 带取消守卫 |
| C5 | `minify:false` | 修 | 10,180 kB → 6,614 kB；懒加载后首屏 chunk 1,201 kB |
| H1 | `.key` 权限 | 修 | 断言 mode 而非 flag；含 0644→0600 修复路径 |
| H2 | 退出结算双写 | 修 | `settleActiveTimer` 单写；变异后 1 红 |
| H3 | `focusAccumulatedMs` | 修 | 3 个 schema 往返测试 |
| R3-H1 | `startupUpdateCheck` 无生产者 | 修 | bootstrap 接线，5s 延迟对齐原版 |
| R3-M3 | 4 个 handler 丢 zod 守卫 | 修 | `exportMarkdown` 等 4 处 |
| 测试硬化 | systemEvents / sseFetch | 修 | 新增 wiring 测试 13 例；fake IPC 记录 body |

---

## Critical

### C1 — 睡眠被全额计费（R1-C1）

睡眠只在**唤醒后**才被观察到，pause 点落在唤醒时刻 → 合盖 8 小时记 8 小时工时。

修法：`suspendBackdateMs()` 把观测到的整个 gap 作为 backdate 传给 `autoPauseTimer`，
pause 点钉在**最后一次采样**。`autoPauseTimer` 原有 `Math.max(t.startedAt, now - backdateMs)`
钳制，因此 gap 超过已计工时时自然收敛到 0，不会负数。

`shared/timer.ts` 的 `backdateMs` 参数**本来就存在**（idle 路径一直在用），无需新增回算支持——
brief 里"若参数不存在"的授权没用上。

顺带把 `applyAutoPause` 的 `now` 变成可注入：watcher 必须把它测到的 gap 和它减去 gap 的那个
instant 配对，否则 pause 点落在 watcher 从没观测过的地方。

**证据**（`systemEventsLogic.test.ts` + `systemEventsWiring.test.ts`）：
- 合盖 8 小时、之前工作 90s → `accumulatedMs === 90_000`
- 对照组：同样的输入走 backdate=0 → 记 8h+90s
- 睡眠 10 分钟 / 工作 20 分钟 → 只记 20 分钟
- 一周 absurd gap → 钳到 0，不为负
- 普通迟到 tick（poll+2s）→ 不暂停

**变异**：把 `suspendBackdateMs` 改成 `return 0` → 5 个测试红。

### C2 — `load()` 丢缓存（R1-C2）

恢复 `this.cache = primary ?? backup ?? empty`。原注释说"cache 只影响性能"是错的：
`bootstrap.ts:49` 的迁移用**引用相等**判断 no-op，cache 空则每次 `get()` 返回新对象，
比较恒不等 → 每次启动都 save → 而 save 第一步是把 `data.json` 复制成 backup，
于是**截断的主文件覆盖掉唯一的好备份**，救援反过来摧毁数据。

**证据**：`load() populates the cache, so a rescued dataset survives startup` 断言
「迁移返回同一引用 → 不 save → 备份仍是完好那份、主文件仍是那份损坏的」。
变异（去掉 cache 赋值）→ 该测试红。

另有一个测试钉住后续正常 save 的落库顺序：恢复出的数据写进主文件后，下一次 save 的
backup 取自这份完好的主文件。

### C3 — `update` 无串行化（R1-C3 ≈ R3-H2）

原版 `update` 全同步；新版 4 个 await 之间可被插入。真实触发路径：`settingsUpdate`
回调内含 `await encryptKey`（WebCrypto），30s 心跳 `timerSync` 必然有机会重叠，
后写的用陈旧快照抹掉前者（实测丢 `aiPrompt`）。

修法：promise 链 `writeChain`，`update` 与 `save` 共用一条（迁移直接调 `save`，
不排队会插进 update 中间）。链上吞 rejection，避免一次坏写把后续全堵死。

**证据**：`DataStore concurrency` 4 例，用带延时的 `SlowFs` 制造真实的让出窗口：
- 模拟 `settingsUpdate` + `timerSync` 重叠 → 两项都落盘
- 12 个并发 update → 13 次写盘，无丢失
- 一个失败的 update 不污染后续
- 直接 `save` 排在在飞的 update 之后

**变异**：撤掉 `enqueue` → 3 个测试红。

---

## High

### H2 — 退出结算双写（R1-H）

退出结算走 `stop()` = `settleInto`（taskUpsert）+ `sync(null)`（timerSync），两次独立写。
两次之间崩溃留下「任务已结算 + activeTimer 仍指向它」，恢复路径无法分辨，
猜错就重复计费——这正是 ADR-0002 明令否决的形态。

修法：新增 `shared/timer.ts` 的 `settleActiveTimer(data, timer, now)` 纯函数，
一次转换同时移动任务与计时器，`settleRunningTimer` 单次 `store.update` 落盘。
与原版 `settleActiveTimer` 同形（原版也是主进程直接调 `dataStore.update`，
不是 IPC handler，所以没有契约通道可走——`startSystemEvents` 因此接收 store）。

渲染层拿到的数据集经 `maskDataForRenderer` 掩码，与其他写路径一致。

**证据**：`quit settlement` 5 例，其中 `moves the settled task and the cleared timer in one write`
用 `CountingFs` 直接数落盘次数 = 1。另测已完成任务不重复计费、取消确认不结算不退出、
无计时器直接退出、掩码后密文仍在磁盘。
**变异**：改回双写 → 该测试红。

### H3 — `focusAccumulatedMs` 被剥掉（R1-H）

`ActiveTimerSchema` 缺该字段，zod `z.object` 默认 strip 未声明键 → 每次 save 静默丢弃，
番茄钟结算退化成只算当前一段；`migrateActiveTimerPomodoroFocus` 成了死代码。

按 brief 授权给 schema 补字段（optional，不带 default：legacy 数据必须是"未知"而非 0，
因为 `computeFocusElapsed` 读 `?? 0`，存 0 与真实的 0 不可区分）。

**证据**：`ipcSchemas.test.ts` 3 例——`AppDataSchema` 往返保留字段、legacy 保持 absent、
迁移产物（0）不再被剥。

### H1 — `.key` 权限回归（R2-H1 ≈ R1-H）

`writePrivate` 的两条前提都被实测证伪：`writeFile` **支持** `WriteFileOptions.mode`
（并传到 std `OpenOptions::mode`）；父目录并非 0700，是 `mkdir` 默认 0777 & umask → 0755。

修法：`writePrivate` 显式 `mode: 0o600`，`mkdir` 显式 `mode: 0o700`。
`mode` 是 `O_CREAT` mode，只在创建时生效，因此 `initKeyStore` 增加修复路径：
读出旧 key → 写 0600 的 `.key.tmp` → rename 覆盖（POSIX rename 带走源 inode 的 mode）。
**不用 delete-then-write**——两次调用之间的任何中断都会永久丢失密钥，
而密钥丢了意味着 `data.json` 里所有 `apiKeyEncrypted` 永久不可解。

测试硬化：原 `keys.test.ts:20` 的 `expect(fs.isPrivate(...)).toBe(true)` 是恒真的——
`MemoryFs.writePrivate` 无条件打标记，与生产代码要什么 mode 无关。改为
`MemoryFs` 建模真实 mode（`writeText`→0644、`writePrivate`→0600、rename 带走源 mode），
断言 `modeOf(path) === 0o600`，并加一个**对照组**（`writeText` 后断言不是 0600）
确保断言仍能证伪。base64 编码标记与权限标记拆开——二者曾共用一个 flag，
导致"合法但宽松"的 key 读不出来。

**证据**：4 个新测试——首启 0600、对照组可证伪、0644→0600 修复、修复过程 key 路径从不为空。

### R3-H1 — `startupUpdateCheck` 无生产者

`ui:updateAvailable` 唯一的生产者是 `startupUpdateCheck`，全仓库 0 个调用点，
`App.tsx:137` 的订阅永久静默，用户不再在启动时收到更新提示。

修法：bootstrap 里 `installApi` 之后接线，5s `setTimeout` 对齐原版
（`did-finish-load` + `setTimeout(..., 5000)`），用 `getVersion()` 取版本。
`bootstrap.ts` 已说明"原版把这个定时器锚在 `did-finish-load` 上"，
所以延迟的**理由**已经被记录，只是接线漏了——补上即与注释一致。

### R3-M3 — 4 个 handler 丢 zod 守卫

`exportMarkdown` / `appOpenExternal` / `calendarAddTask` / `setAlwaysOnTopWindow`
补 `req.parse`。其中 `exportMarkdown` 最实际：非法 `mode` 不再静默降级成 worklog。

---

## 测试硬化

**`systemEvents.ts`（原 221 行零测试）** → 新增 `systemEventsWiring.test.ts` 13 例，
覆盖退出流（单写/done 任务/取消/无计时器/掩码）、空闲判定（回算数值、阈值、opt-out、
NaN 负数、钳制）、睡眠 watcher（整夜不计时、迟到 tick、连续短 gap）。
为可测性把采样逻辑拆成 `createSleepSampler(now?)`——唯一有意思的情况是
`Date.now()` 的跳变，真等 8 小时测不出来。

顺带把 `applyAutoPause` 读到的时刻改为可注入（见 C1），`useTimerStore.setState` 也用同一个 `now`，
避免暂停点与时钟显示差一次 `Date.now()`。

**`sseFetch.test.ts` 变异盲区** → fake IPC 的 `invoke` 原本只记 `cmd` 和 `requestId`，
body 完全不记录，所以 `sseFetch` 把 body 序列化成垃圾串 21 个测试仍全绿。
新增 `RecordedRequest` 记录 url/method/headers/body，并加 3 个断言真正跨过 IPC 边界的测试
（含 URLSearchParams 编码往返、中文、header 小写化）。

---

## 未修复 / 后续项

1. **`stop()`（UI 停止按钮）仍是双写**：`settleInto` + `sync(null)`。它经 `api()` 到达 store，
   而契约里没有对应通道；要单写需要新增第 36 个 invoke 通道，超出本 brief 的范围。
   退出路径已单写（走 store），`stop()` 仍暴露同样的窗口。**建议后续处理。**
2. **R1-M2（Dock 退出按挂钟计满离线时长）**：`restore` 不处理"恢复时已离线很久"。
   brief 未列入本次范围，未动。parity 文档 158-161 行的错误论证需要更正，
   但 `docs/` 不在本 worker 的所有权内。
3. **已有 `.key` 的目录 mode**：代码只在 `mkdir` 时给 0700，已存在的 0755 目录不会被改
   （plugin-fs 无 chmod）。`.key` 文件本身已通过 tmp+rename 修复为 0600，
   目录需要一次性 Rust 命令或提示，属 R2 建议的一次性迁移。
4. **capability 未覆盖 `*.bak.*` 目录**（R1-M3）：属 `src-tauri/`，另一 worker 地盘。
5. **Rust 侧 `startupUpdateCheck` 无需改动**：生产者是 TS 侧的 `updater.ts`，Rust 不参与。
6. **`onTimerChanged` 的 Rust 通道仍无 emit**（R3-M1）：死订阅，文档失实，非功能回归；
   属 parity 文档更正范畴。

---

## 文件清单

**packages/shared（仅两处授权点 + 测试）**
- `src/timer.ts` — `settleActiveTimer()` 新增；`autoPauseTimer` 钳制语义补注释
- `src/ipc.ts` — `ActiveTimerSchema` 补 `focusAccumulatedMs`
- `tests/timer.test.ts` +8 例、`tests/ipcSchemas.test.ts` +3 例

**packages/tauri-app/src**
- `bridge/systemEventsLogic.ts` — `suspendBackdateMs()`
- `bridge/systemEvents.ts` — 回算接线；`createSleepSampler` 拆分；退出结算改单写
  + 掩码；`applyAutoPause` 收 `now`；`startSystemEvents(store)`
- `bridge/dataStore.ts` — `load()` 填 cache；`update`/`save` 共用 promise 链
- `bridge/tauriFs.ts` — `writePrivate` 0600、`mkdir` 0700
- `bridge/keys.ts` — tmp+rename 权限修复路径
- `bridge/fsAdapter.ts` — `MemoryFs` 建模 mode（`PRIVATE_MODE`/`PRIVATE_DIR_MODE`）
- `bridge/bootstrap.ts` — 启动更新检查接线
- `api/files.ts` / `api/system.ts` / `api/window.ts` — 4 处 zod 守卫
- `stores/timer.ts` — `restore` 返回 teardown
- `App.tsx` — effect 取消守卫 + teardown
- `components/LazyMarkdownEditor.tsx`（新）+ `TaskDetail`/`FollowUpDetail`/`IdeaDetail` 换用
- 测试：`systemEvents.test.ts` +7、`systemEventsWiring.test.ts`（新，13 例）、
  `dataStore.test.ts` +6、`keys.test.ts` +3、`sseFetch.test.ts` +3

**packages/tauri-app**
- `vite.config.ts` — 去掉 `minify: false`

## 体积实测

| | entry JS | gzip | CSS |
|---|---|---|---|
| 基线（`minify:false`） | 10,180 kB | 2,317 kB | 331 kB |
| 仅开 minify | 6,614 kB | 1,941 kB | 313 kB |
| + cherry-markdown 懒加载 | **1,201 kB** | **362 kB** | 69 kB |

cherry-markdown 单独成 chunk（5,398 kB / 1,576 kB gzip），只在用户点"编辑"时加载。
首屏解析量比基线降约 84%。`ui-probe.tsx` 保留直接 import——它需要编辑器同步就绪。

## 变异测试记录

| 撤销的修复 | 转红的测试 |
|---|---|
| `suspendBackdateMs` → `return 0` | logic 5 红 / wiring sleep 1 红 |
| `load()` 去掉 cache 赋值 | dataStore 1 红 |
| `update` 去掉 `enqueue` | dataStore 3 红 |
| 退出结算改回双写 | wiring 1 红 |
