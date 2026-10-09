# 被拒绝的写入是一种结果，不是一种缺席

ADR-0003 确立了"领域不变量在主进程强制"。本 ADR 处理它没覆盖到的一面：**当强制点自己拒绝执行时，这个事实必须沿着调用链一路传到用户眼前。**

## 背景：一个事实，四种说法

`DataStore` 在 `data.json` 不可解析时会拒绝写入，以免用降级缓存覆盖用户唯一的好副本。这个守卫自 PR #7 起就在，但它当时是**静默**的：`update()` 返回降级数据集，不带任何标记。后果是每个写路径都把被丢弃的写入读成成功——`stopTiming` 返回 `ok: true` 并附一个只存在于该返回值里的结算，用户看着工时记录成功，重启即消失。

PR #18 给 `update()` 加了 `persisted: boolean`，但**没有**统一表达。结果 `WRITE_REFUSED` 只存在于 `TimingStopResult` 上，其余写通道（`taskDelete`、`ideaUpsert`、`followUpResolve`、`projectUpdate`、`orderSet`…）仍返回裸 `AppData`；渲染进程只有三处各自写了 `toast.error`；`TimerPort` 与 `taskService.syncTimer` 的返回形状不一致，导致自动暂停被拒时发出的 payload 与真实丢弃逐字节相同——一个"修复"了的分支，在线上协议里不存在任何区别。

三轮 code review 反复在这几处发现新问题，不是巧合：**每加一条通道就得补一次判断，而"忘了补"是默认结果。** 这类缺陷的成因是缺少抽象，不是缺少小心。

## 决定

**写通道统一返回 `WriteOutcome`。** 定义在 `contract` 层，与 ADR-0003 的"contract 只拥有怎么说话"一致：

```ts
interface WriteOutcome {
  data: AppData;        // 主进程认定的真相，可能是降级的
  persisted: boolean;   // 是否落盘
  error?: WriteError;   // 结构化原因，取代散落的 error 字符串
}
```

`DataStore.update()` 的 `WriteResult` 是它的进程内对应物；`IpcInvokeContract` 里所有写通道的 `res` 改为 `WriteOutcome`。领域拒绝仍走既有的 `{ ok: false, error }` 判别联合——那是**领域**结论，与**存储**结论是两件事，`persisted` 与之正交（ADR-0003 的判别联合在 `TASK_ALREADY_DONE` 上携带 `persisted` 就是这个关系）。

**降级数据集默认不被采纳。** 渲染进程在 `persisted: false` 时保持既有状态，只呈现提示。把主进程自己都读不出来的数据集显示成正常数据，比不显示更糟：data.json 损坏且无备份时，用户改一个标题会让整个任务库从屏幕上消失。读通道（`dataLoad`）维持现状——那时用户没有更好的选择，采纳降级数据集好过一个空界面。

**拒绝是一个可辨识的 payload，不是 `null`。** `Ipc.timerChanged` 的载荷改为判别联合，区分"计时器被丢弃"与"这次写入被拒"。二者对渲染进程意味着完全不同的动作（前者清空并停止，后者清空**并告知用户**），用同一个 `null` 表示会让其中一种永远静默。

## Considered Options

- **继续逐通道加 `persisted`**：被否决。这正是当前状态，三轮 review 已经证明它不收敛——每条新通道都要记得判断，而漏一次就是用户被骗。
- **让 `DataStore.update()` 直接 throw**：被否决。数据不可读是运行期的持久状态，不是异常；throw 会让每个写路径都要 try/catch，而 catch 块里仍然要判断"是不是这个错误"，只是换了个地方漏。
- **降级数据集照常采纳，只加 toast**：被否决（PR #18 的做法）。data.json 损坏且无备份时，这会让整个库从 UI 消失，而提示语说的是"保存失败"——用户不会把两者联系起来。提示掩盖不了它掩盖掉的那个破坏。
- **引入独立的"只读模式" UI 状态**：暂不采纳。需要一个能表达"整个应用降级运行"的概念，这比一条 toast 大得多；先让拒绝可见、可报告，真需要时再引入。
- **`timerChanged` 继续用 `ActiveTimer | null`**：被否决。载荷无法区分两种对渲染进程影响相反的状态。

## Consequences

- 所有写 handler 统一形状，新增通道没有"要不要判断 persisted"这个自由度了——这是本决定的主要收益。
- 渲染进程的三处手写 toast 收敛到一处。
- `Ipc.timerChanged` 的线格式变更，preload 与渲染进程同步改动；这是本决定里唯一破坏兼容的部分，独立成一个 PR 以便回滚。
- `countRecords`（备份轮转守卫）仍漏 `misc.chatSessions`，且是"记录数"这个代理指标——分不清用户主动删除与数据丢失。**本 ADR 不解决它**：它属于备份保留策略（代际保留 vs 内容比较），是独立决定。
