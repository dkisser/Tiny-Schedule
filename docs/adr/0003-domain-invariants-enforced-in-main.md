# 领域不变量一律由主进程强制

ADR-0002 为"完成任务即结束计时"确立过先例：领域规则必须写在落盘的那一层，而不是某个 UI 入口。本 ADR 把这一先例泛化为全仓库的结构判据：**每个聚合的不变量在主进程侧有唯一强制点；渲染进程只做展示与乐观预览，不持有任何写路径的决策权。**

## 背景：泛化之前的错位

规则落点与聚合复杂度是错配的。生命周期最丰富的聚合——想法——其全部转移规则只在渲染进程的 `lib/ideas.ts`：终态规则（converted/closed 不可重开、closed 必须带 verdict、reopen 仅限 done/discarded）在主进程零强制，`ideaUpsert`/`followUpUpsert` 是无条件覆盖写。"升级为项目"由渲染进程编排两次独立 IPC（先 `project:create` 再 `idea:upsert`），中途崩溃留下孤儿项目。`finishDay` 的到期日滚动内联在 `ipcHandlers.ts` 的适配层。计时停止路径上，主进程盲信渲染进程算好的结算值——ADR-0002 的权威只覆盖完成路径。同时 `ipcHandlers.ts` 已膨胀为融合 IPC 适配、应用服务与内联领域规则的六百余行单文件。

## 决定

**shared 内部分两层。** `domain/` 按聚合组织：每个文件装该聚合的模型、zod schema 与全部规则（task / idea / followUp / project / appData），想法与跟进的转移规则自渲染进程迁入。`contract/` 装 wire 定义：通道常量、请求/响应信封、`IpcInvokeContract`、`RendererApi`、`maskDataForRenderer`。实体 schema 随模型入 domain——domain 拥有"事物是什么"，contract 只拥有"怎么说话"。

**main 内部分三层。** `services/` 按聚合承担 load → 领域函数 → persist，是不变量的唯一强制点；`handlers/` 按聚合拆分，只做 zod 校验与调用 service；`infra/` 收编 dataStore、migrations、importer、exporter、updater 等机制。AI 子系统同样遵守：agent 循环与会话持久化进 `services/chatService`，供应商与网络 plumbing 进 `infra/ai/`，且 tools 的读也走 services——未来给 agent 加写工具时，结构上不存在绕过守卫的调法。

**想法的写契约改为意图命令集**：`ideaComplete` / `ideaDiscard` / `ideaReopen` / `ideaConvertToTask` / `ideaUpgradeToProject` / `ideaCloseWithVerdict`；`ideaUpsert` 仅保留非状态字段的编辑。`ideaUpgradeToProject` 作为单命令在 service 内一次 `store.update`（建项目 + 转状态），原子性由此而来。任务与跟进保持 upsert + 守卫：任务的不变量已被 ADR-0002 覆盖，跟进的状态机足够简单。

**计时停止收口。** 新增 `timingStop` 命令，主进程自己跑 `settleTimer` 结算，与 quit/auto-pause 路径对称；渲染进程保留乐观预览，不承诺具体时长（沿用 ADR-0002 的原则）。

**错误形态。** 领域拒绝（如对已闭环的想法执行 reopen）返回 `{ ok: false, error }` 判别联合（沿用既有契约惯例）；系统错误继续 throw。

## Considered Options

- **想法继续用 `ideaUpsert` + 守卫校验转移合法性**：被否决。守卫挡得住非法写入，但契约上"任何形状的想法都能 upsert"依旧成立，读契约的人仍要自己推断哪些转移合法；命令集让终态规则从"需要被校验"变成"契约里根本不存在这个操作"，且契约直接说 CONTEXT.md 的领域语言。
- **wire 层命名 `ipc/` 或 `ports/`**：被否决。`ipc/` 只描述传输方式，且该层还装着渲染进程的 API 类型；`ports/`（六边形架构）语义精确，但为单个目录引入架构黑话不值。`contract/` 与代码里既有的 `IpcInvokeContract` 同名对齐，也是 Design by Contract 以来的标准术语。
- **计时停止维持渲染进程结算**：被否决。主进程在 quit/auto-pause 路径本就自己结算，停止路径不应成为权威的例外；渲染进程改为乐观预览后，UI 即时性不受损。
- **拆包（shared 拆成 domain / contract 两个包）**：被否决。包边界（app/shared 两分）是健康的，问题从来不在包边界而在规则落点；拆包只增加构建与引用成本，换不来新的强制力——分层是约定问题，不是物理隔离问题。
- **顺手把 `AppData.misc` 类型化**：被否决（推迟）。它与分层无关，混入只会稀释 diff；记录为后续独立小修。

## Consequences

- 渲染进程的写侧领域逻辑（`lib/ideas.ts` 的转移函数等）全部移除，`lib/` 只剩读侧 selector，stores 变薄。此后"X 的规则在哪"有唯一答案。
- AI agent 当前的三个工具全部只读，本决定不立刻改变其行为，但封死了未来写工具绕过规则的可能；导入路径同样收口到 services，合并语义不变（ideas/followUps 保留本地）。
- "待结论"维持派生态不落库——它由"incubating + 无 verdict + 关联项目已归档"现场计算，本就不存在原子性问题；请勿把它"修"成落库状态。
- 实施分三步，每步保持 `bun test` 绿：① shared 按聚合重排 + 想法/跟进规则迁入（纯移动，行为不变）；② main 拆分 + 命令集 + `timingStop`；③ renderer 写侧删除，UI 改调新命令。
