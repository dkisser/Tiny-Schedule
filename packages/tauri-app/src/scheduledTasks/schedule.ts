import type { Schedule } from '@tiny-schedule/shared';

/**
 * 频率求值：把一段 schedule 变成"下一次触发的时刻"。
 *
 * 纯函数，**不 import 任何宿主模块** —— 没有 Tauri、没有通知插件、没有 store。
 * 这不是巧合而是这个文件存在的理由：界面的「下次触发」提示与主进程的调度器是
 * 两份实现（一个在 renderer、一个在这里），而它们必须给出同一个答案，否则
 * 界面会把一个不会发生的日子当事实摆在用户面前。要验证这件事，就必须能在
 * 一个不加载整个 Tauri 运行时的测试里同时 import 这两个实现。
 *
 * 放在 `scheduler.ts` 里时这份性质只是"碰巧成立"：那里 import 了 runtime，
 * 而 runtime import 了通知插件与 dataStore，任何一个模块将来多出一条
 * import 期副作用，纯函数的测试前提就无声地失效了。
 */

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
    // 扫未来 13 个月。12 这个上界对"跳过"语义仍然够：任何 `dayOfMonth` 都
    // 至少在 28 天以上的月份存在，所以最长连跳两个月（31 号遇上 2 月）之后必然
    // 命中。
    for (let offset = 0; offset <= 12 && next === null; offset += 1) {
      const probe = new Date(year, month + offset, 1);
      // 没有这一天的月份**跳过**，不收敛到月末。界面在选择器下面就是这么承诺的
      // （「没有这一天的月份（如 2 月 31 日）会跳过，不补跑」），而早先的实现
      // 悄悄收敛到 28/29 号——于是「每月 31 号」一年多跑三次，跑在用户被明确
      // 告知不会跑的日期上。承诺与实现只能留一个，这里按承诺。
      //
      // `dayOfMonth` 是 1..31，跳过之后就等于没有候选，所以先判存在性再算时刻。
      if (daysInMonth(probe.getFullYear(), probe.getMonth()) < schedule.dayOfMonth) continue;
      const candidate = at(
        probe.getFullYear(),
        probe.getMonth(),
        schedule.dayOfMonth,
        hours,
        minutes,
      );
      if (candidate > from) next = candidate;
    }
  }

  // 三条分支都必然命中（见上面的循环上界）；真到这里说明 ScheduleSchema 被绕过
  // 了，那是一个应该炸而不是该静默返回 null 的情况。
  if (next === null) throw new Error(`无法求值频率：${JSON.stringify(schedule)}`);
  return next;
}
