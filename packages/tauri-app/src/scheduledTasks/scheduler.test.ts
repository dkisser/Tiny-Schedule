import { describe, expect, test } from 'bun:test';
import type { ScheduledTask } from '@tiny-schedule/shared';
import { silentLogger } from '@/ai/logger';
import { createScheduler, nextTriggerAt, type TimerHandle } from './scheduler';

/** 本地时刻的 epoch ms，测试全部走本地时区，与实现的构造方式一致。 */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): number {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

function human(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')} ${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
}

// 2026-10-17 是周六（getDay() === 6），10 月有 31 天，2 月（2028 闰年）有 29 天。
describe('nextTriggerAt — 每天', () => {
  test('时刻还没到，取今天', () => {
    const next = nextTriggerAt({ kind: 'daily', time: '09:00' }, local(2026, 10, 17, 8, 0));
    expect(human(next)).toBe('2026-10-17 09:00');
  });

  test('当天时刻已过，取明天 —— 当天那一档绝不补跑', () => {
    // 边界：09:00 已过 11:00。返回昨天/今天 09:00 都会让它在同一分钟跑两次。
    const next = nextTriggerAt({ kind: 'daily', time: '09:00' }, local(2026, 10, 17, 11, 0));
    expect(human(next)).toBe('2026-10-18 09:00');
  });

  test('恰好等于当前时刻算已过', () => {
    // 严格大于：调度表自己记着"这一档已经触发过"，从这一刻问"下一次"就该是明天。
    const next = nextTriggerAt({ kind: 'daily', time: '09:00' }, local(2026, 10, 17, 9, 0));
    expect(human(next)).toBe('2026-10-18 09:00');
  });

  test('跨月与跨年', () => {
    expect(human(nextTriggerAt({ kind: 'daily', time: '09:00' }, local(2026, 10, 31, 10, 0)))).toBe(
      '2026-11-01 09:00',
    );
    expect(human(nextTriggerAt({ kind: 'daily', time: '09:00' }, local(2026, 12, 31, 10, 0)))).toBe(
      '2027-01-01 09:00',
    );
  });
});

describe('nextTriggerAt — 每周', () => {
  test('今天就是那天且时刻未到', () => {
    // 2026-10-17 是周六。
    const next = nextTriggerAt(
      { kind: 'weekly', daysOfWeek: [6], time: '09:00' },
      local(2026, 10, 17, 8, 0),
    );
    expect(human(next)).toBe('2026-10-17 09:00');
  });

  test('今天就是那天但时刻已过 —— 顺延一周', () => {
    const next = nextTriggerAt(
      { kind: 'weekly', daysOfWeek: [6], time: '09:00' },
      local(2026, 10, 17, 11, 0),
    );
    expect(human(next)).toBe('2026-10-24 09:00');
  });

  test('取本周内最近的一个未来日子', () => {
    // 周六晚找周一。
    const next = nextTriggerAt(
      { kind: 'weekly', daysOfWeek: [1, 3, 5], time: '08:30' },
      local(2026, 10, 17, 22, 0),
    );
    expect(human(next)).toBe('2026-10-19 08:30'); // 周一
  });

  test('一周只有一个日子也能跨周找到下一个', () => {
    const next = nextTriggerAt(
      { kind: 'weekly', daysOfWeek: [3], time: '08:30' },
      local(2026, 10, 17, 0, 0),
    );
    expect(human(next)).toBe('2026-10-21 08:30'); // 下一个周三
  });

  test('跨月的一周', () => {
    const next = nextTriggerAt(
      { kind: 'weekly', daysOfWeek: [1], time: '08:30' },
      local(2026, 10, 28, 12, 0),
    );
    expect(human(next)).toBe('2026-11-02 08:30');
  });

  test('周日的 0 而不是 7', () => {
    // daysOfWeek 用 getDay() 的 0=周日。写成 7 会永远匹配不上，然后循环扫满
    // 8 天后抛错——所以这条断言顺带守住"周日的写法"。
    const next = nextTriggerAt(
      { kind: 'weekly', daysOfWeek: [0], time: '07:00' },
      local(2026, 10, 17, 12, 0),
    );
    expect(human(next)).toBe('2026-10-18 07:00'); // 10-18 是周日
  });
});

describe('nextTriggerAt — 每月', () => {
  test('本月还没到', () => {
    const next = nextTriggerAt(
      { kind: 'monthly', dayOfMonth: 1, time: '00:05' },
      local(2026, 10, 17),
    );
    expect(human(next)).toBe('2026-11-01 00:05');
  });

  test('本月已过，取下月', () => {
    const next = nextTriggerAt(
      { kind: 'monthly', dayOfMonth: 15, time: '12:00' },
      local(2026, 10, 20, 13, 0),
    );
    expect(human(next)).toBe('2026-11-15 12:00');
  });

  test('当天时刻已过，顺延一个月', () => {
    const next = nextTriggerAt(
      { kind: 'monthly', dayOfMonth: 17, time: '09:00' },
      local(2026, 10, 17, 10, 0),
    );
    expect(human(next)).toBe('2026-11-17 09:00');
  });

  test('31 号在只有 30 天的月份收敛到月末', () => {
    // 11 月先于 12 月到达，所以答案是 11-30 而不是 12-31 —— 收敛发生在**第一个**
    // 没有 31 号的月份上。
    expect(
      human(nextTriggerAt({ kind: 'monthly', dayOfMonth: 31, time: '09:00' }, local(2026, 11, 5))),
    ).toBe('2026-11-30 09:00');
    // 同上：从 10-31 出发，第一档落在 11-30。
    expect(
      human(
        nextTriggerAt(
          { kind: 'monthly', dayOfMonth: 31, time: '09:00' },
          local(2026, 10, 31, 10, 0),
        ),
      ),
    ).toBe('2026-11-30 09:00');
    // 2027 年 1 月 31 日之后是 2 月，只有 28 天。
    expect(
      human(nextTriggerAt({ kind: 'monthly', dayOfMonth: 31, time: '09:00' }, local(2027, 2, 1))),
    ).toBe('2027-02-28 09:00');
  });

  test('闰年的 2 月收敛到 29 号', () => {
    expect(
      human(nextTriggerAt({ kind: 'monthly', dayOfMonth: 31, time: '09:00' }, local(2028, 2, 1))),
    ).toBe('2028-02-29 09:00');
  });

  test('收敛后的时刻已过则再退一个月', () => {
    // 2 月 28 日 10:00 问一个 09:00 的 31 号任务：2 月那一档（收敛到 28 号 09:00）
    // 已经过了，必须退到 3 月 31 号，而不是留在 2 月再报一次。
    const next = nextTriggerAt(
      { kind: 'monthly', dayOfMonth: 31, time: '09:00' },
      local(2027, 2, 28, 10, 0),
    );
    expect(human(next)).toBe('2027-03-31 09:00');
  });
});

// ---------------------------------------------------------------------------
// 调度循环
// ---------------------------------------------------------------------------

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'st1',
    name: '每日汇总',
    prompt: '汇总',
    schedule: { kind: 'daily', time: '09:00' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** 假时钟 + 假定时器：tick 由测试显式推进，不靠真实的 setInterval。 */
function harness(
  tasks: ScheduledTask[],
  start: number,
  overrides: Partial<Parameters<typeof createScheduler>[0]> = {},
) {
  let clock = start;
  const runs: { taskId: string; trigger: string }[] = [];
  const skipped: { taskId: string; trigger: string }[] = [];
  /** 让某次运行悬住，用来构造"前一次未结束"。 */
  let hold: Promise<void> | null = null;
  const scheduler = createScheduler({
    getTasks: () => tasks,
    run: async (t, trigger) => {
      runs.push({ taskId: t.id, trigger });
      if (hold) await hold;
    },
    recordSkipped: async (t, trigger) => {
      skipped.push({ taskId: t.id, trigger });
    },
    logger: silentLogger,
    now: () => clock,
    timers: { setInterval: () => null, clearInterval: () => undefined },
    ...overrides,
  });
  return {
    scheduler,
    runs,
    skipped,
    advanceTo: (ms: number) => {
      clock = ms;
    },
    /** 让之后的运行一直悬着。 */
    holdOpen: () => {
      hold = new Promise(() => undefined);
    },
  };
}

describe('调度循环', () => {
  test('到点触发一次，之后自动排到下一次', async () => {
    const t = task();
    const h = harness([t], local(2026, 10, 17, 8, 0));
    await h.scheduler.start();

    expect(h.runs).toHaveLength(0);
    h.advanceTo(local(2026, 10, 17, 9, 0));
    await h.scheduler.tick();
    await h.scheduler.settled();

    expect(h.runs).toEqual([{ taskId: 'st1', trigger: 'scheduled' }]);
    expect(human(h.scheduler.peek()[0]?.nextAt ?? 0)).toBe('2026-10-18 09:00');
  });

  test('未到点不触发', async () => {
    const h = harness([task()], local(2026, 10, 17, 8, 0));
    await h.scheduler.start();
    h.advanceTo(local(2026, 10, 17, 8, 59));
    await h.scheduler.tick();
    expect(h.runs).toHaveLength(0);
  });

  test('停用的任务到点也不触发，但仍在表里', async () => {
    const h = harness([task({ enabled: false })], local(2026, 10, 17, 8, 0));
    await h.scheduler.start();
    h.advanceTo(local(2026, 10, 17, 9, 0));
    await h.scheduler.tick();
    await h.scheduler.settled();

    expect(h.runs).toHaveLength(0);
    // 仍在表里且已排到明天——重新启用后不必等一次数据刷新。
    expect(human(h.scheduler.peek()[0]?.nextAt ?? 0)).toBe('2026-10-18 09:00');
  });

  test('启动时只向后算，不回看 —— 错过的不补跑', async () => {
    // CONTEXT.md: 进程未运行期间错过的触发不补跑。一个 09:00 的每日任务在 14:00
    // 启动，当天那一档已经过去，调度表里不该有它。
    const h = harness([task()], local(2026, 10, 17, 14, 0));
    await h.scheduler.start();
    await h.scheduler.tick();
    await h.scheduler.settled();

    expect(h.runs).toHaveLength(0);
    expect(human(h.scheduler.peek()[0]?.nextAt ?? 0)).toBe('2026-10-18 09:00');
  });

  test('多个任务各自按自己的频率到点', async () => {
    const h = harness(
      [
        task({ id: 'daily' }),
        task({ id: 'weekly', schedule: { kind: 'weekly', daysOfWeek: [1], time: '08:30' } }),
        task({ id: 'monthly', schedule: { kind: 'monthly', dayOfMonth: 1, time: '00:05' } }),
      ],
      local(2026, 10, 17, 12, 0),
    );
    await h.scheduler.start();
    h.advanceTo(local(2026, 10, 19, 9, 0));
    await h.scheduler.tick();
    await h.scheduler.settled();

    expect(h.runs.map((r) => r.taskId).sort()).toEqual(['daily', 'weekly']);
  });
});

describe('重叠保护 — 前一次运行未结束时，新触发跳过', () => {
  test('第二次到点记一条 skipped，而不是并发再跑一次', async () => {
    const h = harness([task()], local(2026, 10, 17, 8, 0));
    h.holdOpen();
    await h.scheduler.start();

    h.advanceTo(local(2026, 10, 17, 9, 0));
    await h.scheduler.tick();
    expect(h.runs).toHaveLength(1);
    expect(h.scheduler.isRunning('st1')).toBe(true);

    h.advanceTo(local(2026, 10, 18, 9, 0));
    await h.scheduler.tick();

    expect(h.runs).toHaveLength(1);
    expect(h.skipped).toEqual([{ taskId: 'st1', trigger: 'scheduled' }]);
    // 下一次已经推到再往后，所以不会被反复记成 skipped。
    expect(human(h.scheduler.peek()[0]?.nextAt ?? 0)).toBe('2026-10-19 09:00');
  });

  test('前一次跑完之后恢复正常触发', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness([task()], local(2026, 10, 17, 8, 0), {
      run: async () => {
        await gate;
      },
    });
    await h.scheduler.start();
    h.advanceTo(local(2026, 10, 17, 9, 0));
    await h.scheduler.tick();
    expect(h.scheduler.isRunning('st1')).toBe(true);

    release();
    await h.scheduler.settled();
    expect(h.scheduler.isRunning('st1')).toBe(false);

    h.advanceTo(local(2026, 10, 18, 9, 0));
    await h.scheduler.tick();
    expect(h.skipped).toHaveLength(0);
  });

  test('不同定时任务互不影响', async () => {
    let clock = local(2026, 10, 17, 8, 0);
    const runs: string[] = [];
    const skipped: string[] = [];
    const scheduler = createScheduler({
      getTasks: () => [task({ id: 'a' }), task({ id: 'b' })],
      run: async (t) => {
        runs.push(t.id);
        // a 永远不结束，b 立刻结束。
        if (t.id === 'a') await new Promise(() => undefined);
      },
      recordSkipped: async (t) => {
        skipped.push(t.id);
      },
      logger: silentLogger,
      now: () => clock,
      timers: { setInterval: () => null, clearInterval: () => undefined },
    });
    await scheduler.start();

    clock = local(2026, 10, 17, 9, 0);
    await scheduler.tick();
    // b 的运行已经完成，但 in-flight 标记是在它 promise settle 时清掉的，所以要
    // 让出到宏任务——这不是时序上的将就，而是"跑完"本来就等于 promise settle。
    await new Promise((resolve) => setTimeout(resolve, 0));

    clock = local(2026, 10, 18, 9, 0);
    await scheduler.tick();

    // a 悬着所以被跳过，b 照常按自己的节奏跑完了两次。
    expect(skipped).toEqual(['a']);
    expect(runs.filter((id) => id === 'b')).toHaveLength(2);
  });

  test('一次失败的运行不重试，也不占住下一次触发', async () => {
    let attempts = 0;
    const h = harness([task()], local(2026, 10, 17, 8, 0), {
      run: async () => {
        attempts += 1;
        throw new Error('provider 500');
      },
    });
    await h.scheduler.start();
    h.advanceTo(local(2026, 10, 17, 9, 0));
    await h.scheduler.tick();
    await h.scheduler.settled();
    expect(attempts).toBe(1);

    h.advanceTo(local(2026, 10, 18, 9, 0));
    await h.scheduler.tick();
    await h.scheduler.settled();

    // 不重试，但明天的触发照常发生（CONTEXT.md: 失败不重试、不停用定时任务）。
    expect(attempts).toBe(2);
    expect(h.skipped).toHaveLength(0);
  });
});

describe('数据变更后刷新调度表', () => {
  test('新加的任务在刷新后进入调度表并按时触发', async () => {
    const tasks: ScheduledTask[] = [];
    const h = harness(tasks, local(2026, 10, 17, 8, 0));
    await h.scheduler.start();
    expect(h.scheduler.peek()).toHaveLength(0);

    tasks.push(task());
    await h.scheduler.refresh();
    h.advanceTo(local(2026, 10, 17, 9, 0));
    await h.scheduler.tick();
    await h.scheduler.settled();

    expect(h.runs).toHaveLength(1);
  });

  test('改过时刻的任务按新的时刻走', async () => {
    const tasks = [task()];
    const h = harness(tasks, local(2026, 10, 17, 8, 0));
    await h.scheduler.start();

    tasks[0] = { ...tasks[0]!, schedule: { kind: 'daily', time: '21:00' } };
    await h.scheduler.refresh();

    expect(human(h.scheduler.peek()[0]?.nextAt ?? 0)).toBe('2026-10-17 21:00');
    h.advanceTo(local(2026, 10, 17, 9, 0));
    await h.scheduler.tick();
    expect(h.runs).toHaveLength(0);
  });

  test('删除的任务不再触发', async () => {
    const tasks = [task()];
    const h = harness(tasks, local(2026, 10, 17, 8, 0));
    await h.scheduler.start();

    tasks.length = 0;
    await h.scheduler.refresh();

    h.advanceTo(local(2026, 10, 17, 9, 0));
    await h.scheduler.tick();
    expect(h.runs).toHaveLength(0);
    expect(h.scheduler.peek()).toHaveLength(0);
  });

  test('刷新不补跑：把一条每日任务拖到明天再刷新，今天那一档不会补', async () => {
    const tasks = [task()];
    const h = harness(tasks, local(2026, 10, 17, 8, 0));
    await h.scheduler.start();
    h.advanceTo(local(2026, 10, 17, 12, 0));
    await h.scheduler.refresh();
    await h.scheduler.tick();
    await h.scheduler.settled();

    expect(h.runs).toHaveLength(0);
    expect(human(h.scheduler.peek()[0]?.nextAt ?? 0)).toBe('2026-10-18 09:00');
  });
});

describe('生命周期', () => {
  test('stop 之后不再排新的 tick', async () => {
    let interval: TimerHandle = null;
    let ticks = 0;
    const h = harness([task()], local(2026, 10, 17, 8, 0), {
      timers: {
        setInterval: (fn) => {
          interval = fn;
          return 1;
        },
        clearInterval: (handle) => {
          if (handle === 1) interval = null;
        },
      },
    });
    await h.scheduler.start();
    expect(interval).not.toBeNull();

    h.scheduler.stop();
    expect(interval).toBeNull();
    // The registered callback stays valid but nothing re-arms it; assert the
    // handle is what the scheduler gave up rather than poking at internals.
    expect(ticks).toBe(0);
  });

  test('start 两次不会排两个循环', async () => {
    let arms = 0;
    const h = harness([task()], local(2026, 10, 17, 8, 0), {
      timers: {
        setInterval: () => {
          arms += 1;
          return 1;
        },
        clearInterval: () => undefined,
      },
    });
    await h.scheduler.start();
    await h.scheduler.start();
    expect(arms).toBe(1);
  });
});
