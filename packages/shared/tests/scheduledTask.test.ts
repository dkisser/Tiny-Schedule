import { describe, expect, test } from 'bun:test';
import { type AppData, AppDataSchema, emptyAppData } from '../src/domain/appData';
import {
  blankScheduledTask,
  newScheduledTaskRun,
  type ScheduledTaskRun,
  ScheduledTaskRunSchema,
  ScheduledTaskSchema,
  ScheduleSchema,
  type ToolCallRecord,
} from '../src/domain/scheduledTask';

const task = {
  id: 'st1',
  name: '每日汇总',
  prompt: '汇总今天的提交',
  schedule: { kind: 'daily' as const, time: '09:00' },
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
};

const toolCall: ToolCallRecord = {
  id: 'tc1',
  toolName: 'runCommand',
  argsSummary: 'git log --oneline -20',
  target: '/repo',
  resultSummary: '20 commits',
  durationMs: 120,
  at: 5,
};

describe('ScheduleSchema — 结构化的频率，不是 cron 字符串', () => {
  test('three kinds each carry only the fields they mean', () => {
    expect(ScheduleSchema.parse({ kind: 'daily', time: '09:00' })).toEqual({
      kind: 'daily',
      time: '09:00',
    });
    expect(ScheduleSchema.parse({ kind: 'weekly', daysOfWeek: [1, 3, 5], time: '08:30' })).toEqual({
      kind: 'weekly',
      daysOfWeek: [1, 3, 5],
      time: '08:30',
    });
    expect(ScheduleSchema.parse({ kind: 'monthly', dayOfMonth: 1, time: '00:05' })).toEqual({
      kind: 'monthly',
      dayOfMonth: 1,
      time: '00:05',
    });
  });

  test('a cron string or plain language is not a frequency', () => {
    // CONTEXT.md: 频率不是 cron 表达式，也不是自然语言。Two rules, one
    // discriminator — a string that happens to parse as one of them would
    // re-open the decision the ADR closed.
    expect(ScheduleSchema.safeParse({ kind: 'daily', time: '0 9 * * *' }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ kind: 'daily', time: '每天早上' }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ kind: 'cron', time: '09:00' }).success).toBe(false);
  });

  test('the moment must be a 24-hour HH:mm', () => {
    for (const time of ['24:00', '9:00', '09:60', '09:0', '']) {
      expect(ScheduleSchema.safeParse({ kind: 'daily', time }).success).toBe(false);
    }
    expect(ScheduleSchema.safeParse({ kind: 'daily', time: '23:59' }).success).toBe(true);
  });

  test('a weekly schedule needs at least one day', () => {
    // An empty day list parses fine as data and never fires — the worst kind of
    // silent bad value, so the schema refuses it at the boundary instead.
    expect(
      ScheduleSchema.safeParse({ kind: 'weekly', daysOfWeek: [], time: '09:00' }).success,
    ).toBe(false);
    expect(
      ScheduleSchema.safeParse({ kind: 'weekly', daysOfWeek: [7], time: '09:00' }).success,
    ).toBe(false);
  });

  test('monthly accepts 31 and rejects 0 / 32', () => {
    expect(
      ScheduleSchema.safeParse({ kind: 'monthly', dayOfMonth: 31, time: '09:00' }).success,
    ).toBe(true);
    expect(
      ScheduleSchema.safeParse({ kind: 'monthly', dayOfMonth: 0, time: '09:00' }).success,
    ).toBe(false);
    expect(
      ScheduleSchema.safeParse({ kind: 'monthly', dayOfMonth: 32, time: '09:00' }).success,
    ).toBe(false);
  });
});

describe('ScheduledTaskSchema', () => {
  test('round-trips, working directory included', () => {
    const parsed = ScheduledTaskSchema.parse({ ...task, workingDirectory: '/repo' });
    expect(parsed.workingDirectory).toBe('/repo');
    expect(parsed.enabled).toBe(true);
  });

  test('the working directory is optional', () => {
    expect(ScheduledTaskSchema.parse(task).workingDirectory).toBeUndefined();
  });

  test('a task needs a name and a prompt', () => {
    expect(ScheduledTaskSchema.safeParse({ ...task, name: '  ' }).success).toBe(false);
    expect(ScheduledTaskSchema.safeParse({ ...task, prompt: '' }).success).toBe(false);
  });

  test('a new task is enabled — see blankScheduledTask for why', () => {
    expect(blankScheduledTask('每日汇总').enabled).toBe(true);
  });
});

describe('ScheduledTaskRunSchema — 审计是这个模块的底线', () => {
  const run = {
    id: 'r1',
    scheduledTaskId: 'st1',
    trigger: 'scheduled' as const,
    startedAt: 10,
    finishedAt: 20,
    status: 'success' as const,
    output: '汇总完成',
    toolCalls: [toolCall],
  };

  test('every field of a run survives a parse', () => {
    // A zod object strips keys it does not declare, and the audit trail is the
    // only trace an all-permissions agent run leaves (ADR-0008). A field
    // dropped here is evidence that no longer exists.
    const parsed = ScheduledTaskRunSchema.parse(run);
    expect(parsed.toolCalls[0]).toEqual(toolCall);
    expect(parsed.output).toBe('汇总完成');
    expect(parsed.trigger).toBe('scheduled');
  });

  test('a whole-dataset parse keeps the run, which is what save() runs', () => {
    const data = AppDataSchema.parse({
      ...emptyAppData(),
      scheduledTasks: { st1: task },
      runs: { r1: run },
    }) as AppData;
    expect(data.runs.r1?.toolCalls).toHaveLength(1);
    expect(data.scheduledTasks.st1?.name).toBe('每日汇总');
  });

  test('a skipped run needs no audit array', () => {
    // 前一次运行未结束时的新触发跳过，记为 skipped. The runner must be able to
    // record that without restating an empty audit trail.
    const parsed = ScheduledTaskRunSchema.parse({
      id: 'r2',
      scheduledTaskId: 'st1',
      trigger: 'manual',
      startedAt: 30,
      finishedAt: 30,
      status: 'skipped',
      output: '',
    });
    expect(parsed.toolCalls).toEqual([]);
  });

  test('status is one of the five, and the终态 ones must be finished', () => {
    const base = { ...run, toolCalls: [toolCall] };
    for (const status of ['success', 'failed', 'skipped', 'interrupted'] as const) {
      expect(ScheduledTaskRunSchema.safeParse({ ...base, status }).success).toBe(true);
    }
    // running 只需要开始：运行时长与输出都还没有。
    expect(ScheduledTaskRunSchema.safeParse({ ...base, status: 'running' }).success).toBe(true);
    // 四个终态缺 finishedAt 全部不合法——"跑完了却没有结束时点"的记录无法解释。
    for (const status of ['success', 'failed', 'skipped', 'interrupted'] as const) {
      const { finishedAt, ...withoutFinish } = base;
      expect(ScheduledTaskRunSchema.safeParse({ ...withoutFinish, status }).success).toBe(false);
    }
    expect(ScheduledTaskRunSchema.safeParse({ ...base, status: 'never' }).success).toBe(false);
  });

  test('a running record parses without finishedAt or output — that is its shape', () => {
    // CONTEXT.md: 运行从开始就落库. So the parse a save() runs has to accept a
    // record whose only content is "this run started, and did not get to write
    // anything yet".
    const parsed = ScheduledTaskRunSchema.parse({
      id: 'r3',
      scheduledTaskId: 'st1',
      trigger: 'scheduled',
      startedAt: 40,
      status: 'running',
    });
    expect(parsed.status).toBe('running');
    expect(parsed.finishedAt).toBeUndefined();
    expect(parsed.output).toBeUndefined();
    expect(parsed.toolCalls).toEqual([]);
  });

  test('a whole data.json holding a stranded running record still parses', () => {
    // The point of the running status: a process that dies mid-run leaves a
    // record behind, and the next launch has to be able to load the file.
    const parsed = AppDataSchema.parse({
      ...emptyAppData(),
      scheduledTasks: { st1: task },
      runs: {
        r3: {
          id: 'r3',
          scheduledTaskId: 'st1',
          trigger: 'scheduled',
          startedAt: 40,
          status: 'running',
        },
      },
    }) as AppData;
    expect(parsed.runs.r3?.status).toBe('running');
  });

  test('a finished run without its audit trail is refused, while skipped still needs none', () => {
    // skipped 开始即结束，output 与 toolCalls 都由默认值补上；success / failed 则
    // 必须带着结果落库，否则界面上出现的是"成功但没有输出"。
    expect(
      ScheduledTaskRunSchema.safeParse({
        id: 'r4',
        scheduledTaskId: 'st1',
        trigger: 'scheduled',
        startedAt: 40,
        finishedAt: 50,
        status: 'success',
      }).success,
    ).toBe(false);
    const skipped = ScheduledTaskRunSchema.parse({
      id: 'r5',
      scheduledTaskId: 'st1',
      trigger: 'manual',
      startedAt: 40,
      finishedAt: 40,
      status: 'skipped',
      output: '',
    });
    expect(skipped.toolCalls).toEqual([]);
  });

  test('the type itself refuses a finished run with no finishedAt', () => {
    // 判别联合的价值在这里：schema 之外的代码（runner、service、界面）拿到的类型
    // 就已经写不出这种记录，所以它不可能被顺手造出来。`@ts-expect-error` 在这里
    // 是一条断言——它不再报错时，这个文件会编译失败。
    // @ts-expect-error — 终态必须有结束时点
    const bad: ScheduledTaskRun = {
      id: 'r9',
      scheduledTaskId: 'st1',
      trigger: 'manual',
      startedAt: 1,
      status: 'success',
      output: '',
      toolCalls: [],
    };
    expect(bad.status).toBe('success');
  });

  test('a tool call records tool, args, target, result, duration and time', () => {
    const parsed = ScheduledTaskRunSchema.parse({
      ...run,
      toolCalls: [{ ...toolCall, target: 'api.example.com' }],
    });
    const call = parsed.toolCalls[0];
    expect(call?.toolName).toBe('runCommand');
    expect(call?.target).toBe('api.example.com');
    expect(call?.durationMs).toBe(120);
    expect(call?.at).toBe(5);
  });

  test('newScheduledTaskRun starts out skipped, with the run already closed', () => {
    const r = newScheduledTaskRun('st1', 'manual', 99);
    expect(r.status).toBe('skipped');
    expect(r.finishedAt).toBe(99);
    expect(r.output).toBe('');
  });
});

describe('AppData backfills the scheduled-task records', () => {
  test('a data.json written before the module existed still parses', () => {
    // The two .default({}) fields are what make the module additive: without
    // them every existing user's file would fail validation and fall back to the
    // backup on launch.
    const legacy = emptyAppData() as unknown as Record<string, unknown>;
    delete legacy.scheduledTasks;
    delete legacy.runs;
    const parsed = AppDataSchema.parse(legacy) as AppData;
    expect(parsed.scheduledTasks).toEqual({});
    expect(parsed.runs).toEqual({});
  });

  test('emptyAppData ships both empty', () => {
    const d = emptyAppData();
    expect(d.scheduledTasks).toEqual({});
    expect(d.runs).toEqual({});
  });
});
