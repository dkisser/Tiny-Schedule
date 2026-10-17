import type { Schedule, ScheduledTask, ScheduledTaskRun } from '@tiny-schedule/shared';

/**
 * 定时任务的展示层纯函数（频率摘要、下次触发时间、运行状态文案）。
 *
 * 术语全部照 CONTEXT.md「定时任务（ScheduledTask）」一节：界面说"频率"不说 cron
 * 表达式，说"运行"不说执行记录/日志，说"执行目录"不说 cwd。刻意把这些文案收在一个
 * 文件里——它们是这个模块唯一会出现在界面上的自然语言，散进各个组件只会让术语在某
 * 一处悄悄漂移。
 */

/** 星期几，0 = 周日，与 `Date.prototype.getDay()` 同源（见 Schedule 类型）。 */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 一周七天的完整集合，用来判断"每周几"其实等价于每天。 */
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** 频率的类型标签，顺序即界面 Select 里的顺序。 */
export const SCHEDULE_KIND_LABELS = {
  daily: '每天',
  weekly: '每周几',
  monthly: '每月几号',
} as const;

export type ScheduleKind = keyof typeof SCHEDULE_KIND_LABELS;

export function isScheduleKind(value: string): value is ScheduleKind {
  return value in SCHEDULE_KIND_LABELS;
}

function weekdayLabel(day: number): string {
  return WEEKDAY_LABELS[day] ?? String(day);
}

/**
 * 频率摘要：每天 09:00 / 每周五 17:00 / 每月 1 号 08:30。
 *
 * 选了全部七天时收敛成"每天"——它与 daily 在触发规则上完全等价，而把七个星期几摊开
 * 只会让一行挤不进侧栏宽度的列表卡片。
 */
export function scheduleSummary(schedule: Schedule): string {
  const time = schedule.time;
  if (schedule.kind === 'daily') return `每天 ${time}`;
  if (schedule.kind === 'monthly') return `每月 ${schedule.dayOfMonth} 号 ${time}`;
  const days = [...schedule.daysOfWeek].sort((a, b) => a - b);
  if (days.length === ALL_WEEKDAYS.length) return `每天 ${time}`;
  return `每${days.map(weekdayLabel).join('、')} ${time}`;
}

/** 该频率在给定日期（本地时区）是否触发，与具体时刻无关。 */
export function occursOn(schedule: Schedule, day: Date): boolean {
  if (schedule.kind === 'daily') return true;
  if (schedule.kind === 'weekly') return schedule.daysOfWeek.includes(day.getDay());
  return day.getDate() === schedule.dayOfMonth;
}

/**
 * 从 `from` 起下一次触发的 epoch ms，严格晚于 `from`。
 *
 * 这是**界面自己的**推算，不是调度器的真相：真正的下一次触发由调度器决定（含进程未
 * 运行期间错过的触发不补跑这类规则，见 CONTEXT.md），而那条路径在主进程里，界面读
 * 不到。所以这里算出来的只用于"下次触发"的提示，算错的后果是显示一次不准的时间，
 * 不会让任何东西真的触发。返回 null 表示这段频率在未来 400 天内没有触发点。
 */
export function nextRunAt(schedule: Schedule, from: number): number | null {
  const hour = Number(schedule.time.slice(0, 2));
  const minute = Number(schedule.time.slice(3, 5));
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  for (let offset = 0; offset <= 400; offset += 1) {
    const day = new Date(from);
    day.setDate(day.getDate() + offset);
    if (!occursOn(schedule, day)) continue;
    // 用本地构造函数而不是 setHours：跨夏令时的那一天，setHours 会落到一个不存在的
    // 墙上时刻上，被引擎悄悄挪走。
    const at = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      hour,
      minute,
      0,
      0,
    ).getTime();
    if (at > from) return at;
  }
  return null;
}

/** `a` 与 `b` 之间跨了几个自然日（按本地零点算），与具体时刻无关。 */
export function calendarDaysBetween(a: number, b: number): number {
  const start = new Date(a);
  start.setHours(0, 0, 0, 0);
  const end = new Date(b);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** 日期部分：`10 月 18 日`；跨年的年份不在这里补，触发提示不需要那么精确。 */
export function formatDateOnly(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 运行记录上的完整时间戳：`2026-10-17 14:30`，排序与定位都靠它。 */
export function formatTimestamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 下次触发的短文案：今天 09:00 / 明天 09:00 / 10 月 18 日 09:00。
 *
 * 停用的定时任务没有"下次"——停用即不再触发，所以这里由调用方决定是否显示，而不
 * 是由这个函数伪造一个时间出来。
 */
export function nextRunLabel(schedule: Schedule, from: number): string {
  const at = nextRunAt(schedule, from);
  if (at === null) return '无计划触发';
  const days = calendarDaysBetween(from, at);
  if (days === 0) return `今天 ${schedule.time}`;
  if (days === 1) return `明天 ${schedule.time}`;
  return `${formatDateOnly(at)} ${schedule.time}`;
}

export const RUN_STATUS_LABELS = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  skipped: '已跳过',
  interrupted: '已中断',
} as const satisfies Record<ScheduledTaskRun['status'], string>;

/**
 * 状态标签的配色。
 *
 * 收在这里而不是各自组件里，是因为同一个状态在列表页与运行历史里必须看起来一样——
 * 两处各写一份 map，改了一处忘了另一处，"运行中"就会在两个界面里是两种颜色。
 * interrupted 用 failed 那档：它是一次没跑完的执行，不是"结果不好"，但同样需要被
 * 一眼看见。
 */
export const RUN_STATUS_TONES = {
  running: 'bg-primary/15 text-primary',
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-destructive/15 text-destructive',
  skipped: 'bg-secondary text-muted-foreground',
  interrupted: 'bg-destructive/15 text-destructive',
} as const satisfies Record<ScheduledTaskRun['status'], string>;

/** 运行是否还在进行中——列表页与详情页的「运行中」标记都问这一句。 */
export function isRunRunning(run: ScheduledTaskRun | null | undefined): boolean {
  return run?.status === 'running';
}

export const RUN_TRIGGER_LABELS = {
  /** 定时任务没有"运行记录"这个词的替代品：它是一次「运行」。 */
  scheduled: '定时触发',
  manual: '立即运行',
} as const satisfies Record<ScheduledTaskRun['trigger'], string>;

/** 耗时：`820 毫秒` / `3.4 秒` / `2 分 5 秒`。未结束的运行返回 null。 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

/** 一次运行的耗时；仍在运行（还没有 finishedAt）返回 null，界面据此显示「进行中」。 */
export function runDurationMs(run: ScheduledTaskRun): number | null {
  return run.finishedAt === undefined ? null : Math.max(0, run.finishedAt - run.startedAt);
}

/**
 * 列表排序：启用的在前，各组内按下一次触发时间升序，没有下一次的沉底。
 *
 * 同一次触发的时间戳对同一条频率是唯一的，所以这个比较是稳定的——不会出现刷新之后
 * 两条任务随机换位、用户的眼睛追着卡片跑。
 */
export function sortedScheduledTasks(tasks: ScheduledTask[], now: number): ScheduledTask[] {
  return [...tasks].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const at = nextRunAt(a.schedule, now) ?? Number.POSITIVE_INFINITY;
    const bt = nextRunAt(b.schedule, now) ?? Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}
