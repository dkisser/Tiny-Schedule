import type { Schedule, ScheduledTask } from '@tiny-schedule/shared';
import { type AiLogger, silentLogger } from '@/ai/logger';
import type { DataStore } from '@/bridge/dataStore';
import { createScheduledRuntime } from './runtime';

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
 * 频率求值 {@link nextTriggerAt} 是纯函数、不 import 任何宿主模块，所以它的边界
 * （当天时刻已过、跨周、月末）可以直接用 bun 测。
 */

/** 与"30s 对齐 tick"配套的周期；也是唤醒粒度下界。 */
const DEFAULT_TICK_MS = 30_000;

export type RunTriggerName = 'scheduled' | 'manual';

/** `HH:mm` → [时, 分]。schema 已经保证形状，这里只是把它拆开。 */
function parseTime(time: string): [number, number] {
  const [h = '0', m = '0'] = time.split(':');
  return [Number(h), Number(m)];
}

/** 本地时区的某个时刻。用 Date 构造器而不是加毫秒，跨夏令时才是对的。 */
function at(year: number, month: number, day: number, hours: number, minutes: number): number {
  return new Date(year, month, day, hours, minutes, 0, 0).getTime();
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 相对 `from` 的下一次触发时间（epoch ms，本地时区）。
 *
 * 严格大于 `from`：调用方问的是"下一次"，而"此刻正好到点"那一刻的触发应该由调度
 * 表自己记账——两者混在一起会让 tick 在边界上重复触发或漏触发一次。
 */
export function nextTriggerAt(schedule: Schedule, from: number): number {
  const [hours, minutes] = parseTime(schedule.time);
  const base = new Date(from);
  const year = base.getFullYear();
  const month = base.getMonth();
  const day = base.getDate();
  const now = at(year, month, day, hours, minutes);

  let next: number | null = null;
  if (schedule.kind === 'daily') {
    next = now > from ? now : at(year, month, day + 1, hours, minutes);
  } else if (schedule.kind === 'weekly') {
    // 扫未来 8 天：day + 7 与今天同一星期几，而今天那一档要么已经在上面被否掉、
    // 要么就是 now > from 已经返回了，所以 7 天内必然命中。
    for (let offset = 0; offset <= 7 && next === null; offset += 1) {
      const probe = new Date(year, month, day + offset);
      if (!schedule.daysOfWeek.includes(probe.getDay())) continue;
      const candidate = at(probe.getFullYear(), probe.getMonth(), probe.getDate(), hours, minutes);
      if (candidate > from) next = candidate;
    }
  } else {
    // 扫未来 13 个月，同理：今天这一档被否掉之后，下个月的同一号必然在前。
    for (let offset = 0; offset <= 12 && next === null; offset += 1) {
      const probe = new Date(year, month + offset, 1);
      // 31 号在 2 月不存在，收敛到当月最后一天。这是调度该跳过的那个月，不是
      // 该拒绝这个定时任务的时刻。
      const target = Math.min(
        schedule.dayOfMonth,
        daysInMonth(probe.getFullYear(), probe.getMonth()),
      );
      const candidate = at(probe.getFullYear(), probe.getMonth(), target, hours, minutes);
      if (candidate > from) next = candidate;
    }
  }

  // 三条分支都必然命中（见上面的循环上界）；真到这里说明 ScheduleSchema 被绕过
  // 了，那是一个应该炸而不是该静默返回 null 的情况。
  if (next === null) throw new Error(`无法求值频率：${JSON.stringify(schedule)}`);
  return next;
}

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
  /** 正在跑的定时任务；重叠保护的唯一真相来源。 */
  const inFlight = new Set<string>();
  /** 在途的运行，用于让测试等它落地，也用于 stop() 时不再派发。 */
  const running = new Set<Promise<unknown>>();
  let handle: TimerHandle = null;

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
   */
  const refresh = async (): Promise<void> => {
    const at0 = now();
    const tasks = await deps.getTasks();
    const next = new Map<string, SchedulerEntry>();
    for (const task of tasks) next.set(task.id, build(task, at0));
    table.clear();
    for (const [id, entry] of next) table.set(id, entry);
    logger.info({ action: 'scheduler:refresh', tasks: next.size });
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
    if (handle === null && table.size === 0) return; // 没 start 过也没数据
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
    if (handle !== null) return;
    await refresh();
    // 排到下一个整周期边界上，而不是"启动后 30 秒"：漂移会让所有任务的判定
    // 落在不同的秒数上，而一个 09:00:00 的任务被 09:00:07 判为到点并不是错，
    // 只是让"到点"这个词失去了它该有的含义。
    handle = timers.setInterval(() => void tick(), msToNextBoundary(now(), tickMs));
    // 对齐之后第一次 tick 是 tickMs 之后；这里不立刻补一次，因为 refresh 刚刚
    // 已经把每个任务的下一次算到了"此刻之后"——立刻 tick 只会读到全部未到期。
  };

  const stop = (): void => {
    if (handle !== null) timers.clearInterval(handle);
    handle = null;
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
let started: Scheduler | null = null;

export async function startScheduler(store: DataStore, logger?: AiLogger): Promise<Scheduler> {
  if (started) return started;
  const runtime = createScheduledRuntime({
    store,
    ...(logger ? { logger } : {}),
  });
  const scheduler = createScheduler({
    getTasks: async () => Object.values((await store.get()).scheduledTasks),
    run: (task) => runtime.runGuarded(task, 'scheduled').then(({ run }) => run),
    // 调度器在派发前已经判过一次重叠，recordSkipped 只负责把这条 skipped 记下来，
    // 所以直连 runner，不该再走一遍 runGuarded 的守卫。
    recordSkipped: (task) => runtime.runner.recordSkipped(task, 'scheduled'),
    ...(logger ? { logger } : {}),
  });
  await scheduler.start();
  started = scheduler;
  return scheduler;
}

/** 测试用：丢掉单例，让下一个 startScheduler 重新接。 */
export function _resetSchedulerForTest(): void {
  started?.stop();
  started = null;
}
