import {
  type AppData,
  type FinishedScheduledTaskRun,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskUpsertReq,
} from '@tiny-schedule/shared';
import { type AiLogger } from '../ai/logger';
import { type DataStore } from './dataStore';

/**
 * 定时任务的写侧入口，形状仿 followUpService（那是最接近的先例：一个普通属性的
 * CRUD + 一条命令通道），但没有跟进的 resolve/reopen。
 *
 * 运行记录只有两个写入口：**appendRun**（开始时落一条 running）与 **finalizeRun**
 * （结束时把它改写为终态）。ADR-0008 说审计记录能改写就不再是追溯手段，所以可写的
 * 方向只有 running → 终态这一个——终态记录再写一次是幂等的空操作，不是覆盖。
 * 第三个入口 {@link reconcileScheduledTaskRuns} 是启动对账，把上次进程死在运行途中
 * 留下的 running 记成 interrupted（详见那里的说明）。
 */

/**
 * 对账写下的说明。界面上它就是那条运行的 `error`，所以写的是用户能读懂的话，而不是
 * 一个内部错误码——被中断的运行本来就该让人知道"这次没跑完"以及为什么。
 */
const INTERRUPTED_REASON = '进程在运行中结束：应用退出或崩溃，这次运行没有跑到终态。';

/** What this service needs to do its work: the store, and somewhere to log. */
export interface ScheduledTaskServiceDeps {
  store: DataStore;
  logger: AiLogger;
}

/**
 * upsert 可写的字段。createdAt/updatedAt 不在其中：它们由这里维护，
 * 渲染进程回写渲染时的快照不该把创建时刻或一次并发执行的更新时刻改掉。
 */
const EDITABLE_FIELDS = ['name', 'prompt', 'schedule', 'workingDirectory', 'enabled'] as const;

export function createScheduledTaskService({ store, logger }: ScheduledTaskServiceDeps) {
  /**
   * 字段编辑是**合并**，不是整条覆盖。
   *
   * 与 followUp 的 merge 同理：渲染进程持有的是渲染时的快照，整条覆盖会让一次
   * 去抖提交把别的窗口刚刚写下的 enabled 回滚掉。
   */
  const upsert = async (req: ScheduledTaskUpsertReq, now = Date.now()): Promise<AppData> => {
    const { data: next } = await store.update((d) => {
      const stored = d.scheduledTasks[req.id];
      const changes: Record<string, unknown> = {};
      let clearedWorkingDirectory = false;
      for (const key of EDITABLE_FIELDS) {
        const value = (req as Record<string, unknown>)[key];
        if (value === undefined) continue; // "leave this alone"
        // Only workingDirectory is nullable. `null` means "clear" and the key is
        // dropped below rather than written as null — the domain type has no null.
        if (value === null) {
          if (key === 'workingDirectory') clearedWorkingDirectory = true;
          continue;
        }
        changes[key] = value;
      }
      // A new scheduled task is enabled by definition: a rule that silently
      // never fires, with no way for the user to tell why, is worse than a
      // visible default. See blankScheduledTask.
      let merged = (
        stored
          ? { ...stored, ...changes, id: req.id }
          : {
              ...changes,
              id: req.id,
              enabled: changes.enabled ?? true,
              createdAt: now,
            }
      ) as ScheduledTask;
      // updatedAt moves on every accepted write, and on a create it equals
      // createdAt. It is stamped after the merge rather than inside it because
      // `changes` must not be able to set it: an edit that carries its
      // render-time snapshot would otherwise freeze the field at the moment the
      // form first mounted, which is the one reading nobody wants.
      merged = { ...merged, updatedAt: now };
      if (clearedWorkingDirectory) {
        const rest: Record<string, unknown> = { ...merged };
        delete rest.workingDirectory;
        merged = rest as unknown as ScheduledTask;
      }
      return { ...d, scheduledTasks: { ...d.scheduledTasks, [req.id]: merged } };
    });
    logger.info({
      action: 'scheduledTask:upsert',
      scheduledTaskId: req.id,
      name: req.name,
      enabled: next.scheduledTasks[req.id]?.enabled,
    });
    return next;
  };

  /**
   * 删除定时任务连同它的全部运行（CONTEXT.md）。
   *
   * Cascade 与删除在同一次写入里：分两次写的话，一次被拒绝的写入会留下孤儿运行
   * ——审计记录指向一个已经不存在的定时任务，读者无从判断它是什么时候、
   * 为谁跑的。
   */
  const remove = async (id: string): Promise<AppData> => {
    const { data: next } = await store.update((d) => {
      if (!d.scheduledTasks[id]) return d;
      const scheduledTasks = { ...d.scheduledTasks };
      delete scheduledTasks[id];
      const runs = Object.fromEntries(
        Object.entries(d.runs).filter(([, run]) => run.scheduledTaskId !== id),
      );
      return { ...d, scheduledTasks, runs };
    });
    logger.info({ action: 'scheduledTask:delete', scheduledTaskId: id });
    return next;
  };

  /**
   * 追加一条运行。
   *
   * 拒绝挂到不存在的定时任务名下：这在正常路径上不可能发生（删除会级联删运行），
   * 所以真发生了说明写入顺序出了问题。与其留一条指向空目标的审计记录，不如什么
   * 都不写——那条记录会让"这个定时任务到底执行过什么"永远没有答案。
   */
  const appendRun = async (run: ScheduledTaskRun): Promise<AppData> => {
    const { data: next } = await store.update((d) => {
      if (!d.scheduledTasks[run.scheduledTaskId]) return d;
      return { ...d, runs: { ...d.runs, [run.id]: run } };
    });
    const stored = next.runs[run.id];
    if (!stored) {
      logger.info({
        action: 'scheduledTask:runRejected',
        runId: run.id,
        scheduledTaskId: run.scheduledTaskId,
        error: 'SCHEDULED_TASK_NOT_FOUND',
      });
      return next;
    }
    logger.info({
      action: 'scheduledTask:runAdd',
      runId: run.id,
      scheduledTaskId: run.scheduledTaskId,
      trigger: run.trigger,
      status: run.status,
      toolCalls: run.toolCalls.length,
    });
    return next;
  };

  /**
   * 终结一条运行：把开始时落下的 running 记录改写为终态。
   *
   * 这是运行记录唯一一次可写的地方，方向也只有这一个：**running → 终态**。已经落下
   * 终态的记录再被 finalize 一次是空操作（幂等），不是覆盖——否则一次重复的收尾就
   * 能把审计改写成另一个样子。
   *
   * 记录不存在时按"补写终态"处理：开始那一次写失败的情况下，此刻手上这条终态记录
   * 是这次执行仅剩的痕迹，丢掉它比多一条更糟。挂到不存在的定时任务名下则与
   * {@link appendRun} 同样拒绝，理由也一样。
   */
  const finalizeRun = async (run: FinishedScheduledTaskRun): Promise<AppData> => {
    const { data: next } = await store.update((d) => {
      if (!d.scheduledTasks[run.scheduledTaskId]) return d;
      const stored = d.runs[run.id];
      if (stored && stored.status !== 'running') return d;
      return { ...d, runs: { ...d.runs, [run.id]: run } };
    });
    const stored = next.runs[run.id];
    if (!stored) {
      logger.info({
        action: 'scheduledTask:runRejected',
        runId: run.id,
        scheduledTaskId: run.scheduledTaskId,
        error: 'SCHEDULED_TASK_NOT_FOUND',
      });
      return next;
    }
    if (stored.status !== run.status) {
      // 终态不可改写，所以这里只可能是"这条已经结束了"。
      logger.info({
        action: 'scheduledTask:runFinalizeIgnored',
        runId: run.id,
        scheduledTaskId: run.scheduledTaskId,
        storedStatus: stored.status,
      });
      return next;
    }
    logger.info({
      action: 'scheduledTask:runFinish',
      runId: run.id,
      scheduledTaskId: run.scheduledTaskId,
      status: run.status,
      toolCalls: run.toolCalls.length,
    });
    return next;
  };

  /**
   * 启动对账：把 data.json 里残留的 running 一律记为 interrupted（CONTEXT.md）。
   *
   * 先例是 `stores/timer.ts` 的 isOfflineResume：跨进程活不下去的东西回到界面上时，
   * 必须先被改成它真实的样子——那里的计时是 backdate 成 paused，这里的运行是记成已
   * 中断。不做这一步，界面会永远显示一个"运行中"的标记，而那个进程早已不在。
   *
   * 三个性质让它敢在每次启动时跑：
   *  - **只扫 running**：终态记录一条都不碰，对账不会去改写任何已经落定的历史。
   *  - **幂等**：没有 running 时返回同一份数据，`store.update` 因此不写盘；连续两次
   *    调用结果相同（热重载、未来的重新初始化都会走到这里）。
   *  - **finishedAt 取对账时刻**：那是应用确实知道"这条不会再动了"的最早时刻，而不是
   *    startedAt——后者会把一段没有发生过的执行时长算进历史。
   */
  const reconcileInterruptedRuns = async (now = Date.now()): Promise<AppData> => {
    // 读一次只为短路：没有 running 就原样返回，`store.update` 连一次写盘都不会发生。
    // 真正的判据仍在下面的 updater 里（按它读到的数据重算），所以即使有第二个调用
    // 与它交错，第二个看到的也只会是没有 running 的数据。
    const current = await store.get();
    const strandedIds = Object.values(current.runs)
      .filter((run) => run.status === 'running')
      .map((run) => run.id);
    if (strandedIds.length === 0) return current;

    const { data: next } = await store.update((d) => {
      const runs = { ...d.runs };
      let converted = 0;
      for (const [id, run] of Object.entries(d.runs)) {
        if (run.status !== 'running') continue;
        runs[id] = {
          ...run,
          status: 'interrupted',
          finishedAt: now,
          output: run.output ?? '',
          error: INTERRUPTED_REASON,
        };
        converted += 1;
      }
      return converted === 0 ? d : { ...d, runs };
    });
    logger.info({ action: 'scheduledTask:reconcile', interrupted: strandedIds.length });
    return next;
  };

  return {
    upsert,
    remove,
    appendRun,
    finalizeRun,
    reconcileInterruptedRuns,
    /** 按任务取运行，最新的在前。没有对应的 delete——只有 running 会被改写。 */
    async listRuns(scheduledTaskId: string): Promise<ScheduledTaskRun[]> {
      const { runs } = await store.get();
      return Object.values(runs)
        .filter((run) => run.scheduledTaskId === scheduledTaskId)
        .sort((a, b) => b.startedAt - a.startedAt);
    },
  };
}

/**
 * 启动对账的接线点：数据一打开就收拾上次进程留下的 running 运行。
 *
 * 单独一个函数而不是让调用方自己组装 service，是为了把"什么时候对账"钉在启动序列的
 * 那个位置上（见 bootstrap.ts）。幂等，所以重复调用无害。
 */
export async function reconcileScheduledTaskRuns(
  store: DataStore,
  logger: AiLogger,
): Promise<AppData> {
  return createScheduledTaskService({ store, logger }).reconcileInterruptedRuns();
}

export type ScheduledTaskService = ReturnType<typeof createScheduledTaskService>;
