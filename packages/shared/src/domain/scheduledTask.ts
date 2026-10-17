import { z } from 'zod';

/**
 * 定时任务与运行（CONTEXT.md「定时任务（ScheduledTask）」）。
 *
 * 与 Task 完全分开：任务是人做的待办，定时任务是机器到点执行的规则。两者不共享
 * 任何字段——唯一的重叠是名字里的"任务"，所以本文件的类型一律以 ScheduledTask
 * 开头，避免 `Task` 的读者顺着 import 找过来时找错实体。
 *
 * 权限模型见 ADR-0008：全部工具默认开放，**运行记录是唯一的追溯手段**。这解释了
 * {@link ScheduledTaskRunSchema} 为什么把每一次工具调用都完整留下——不是可选的
 * 日志，而是这个模块唯一的防线。
 */

/** 时刻，24 小时制 HH:mm。这是频率里唯一的时间表达，不带日期与时区。 */
const TIME_OF_DAY_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const TimeOfDaySchema = z.string().regex(TIME_OF_DAY_REGEX);

/**
 * 频率：结构化的触发规则，不是 cron 字符串，也不是自然语言。
 *
 * 三种 kind 各自带自己需要的判别字段，用判别联合而不是三个可选字段：`daily` 带上
 * `dayOfMonth` 在界面上没有意义，而"每周几"少一天（空数组）会是一个永不触发的
 * 静默坏数据，所以 weekly 的星期几至少一天。
 *
 * `dayOfMonth` 允许 1–31 而不是按当月长度收紧：31 号在 2 月不存在，但那是调度器
 * 该跳过的那个月，不是存这条定时任务时该拒绝的理由。
 */
export const ScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: TimeOfDaySchema }),
  z.object({
    kind: z.literal('weekly'),
    /** 星期几，0 = 周日，与 `Date.prototype.getDay()` 同源。 */
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
    time: TimeOfDaySchema,
  }),
  z.object({
    kind: z.literal('monthly'),
    dayOfMonth: z.number().int().min(1).max(31),
    time: TimeOfDaySchema,
  }),
]);

export type Schedule = z.infer<typeof ScheduleSchema>;

/** 一条运行里的单次工具调用。ADR-0008：审计是这个模块的底线，不是可选项。 */
export interface ToolCallRecord {
  id: string;
  /** 工具名，如 runCommand / httpRequest / writeFile / readFile。 */
  toolName: string;
  /** 参数摘要：完整参数可能含凭据与整份文件内容，落库的必须是摘要。 */
  argsSummary: string;
  /** 这次调用碰到的东西：本地调用记执行目录，http 记 host。 */
  target: string;
  resultSummary: string;
  durationMs: number;
  at: number; // epoch ms
}

/**
 * 运行的状态。
 *
 * `running` 与 `interrupted` 是同一件事的两端：运行从开始就落库（CONTEXT.md），而
 * 落库的东西必须能被收拾干净——进程在运行途中死掉时，磁盘上那条 running 记录就是
 * 这次执行留下的全部痕迹，启动对账把它改写成 interrupted，而不是让它永远停在"进行
 * 中"骗界面。
 *
 * `skipped` 仍是开始即结束的终态：上一轮未结束时的新触发被跳过，它没有执行过，也
 * 就没有"运行中"这个阶段。
 */
export type RunStatus = 'running' | 'success' | 'failed' | 'skipped' | 'interrupted';

/** 两种运行状态共有的部分。 */
interface ScheduledTaskRunBase {
  id: string;
  scheduledTaskId: string;
  /** `manual` 是「立即运行 (Run Now)」——同一个执行器、同进历史，与定时触发同构。 */
  trigger: 'scheduled' | 'manual';
  startedAt: number; // epoch ms
  /** 尚未结束时缺省；被对账改写的 interrupted 结束时点就是那次对账的时刻。 */
  finishedAt?: number; // epoch ms
  /** Agent 的最终输出文本。running 态还没有输出；skipped 是空字符串——没有执行，就没有输出。 */
  output?: string;
  /**
   * 工具调用审计。
   *
   * running 态恒为空数组：不逐次落盘，终态一次写全（ADR-0008 要的是"一次运行留下
   * 完整的一次记录"，不是每次调用留一个残片）。
   */
  toolCalls: ToolCallRecord[];
  error?: string;
}

/** 正在执行中：开始即落库，结束时被 {@link FinishedScheduledTaskRun} 改写。 */
export interface RunningScheduledTaskRun extends ScheduledTaskRunBase {
  status: 'running';
}

/** 已结束：success / failed / skipped / interrupted，都带着结束时点与结果。 */
export interface FinishedScheduledTaskRun extends ScheduledTaskRunBase {
  status: 'success' | 'failed' | 'skipped' | 'interrupted';
  finishedAt: number;
  output: string;
}

/**
 * 一次触发的执行实例。CONTEXT.md 的术语是「运行 (Run)」；类型名带上 ScheduledTask
 * 前缀，是因为它在 `AppData` 里与 `scheduledTasks` 并列，`runs` 两个字单独出现读不
 * 出归属。
 *
 * 判别联合而不是一个带可选字段的扁平接口：running 与终态在 finishedAt / output 上
 * 是**不同的形状**，让类型本身就说不出"一条没有结束时点的成功运行"这种东西——那正是
 * 上一版"只增记录"的形状下最容易被误造出来的东西。
 */
export type ScheduledTaskRun = RunningScheduledTaskRun | FinishedScheduledTaskRun;

export interface ScheduledTask {
  id: string;
  name: string;
  /** 交给 Agent 的那段 prompt。 */
  prompt: string;
  schedule: Schedule;
  /** 执行目录：执行上下文，不是权限边界（ADR-0008）。缺省则用应用默认目录。 */
  workingDirectory?: string;
  /** 停用即不再触发。它是属性不是状态机，所以不单独设命令。 */
  enabled: boolean;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

export const ToolCallRecordSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().min(1),
  argsSummary: z.string(),
  target: z.string(),
  resultSummary: z.string(),
  durationMs: z.number().nonnegative(),
  at: z.number(),
});

/** 两种状态共有的字段。default([]) 让 skipped / running 不必复述审计数组。 */
const RUN_BASE_SHAPE = {
  id: z.string().min(1),
  scheduledTaskId: z.string().min(1),
  trigger: z.enum(['scheduled', 'manual']),
  startedAt: z.number(),
  toolCalls: z.array(ToolCallRecordSchema).default([]),
  error: z.string().optional(),
};

/** 进行中：结束时点与输出都还没有。 */
export const RunningScheduledTaskRunSchema = z.object({
  ...RUN_BASE_SHAPE,
  status: z.literal('running'),
  finishedAt: z.number().optional(),
  output: z.string().optional(),
});

/** 终态：结束时点与输出必备——没跑完的运行不是这四个里的任何一个。 */
export const FinishedScheduledTaskRunSchema = z.object({
  ...RUN_BASE_SHAPE,
  status: z.enum(['success', 'failed', 'skipped', 'interrupted']),
  finishedAt: z.number(),
  output: z.string(),
});

export const ScheduledTaskRunSchema = z.discriminatedUnion('status', [
  RunningScheduledTaskRunSchema,
  FinishedScheduledTaskRunSchema,
]);

export const ScheduledTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  schedule: ScheduleSchema,
  workingDirectory: z.string().optional(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export function newScheduledTaskId(): string {
  return `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newScheduledTaskRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 新建的定时任务是启用状态。
 *
 * 这不是"默认值"，是唯一的定义：一个刚建好的定时任务如果默认是停用的，用户看到
 * 的是一个不会触发、自己也说不清为什么不触发的规则。
 */
export function blankScheduledTask(name: string, prompt = '', schedule?: Schedule): ScheduledTask {
  const now = Date.now();
  return {
    id: newScheduledTaskId(),
    name,
    prompt,
    schedule: schedule ?? { kind: 'daily', time: '09:00' },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 新运行：同一次执行无论由定时触发还是「立即运行」发起，都从这里开始。
 *
 * `skipped` 是一次真实的运行记录而不是空操作——CONTEXT.md 说前一次未结束时的新触发
 * 被跳过并记为 skipped，所以调度器要能把它写下来，只是不启动 Agent。
 */
export function newScheduledTaskRun(
  scheduledTaskId: string,
  trigger: ScheduledTaskRun['trigger'],
  now = Date.now(),
): ScheduledTaskRun {
  return {
    id: newScheduledTaskRunId(),
    scheduledTaskId,
    trigger,
    startedAt: now,
    finishedAt: now,
    status: 'skipped',
    output: '',
    toolCalls: [],
  };
}
