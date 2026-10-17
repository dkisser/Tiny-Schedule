import { describe, expect, test } from 'bun:test';
import type { Schedule, ScheduledTask, ScheduledTaskRun } from '@tiny-schedule/shared';
import { nextTriggerAt } from '@/scheduledTasks/scheduler';
import {
  calendarDaysBetween,
  formatDuration,
  formatTimestamp,
  nextRunAt,
  nextRunLabel,
  scheduleSummary,
  sortedScheduledTasks,
} from './scheduledTasks';

// 2026-10-17 是周六；所有用例都从当地正午出发，避开时刻临界。
const SATURDAY_NOON = new Date(2026, 9, 17, 12, 0, 0).getTime();

function st(partial: Partial<ScheduledTask> & { id: string }): ScheduledTask {
  return {
    name: partial.id,
    prompt: 'p',
    schedule: { kind: 'daily', time: '09:00' },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('scheduleSummary', () => {
  test('每天 / 每月按 CONTEXT.md 的说法渲染', () => {
    expect(scheduleSummary({ kind: 'daily', time: '09:00' })).toBe('每天 09:00');
    expect(scheduleSummary({ kind: 'monthly', dayOfMonth: 1, time: '08:30' })).toBe(
      '每月 1 号 08:30',
    );
  });

  test('每周几按周一在前排序并用「、」连接', () => {
    const weekly: Schedule = { kind: 'weekly', daysOfWeek: [5, 1, 3], time: '17:00' };
    expect(scheduleSummary(weekly)).toBe('每周一、周三、周五 17:00');
  });

  test('每周单日就是「每周五」，七天则收敛成「每天」', () => {
    expect(scheduleSummary({ kind: 'weekly', daysOfWeek: [5], time: '17:00' })).toBe(
      '每周五 17:00',
    );
    expect(
      scheduleSummary({ kind: 'weekly', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], time: '17:00' }),
    ).toBe('每天 17:00');
  });
});

describe('nextRunAt', () => {
  test('今天的时刻还没到就取今天，过了就顺延到下一次', () => {
    expect(nextRunAt({ kind: 'daily', time: '09:00' }, SATURDAY_NOON)).toBe(
      new Date(2026, 9, 18, 9, 0).getTime(),
    );
    expect(nextRunAt({ kind: 'daily', time: '23:00' }, SATURDAY_NOON)).toBe(
      new Date(2026, 9, 17, 23, 0).getTime(),
    );
  });

  test('恰好停在触发时刻上时不重复取当刻，顺延到下一次', () => {
    const at9 = new Date(2026, 9, 17, 9, 0).getTime();
    expect(nextRunAt({ kind: 'daily', time: '09:00' }, at9)).toBe(
      new Date(2026, 9, 18, 9, 0).getTime(),
    );
  });

  test('每周几只落在选中的星期上', () => {
    // 周六出发，下一个周三是 10 月 21 日。
    expect(nextRunAt({ kind: 'weekly', daysOfWeek: [3], time: '09:00' }, SATURDAY_NOON)).toBe(
      new Date(2026, 9, 21, 9, 0).getTime(),
    );
    // 当天剩下的时刻还没到，就取今天，不跨到下周三。
    const SATURDAY_MORNING = new Date(2026, 9, 17, 8, 0).getTime();
    expect(nextRunAt({ kind: 'weekly', daysOfWeek: [6], time: '09:00' }, SATURDAY_MORNING)).toBe(
      new Date(2026, 9, 17, 9, 0).getTime(),
    );
  });

  test('每月几号跨月顺延，当月没有该号就等下个月', () => {
    expect(nextRunAt({ kind: 'monthly', dayOfMonth: 1, time: '08:30' }, SATURDAY_NOON)).toBe(
      new Date(2026, 10, 1, 8, 30).getTime(),
    );
    // 31 号在 11 月不存在：从 11 月 1 日出发要等到 12 月 31 日。
    const NOVEMBER_NOON = new Date(2026, 10, 1, 12, 0).getTime();
    expect(nextRunAt({ kind: 'monthly', dayOfMonth: 31, time: '09:00' }, NOVEMBER_NOON)).toBe(
      new Date(2026, 11, 31, 9, 0).getTime(),
    );
  });

  test('界面算出的「下次触发」与调度器是同一个答案', () => {
    // 这一条的存在理由是**同一个频率有两个实现**：界面的 `nextRunAt` 与主进程的
    // `nextTriggerAt`。它们一度对「每月 31 号」的 2 月给出不同答案——界面说 3 月
    // 31 日，调度器钳位到 2 月 28 日，于是界面把一个不会发生的日期当作事实
    // 摆在用户面前。
    //
    // 界面自己的推算可以错（后果只是提示不准），但它与调度器不一致就是另一回事：
    // 那是在对用户撒谎。逐个频率比一遍，把这个性质固定住。
    const cases: Schedule[] = [
      { kind: 'daily', time: '09:00' },
      { kind: 'weekly', daysOfWeek: [1, 4], time: '08:30' },
      { kind: 'monthly', dayOfMonth: 31, time: '09:00' },
      { kind: 'monthly', dayOfMonth: 30, time: '09:00' },
      { kind: 'monthly', dayOfMonth: 29, time: '09:00' },
      { kind: 'monthly', dayOfMonth: 1, time: '00:05' },
    ];
    // 覆盖 1 月 31 日之后（连跳 2 月）、闰年 2 月、以及月中这三种起算点。
    const froms = [
      new Date(2026, 0, 31, 10, 0).getTime(),
      new Date(2027, 0, 31, 10, 0).getTime(),
      new Date(2028, 1, 1, 10, 0).getTime(),
      new Date(2026, 6, 17, 8, 0).getTime(),
    ];
    for (const schedule of cases) {
      for (const from of froms) {
        expect({ schedule, from, shown: nextRunAt(schedule, from) }).toEqual({
          schedule,
          from,
          shown: nextTriggerAt(schedule, from),
        });
      }
    }
  });

  test('时刻格式非法时返回 null，而不是给出一个假时间', () => {
    expect(nextRunAt({ kind: 'daily', time: 'bad' }, SATURDAY_NOON)).toBeNull();
  });
});

describe('nextRunLabel / calendarDaysBetween', () => {
  test('今天 / 明天用相对说法，更远用日期', () => {
    expect(nextRunLabel({ kind: 'daily', time: '23:00' }, SATURDAY_NOON)).toBe('今天 23:00');
    expect(nextRunLabel({ kind: 'daily', time: '09:00' }, SATURDAY_NOON)).toBe('明天 09:00');
    expect(nextRunLabel({ kind: 'monthly', dayOfMonth: 1, time: '08:30' }, SATURDAY_NOON)).toBe(
      '11 月 1 日 08:30',
    );
  });

  test('跨日按自然日算，不受时刻影响', () => {
    expect(calendarDaysBetween(SATURDAY_NOON, new Date(2026, 9, 20, 0, 5).getTime())).toBe(3);
    expect(calendarDaysBetween(SATURDAY_NOON, SATURDAY_NOON)).toBe(0);
  });
});

describe('formatDuration / formatTimestamp', () => {
  test('按量级选单位', () => {
    expect(formatDuration(820)).toBe('820 毫秒');
    expect(formatDuration(3400)).toBe('3.4 秒');
    expect(formatDuration(125_000)).toBe('2 分 5 秒');
    expect(formatDuration(120_000)).toBe('2 分');
    expect(formatDuration(-1)).toBe('—');
  });

  test('时间戳补零到分钟精度', () => {
    expect(formatTimestamp(new Date(2026, 9, 7, 9, 5).getTime())).toBe('2026-10-07 09:05');
  });
});

describe('sortedScheduledTasks', () => {
  test('停用的沉底，组内按下一次触发时间升序', () => {
    const list = [
      st({ id: 'off', enabled: false, schedule: { kind: 'daily', time: '07:00' } }),
      st({ id: 'evening', schedule: { kind: 'daily', time: '20:00' } }),
      st({ id: 'night', schedule: { kind: 'daily', time: '23:00' } }),
      st({ id: 'morning', schedule: { kind: 'daily', time: '09:00' } }),
    ];
    // 周六正午出发：20:00 与 23:00 都在今天，09:00 已过、顺延到明天。
    expect(sortedScheduledTasks(list, SATURDAY_NOON).map((t) => t.id)).toEqual([
      'evening',
      'night',
      'morning',
      'off',
    ]);
  });

  test('同一次触发时按名称排，比较稳定', () => {
    const same: Schedule = { kind: 'daily', time: '09:00' };
    // 拼音序：备（b）排在 巡（x）之前，与传入顺序相反——所以这条断言验证的是
    // "比较真的按名称走"，而不是"谁在前面谁保留原位"。
    const list = [
      st({ id: 'b', name: '备份', schedule: same }),
      st({ id: 'a', name: '巡检', schedule: same }),
    ];
    expect(sortedScheduledTasks(list, SATURDAY_NOON).map((t) => t.id)).toEqual(['b', 'a']);
  });

  test('不改动传入的数组', () => {
    const list = [st({ id: 'a' }), st({ id: 'b' })];
    const sorted = sortedScheduledTasks(list, SATURDAY_NOON);
    expect(list.map((t) => t.id)).toEqual(['a', 'b']);
    expect(sorted).not.toBe(list);
  });
});

describe('run history shapes', () => {
  test('一次运行的耗时来自 finishedAt - startedAt', async () => {
    const { runDurationMs, RUN_STATUS_LABELS, RUN_TRIGGER_LABELS } = await import(
      './scheduledTasks'
    );
    const run: ScheduledTaskRun = {
      id: 'r1',
      scheduledTaskId: 'st1',
      trigger: 'manual',
      startedAt: 1000,
      finishedAt: 4000,
      status: 'success',
      output: '',
      toolCalls: [],
    };
    expect(runDurationMs(run)).toBe(3000);
    // 还在跑的那一条没有结束时点，界面据此显示「进行中」——它不是一个 0 毫秒的运行。
    expect(
      runDurationMs({
        id: 'r2',
        scheduledTaskId: 'st1',
        trigger: 'manual',
        startedAt: 1000,
        status: 'running',
        toolCalls: [],
      }),
    ).toBeNull();
    expect(RUN_STATUS_LABELS.skipped).toBe('已跳过');
    expect(RUN_TRIGGER_LABELS.scheduled).toBe('定时触发');
  });

  test('每个状态都有中文文案，且 running / interrupted 说的是各自那件事', async () => {
    const { RUN_STATUS_LABELS, RUN_STATUS_TONES, isRunRunning } = await import('./scheduledTasks');
    // 术语按 CONTEXT.md：运行中 / 已中断 / 跳过。
    expect(RUN_STATUS_LABELS.running).toBe('运行中');
    expect(RUN_STATUS_LABELS.interrupted).toBe('已中断');
    expect(Object.keys(RUN_STATUS_LABELS).sort()).toEqual([
      'failed',
      'interrupted',
      'running',
      'skipped',
      'success',
    ]);
    // 五个状态各自都有配色，缺一个就是界面上有一处 fallback 样式。
    for (const tone of Object.values(RUN_STATUS_TONES)) expect(tone).not.toBe('');
    expect(
      isRunRunning({
        id: 'r1',
        scheduledTaskId: 'st1',
        trigger: 'manual',
        startedAt: 1,
        status: 'running',
        toolCalls: [],
      }),
    ).toBe(true);
    expect(isRunRunning(run0())).toBe(false);
    expect(isRunRunning(null)).toBe(false);
  });
});

/** 一条终态运行，够上面那些断言用。 */
function run0(): ScheduledTaskRun {
  return {
    id: 'r3',
    scheduledTaskId: 'st1',
    trigger: 'manual',
    startedAt: 1000,
    finishedAt: 1000,
    status: 'skipped',
    output: '',
    toolCalls: [],
  };
}
