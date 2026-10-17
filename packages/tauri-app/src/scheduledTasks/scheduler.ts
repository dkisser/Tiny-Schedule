import type { ScheduledTask } from '@tiny-schedule/shared';
import { type AiLogger, silentLogger } from '@/ai/logger';
import type { DataStore } from '@/bridge/dataStore';
import { createScheduledRuntime, type ScheduledRuntimeDeps, taskInFlight } from './runtime';
import { nextTriggerAt } from './schedule';

/**
 * 定时任务的调度器：到点触发，以及"前一次没跑完就跳过"这条领域规则。
 *
 * 两条设计上的取舍都来自 CONTEXT.md，不是实现细节：
 *
 *  - **不补跑。** 进程没在跑的时候错过的触发，回来之后不回看。`refresh()` 只从
 *    "现在"往后算下一次，所以关机三天的定时任务醒来不会连跑三次。补跑看起来更
 *    贴心，但一次 unattended 的运行拿着全部工具权限，连跑三次就是三次没人看的
 *    执行。
 *  - **不持久化定时器状态。** 重启后整个调度表从 schedule 重算。少一样要同步的
 *    东西，也就少一类"磁盘上的下次触发时间与应用看到的 schedule 对不上"的 bug。
 *
 * 频率求值在 {@link nextTriggerAt} 所在的 `./schedule`，刻意与本文件分开：那里
 * 不 import 任何宿主模块，所以界面侧「下次触发」的推算可以与它在同一个测试里
 * 比对——两份实现必须给出同一个答案。
 */

export { nextTriggerAt } from './schedule';

/** 与"30s 对齐 tick"配套的周期；也是唤醒粒度下界。 */
const DEFAULT_TICK_MS = 30_000;

export type RunTriggerName = 'scheduled' | 'manual';

/** 到下一次边界的毫秒数，让 tick 落在整 30 秒上而不是"启动后第 30 秒"。 */
function msToNextBoundary(now: number, tickMs: number): number {
  const remainder = now % tickMs;
  return remainder === 0 ? tickMs : tickMs - remainder;
}

interface SchedulerEntry {
  task: ScheduledTask;
  nextAt: number;
}

/**
 * A timer handle, opaque to this module.
 *
 * `ReturnType<typeof setInterval>` would pin the Node/DOM typing the bundler
 * happens to pick, and the whole point of injecting the timers is that a test
 * never touches a real one.
 */
export type TimerHandle = unknown;

export interface SchedulerDeps {
  /** 数据变更后由调用方 refresh()；这里只负责读。 */
  getTasks: () => ScheduledTask[] | Promise<ScheduledTask[]>;
  run: (task: ScheduledTask, trigger: RunTriggerName) => Promise<unknown>;
  recordSkipped: (task: ScheduledTask, trigger: RunTriggerName) => Promise<unknown>;
  logger?: AiLogger;
  now?: () => number;
  tickMs?: number;
  /** 测试注入点：默认是运行时的进程级账本，不另建一份。 */
  inFlight?: Set<string>;
  /** 注入定时器，测试里用假时钟驱动。 */
  timers?: {
    setInterval: (fn: () => void, ms: number) => TimerHandle;
    clearInterval: (handle: TimerHandle) => void;
  };
}

export function createScheduler(deps: SchedulerDeps) {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  // Wrapped rather than passed through: the ambient `setInterval` is overloaded
  // per environment, so handing its `clearInterval` an opaque handle is exactly
  // the mismatch this indirection exists to keep out of the scheduler.
  const timers = deps.timers ?? {
    setInterval: (fn: () => void, ms: number): TimerHandle => setInterval(fn, ms),
    clearInterval: (handle: TimerHandle): void => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };

  /** 调度表：id → 下一次触发。内存里的一份，随数据变化重建。 */
  const table = new Map<string, SchedulerEntry>();
  /**
   * 正在跑的定时任务；重叠保护的唯一真相来源。
   *
   * 取自 {@link taskInFlight} 而不是自己新建一个：手动「立即运行」也往同一本账里写，
   * 两份账本会在手动运行期间各答各的，`isRunning()` 恰好在用户盯着看的时候返回 false。
   */
  const inFlight = deps.inFlight ?? taskInFlight();
  /** 在途的运行，用于让测试等它落地，也用于 stop() 时不再派发。 */
  const running = new Set<Promise<unknown>>();
  let handle: TimerHandle = null;
  /**
   * 是否处于"已启动"状态。
   *
   * 不能用 `handle !== null` 代替：注入的假 setInterval 可能返回 null（测试里就是
   * 如此），而 stop() 之后 handle 也是 null——两种状态会无法区分，`tick` 就分不清
   * "该干活"和"该早退"。
   */
  let started = false;

  const build = (task: ScheduledTask, at0: number): SchedulerEntry => ({
    task,
    nextAt: nextTriggerAt(task.schedule, at0),
  });

  /**
   * 重建调度表。
   *
   * 每个任务的"下一次"都从**此刻**往后算，所以刷新不会补跑：一条 09:00 的每日
   * 任务在 11:00 被改过名字，刷新后下一次是明天 09:00，而不是今天已经过去的
   * 那一档。
   *
   * 停用时是空操作：`stop()` 清了表，而数据订阅会在任何一次写入后调到这里，
   * 不挡住就会把表原样填回去——于是"停了就是停了"并不成立，`peek()` 又开始
   * 报告一个已经停掉的调度器仍在管着这些任务。`start()` 走下面的 `rebuild`，
   * 因为那时 `started` 还没有置位。
   */
  const rebuild = async (): Promise<void> => {
    const at0 = now();
    const tasks = await deps.getTasks();
    const next = new Map<string, SchedulerEntry>();
    for (const task of tasks) next.set(task.id, build(task, at0));
    table.clear();
    for (const [id, entry] of next) table.set(id, entry);
    logger.info({ action: 'scheduler:refresh', tasks: next.size });
  };

  const refresh = async (): Promise<void> => {
    if (!started) return;
    await rebuild();
  };

  /** 到点后的重排：始终从"这一次 tick 的此刻"往后算下一次。 */
  const advance = (entry: SchedulerEntry, at0: number): void => {
    entry.nextAt = nextTriggerAt(entry.task.schedule, at0);
  };

  const dispatch = (entry: SchedulerEntry): void => {
    const { task } = entry;
    if (inFlight.has(task.id)) {
      // 前一次运行未结束时的新触发跳过，记一条 skipped（CONTEXT.md）。
      const pending = deps
        .recordSkipped(task, 'scheduled')
        .catch((error: unknown) => {
          logger.error({ action: 'scheduler:skipFailed', taskId: task.id, error });
        })
        .finally(() => running.delete(pending));
      running.add(pending);
      return;
    }
    inFlight.add(task.id);
    const pending = deps
      .run(task, 'scheduled')
      .catch((error: unknown) => {
        // 一次触发的失败不重试、不停用定时任务（CONTEXT.md），所以到这里只记
        // 日志——下一次触发照常发生。
        logger.error({ action: 'scheduler:runFailed', taskId: task.id, error });
      })
      .finally(() => {
        inFlight.delete(task.id);
        running.delete(pending);
      });
    running.add(pending);
  };

  /**
   * 一次检查。
   *
   * 不 await 运行本身：一次运行可能跑几分钟，而 tick 必须继续走，否则后面每一个
   * 到点的任务都要排队等它跑完——那正是"下一次触发被跳过"会蔓延到全表的原因。
   * `settled()` 让测试能等到落地。
   */
  const tick = async (): Promise<void> => {
    // 一个显式的运行标志，而不是 `handle !== null`：注入的假 setInterval 可能
    // 返回 null（测试里就是这样），于是"已启动"和"已停止"用 handle 区分不开。
    // 守卫原先写成 `handle === null && table.size === 0`，两个条件都要成立才
    // 早退，于是 stop() 只清 handle 不清表时，停用的调度器仍从一张本该拆掉的
    // 表里派发真实运行。
    if (!started) return;
    const at0 = now();
    const due = [...table.values()].filter((entry) => entry.nextAt <= at0);
    for (const entry of due) {
      // 先重排再执行：一次跑了很久的运行不会在结束时发现"还有 5 个到点的"，
      // 因为下一次触发已经指到未来了。
      advance(entry, at0);
      // 停用即不再触发：重排但不起跑。
      if (!entry.task.enabled) {
        logger.info({ action: 'scheduler:disabled', taskId: entry.task.id });
        continue;
      }
      dispatch(entry);
    }
  };

  /**
   * 对齐到下一个整周期再开始，之后按周期走。
   *
   * 先 refresh 再排第一个 tick：否则从启动到第一个 tick 之间创建的任务要等到下一
   * 轮才进表，而更糟的是这一轮里它本来可能该触发。
   */
  const start = async (): Promise<void> => {
    if (started) return;
    // 先排循环再置位？不行——那就有了"两个循环"的窗口。先 await refresh
    // 也同样不行：refresh 抛错时标志已是 true，之后每次 start 都是静默的
    // 空操作，循环再也排不上，而启动时 data.json 读不出来是会发生的。
    //
    // 所以用 try：成功才置位，失败原样抛出去并把标志留在 false，让调用方
    // （用户修好文件之后）重试就能起来。
    await rebuild();
    started = true;
    // 排到下一个整周期边界上，而不是"启动后 30 秒"：漂移会让所有任务的判定
    // 落在不同的秒数上，而一个 09:00:00 的任务被 09:00:07 判为到点并不是错，
    // 只是让"到点"这个词失去了它该有的含义。
    handle = timers.setInterval(() => void tick(), msToNextBoundary(now(), tickMs));
    // 对齐之后第一次 tick 是 tickMs 之后；这里不立刻补一次，因为 refresh 刚刚
    // 已经把每个任务的下一次算到了"此刻之后"——立刻 tick 只会读到全部未到期。
  };

  /**
   * 停掉循环并拆掉调度表。
   *
   * 清表不是为了省内存：`peek()` / `isRunning()` 是给界面与测试看的，而一张
   * 残留的表会让它们报告一个已经停掉的调度器仍在管着这些任务。
   *
   * 清表本身还不够：数据订阅会在任何一次写入后调 `refresh()`，而 `refresh`
   * 现在在停用时是空操作——守卫在那里，不在这里。否则这张表下一轮就被填回去。
   */
  const stop = (): void => {
    if (handle !== null) timers.clearInterval(handle);
    handle = null;
    started = false;
    table.clear();
  };

  return {
    start,
    stop,
    refresh,
    tick,
    isRunning: (taskId: string): boolean => inFlight.has(taskId),
    /** 排空在途运行，测试用。 */
    settled: async (): Promise<void> => {
      while (running.size > 0) await Promise.all([...running]);
    },
    /** 调度表快照，测试与调试用。 */
    peek: (): SchedulerEntry[] => [...table.values()],
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;

/**
 * 启动接线：把调度器接到真实的 store 与共享运行时上。
 *
 * 两条依赖都来自别处而不是在这里重建：`getTasks` 读 store，重叠保护走
 * {@link ScheduledRuntime.runGuarded}——与「立即运行」共用同一把 in-flight 锁。
 * 在这里另建一个 runner 就等于另建一把锁，而那正是这条规则失效的方式。
 *
 * 幂等：重复调用返回同一个调度器，第二次不排第二个循环。`bootstrap()` 在热重载
 * 与未来的重新初始化里都可能被调用两次，而两个循环会让每个到点的任务跑两遍。
 */
let startedScheduler: Scheduler | null = null;
/** 数据订阅；`_resetSchedulerForTest` 要一并退订，否则跨用例泄漏。 */
let schedulerUnsubscribe: (() => void) | null = null;

/**
 * 测试注入点：`startScheduler` 组装真实 runtime，测试需要一个可控的 Agent
 * 才能观察一次触发。没有这个参数，接线层就是零覆盖——而接线恰恰是坏掉的地方。
 */
export type StartSchedulerOverrides = Pick<ScheduledRuntimeDeps, 'runner' | 'invoke'>;

export async function startScheduler(
  store: DataStore,
  logger?: AiLogger,
  overrides?: StartSchedulerOverrides,
): Promise<Scheduler> {
  if (startedScheduler) return startedScheduler;
  const runtime = createScheduledRuntime({
    store,
    ...(logger ? { logger } : {}),
    ...(overrides?.invoke ? { invoke: overrides.invoke } : {}),
    ...(overrides?.runner ? { runner: overrides.runner } : {}),
  });
  const scheduler = createScheduler({
    getTasks: async () => Object.values((await store.get()).scheduledTasks),
    // 直连 runner，不走 runGuarded：`dispatch` 已经把 task.id 记进账本（那正是
    // 它做重叠判断的方式），而 runGuarded 的第一件事就是查同一本账本。接在这里
    // 的话每一次定时触发都会走进跳过分支——任务被记成"已跳过"，Agent 从未被创建，
    // 而唯一的症状是一条 debug 日志。
    //
    // 也就是说：`runGuarded` 是给**手动**入口的，调度器自己已经判过一次重叠。
    run: (task) => runtime.runner.runScheduledTask(task, 'scheduled').then(({ run }) => run),
    recordSkipped: (task) => runtime.runner.recordSkipped(task, 'scheduled'),
    ...(logger ? { logger } : {}),
  });
  // 数据一变就重建调度表。没有这条订阅，表只在启动时建一次：新建的任务排在表外
  // 永不触发（界面却照常显示「下次触发 明天 09:00」），删掉的任务留在表里继续
  // 触发。模块注释一直写着"数据变更后由调用方 refresh()"，而那个调用方不存在。
  const unsubscribe = store.onDataChanged(() => {
    void scheduler.refresh().catch((error: unknown) => {
      logger?.error({ action: 'scheduler:refreshFailed', error });
    });
  });
  schedulerUnsubscribe = unsubscribe;
  await scheduler.start();
  startedScheduler = scheduler;
  return scheduler;
}

/** 测试用：丢掉单例，让下一个 startScheduler 重新接。 */
export function _resetSchedulerForTest(): void {
  startedScheduler?.stop();
  startedScheduler = null;
  schedulerUnsubscribe?.();
  schedulerUnsubscribe = null;
}
