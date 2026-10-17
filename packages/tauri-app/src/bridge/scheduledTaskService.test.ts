import { describe, expect, test } from 'bun:test';
import {
  type AppData,
  AppDataSchema,
  emptyAppData,
  type FinishedScheduledTaskRun,
  type RunningScheduledTaskRun,
  type ScheduledTask,
  type ScheduledTaskRun,
} from '@tiny-schedule/shared';
import { type AiLogger, silentLogger } from '../ai/logger';
import { DataStore } from './dataStore';
import { joinPath, MemoryFs } from './fsAdapter';
import { createScheduledTaskService, reconcileScheduledTaskRuns } from './scheduledTaskService';

const DIR = '/data';

function makeTask(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    name: `task ${id}`,
    prompt: 'do the thing',
    schedule: { kind: 'daily', time: '09:00' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeRun(
  id: string,
  scheduledTaskId: string,
  overrides: Partial<ScheduledTaskRun> = {},
): ScheduledTaskRun {
  return {
    id,
    scheduledTaskId,
    trigger: 'scheduled',
    startedAt: 10,
    finishedAt: 20,
    status: 'success',
    output: 'ok',
    toolCalls: [],
    ...overrides,
  };
}

/** 开始时落下的那条记录：还没有结束时点，也没有输出。 */
function makeRunningRun(
  id: string,
  scheduledTaskId: string,
  overrides: Partial<RunningScheduledTaskRun> = {},
): RunningScheduledTaskRun {
  return {
    id,
    scheduledTaskId,
    trigger: 'scheduled',
    startedAt: 10,
    status: 'running',
    toolCalls: [],
    ...overrides,
  };
}

/** 收尾时写下的终态记录。 */
function makeFinishedRun(
  id: string,
  scheduledTaskId: string,
  overrides: Partial<FinishedScheduledTaskRun> = {},
): FinishedScheduledTaskRun {
  return {
    id,
    scheduledTaskId,
    trigger: 'scheduled',
    startedAt: 10,
    finishedAt: 20,
    status: 'success',
    output: 'ok',
    toolCalls: [],
    ...overrides,
  };
}

function seedData(overrides: Partial<AppData> = {}): AppData {
  return {
    ...emptyAppData(),
    scheduledTasks: { st1: makeTask('st1') },
    runs: { r1: makeRun('r1', 'st1') },
    ...overrides,
  } as AppData;
}

async function openService(fs: MemoryFs, data: AppData, logger: AiLogger = silentLogger) {
  const store = await DataStore.open(DIR, fs, logger);
  await store.save(data);
  await store.load();
  return createScheduledTaskService({ store, logger });
}

describe('scheduledTaskService — the write side', () => {
  test('upsert stores the whole request and stamps createdAt', async () => {
    const fs = new MemoryFs();
    const service = await openService(fs, seedData({ scheduledTasks: {}, runs: {} }));
    const data = await service.upsert(
      {
        id: 'st9',
        name: '每日汇总',
        prompt: '汇总提交',
        schedule: { kind: 'weekly', daysOfWeek: [1], time: '08:30' },
        workingDirectory: '/repo',
      },
      1_000,
    );
    const stored = data.scheduledTasks.st9;
    expect(stored?.name).toBe('每日汇总');
    expect(stored?.schedule).toEqual({ kind: 'weekly', daysOfWeek: [1], time: '08:30' });
    expect(stored?.workingDirectory).toBe('/repo');
    expect(stored?.enabled).toBe(true);
    expect(stored?.createdAt).toBe(1_000);
    expect(stored?.updatedAt).toBe(1_000);
  });

  test('an edit merges: fields the request omits keep their stored value', async () => {
    // The renderer edits from its render-time snapshot, so a write-back that
    // replaced the record would roll back anything else that changed meanwhile.
    const fs = new MemoryFs();
    const service = await openService(
      fs,
      seedData({ scheduledTasks: { st1: makeTask('st1', { workingDirectory: '/repo' }) } }),
    );
    const data = await service.upsert(
      {
        id: 'st1',
        name: '改名了',
        prompt: 'do the thing',
        schedule: { kind: 'daily', time: '09:00' },
      },
      500,
    );
    const stored = data.scheduledTasks.st1;
    expect(stored?.name).toBe('改名了');
    // enabled and workingDirectory were not in the request, so they stand.
    expect(stored?.enabled).toBe(true);
    expect(stored?.workingDirectory).toBe('/repo');
    // createdAt belongs to the service; the request cannot move it, and
    // updatedAt is stamped on every accepted write rather than inherited.
    expect(stored?.createdAt).toBe(1);
    expect(stored?.updatedAt).toBe(500);
  });

  test('enabled: false stops the task without touching the rest', async () => {
    const fs = new MemoryFs();
    const service = await openService(fs, seedData());
    const data = await service.upsert(
      {
        id: 'st1',
        name: 'task st1',
        prompt: 'do the thing',
        schedule: { kind: 'daily', time: '09:00' },
        enabled: false,
      },
      500,
    );
    expect(data.scheduledTasks.st1?.enabled).toBe(false);
    expect(data.scheduledTasks.st1?.schedule).toEqual({ kind: 'daily', time: '09:00' });
  });

  test('null clears the working directory; omitting it leaves it alone', async () => {
    const fs = new MemoryFs();
    const service = await openService(
      fs,
      seedData({ scheduledTasks: { st1: makeTask('st1', { workingDirectory: '/repo' }) } }),
    );
    const base = {
      id: 'st1',
      name: 'x',
      prompt: 'y',
      schedule: { kind: 'daily' as const, time: '09:00' },
    };
    const kept = await service.upsert({ ...base, workingDirectory: undefined }, 500);
    expect(kept.scheduledTasks.st1?.workingDirectory).toBe('/repo');
    const cleared = await service.upsert({ ...base, workingDirectory: null }, 500);
    expect(Object.hasOwn(cleared.scheduledTasks.st1 ?? {}, 'workingDirectory')).toBe(false);
  });

  test('deleting a task deletes its runs too', async () => {
    // CONTEXT.md: 可删除，删除连同其全部运行. Left behind, the audit record
    // would point at a scheduled task that no longer exists.
    const fs = new MemoryFs();
    const service = await openService(
      fs,
      seedData({
        scheduledTasks: { st1: makeTask('st1'), st2: makeTask('st2') },
        runs: {
          r1: makeRun('r1', 'st1'),
          r2: makeRun('r2', 'st2'),
        },
      }),
    );
    const data = await service.remove('st1');
    expect(Object.hasOwn(data.scheduledTasks, 'st1')).toBe(false);
    expect(Object.hasOwn(data.scheduledTasks, 'st2')).toBe(true);
    expect(Object.hasOwn(data.runs, 'r1')).toBe(false);
    expect(data.runs.r2).toBeDefined();
  });

  test('deleting a task that is not there changes nothing', async () => {
    const fs = new MemoryFs();
    const service = await openService(fs, seedData());
    const data = await service.remove('nope');
    expect(data.scheduledTasks.st1).toBeDefined();
    expect(data.runs.r1).toBeDefined();
  });

  test('appending a run keeps its audit trail', async () => {
    const fs = new MemoryFs();
    const service = await openService(fs, seedData());
    const call = {
      id: 'tc1',
      toolName: 'runCommand',
      argsSummary: 'git log --oneline -20',
      target: '/repo',
      resultSummary: '20 commits',
      durationMs: 120,
      at: 15,
    };
    const data = await service.appendRun(
      makeRun('r2', 'st1', { status: 'failed', error: 'boom', toolCalls: [call] }),
    );
    expect(data.runs.r2?.status).toBe('failed');
    expect(data.runs.r2?.error).toBe('boom');
    expect(data.runs.r2?.toolCalls).toEqual([call]);
  });

  test('a run naming a task that does not exist is not stored', async () => {
    // Not reachable on a normal path (the delete cascades), so reaching it means
    // the write order broke. Storing it would leave an audit record with no
    // answer to "what was this, and who scheduled it".
    const fs = new MemoryFs();
    const service = await openService(fs, seedData());
    const data = await service.appendRun(makeRun('r9', 'ghost'));
    expect(Object.hasOwn(data.runs, 'r9')).toBe(false);
  });

  test('runs are listed per task, newest first', async () => {
    const fs = new MemoryFs();
    const service = await openService(
      fs,
      seedData({
        runs: {
          r1: makeRun('r1', 'st1', { startedAt: 10 }),
          r2: makeRun('r2', 'st1', { startedAt: 30 }),
          r3: makeRun('r3', 'st2', { startedAt: 20 }),
        },
      }),
    );
    expect((await service.listRuns('st1')).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect((await service.listRuns('st2')).map((r) => r.id)).toEqual(['r3']);
    expect(await service.listRuns('ghost')).toEqual([]);
  });

  test('the delete cascade reaches the disk, not just the cache', async () => {
    const fs = new MemoryFs();
    const service = await openService(fs, seedData());
    await service.remove('st1');
    const reopened = await DataStore.open(DIR, fs);
    const reloaded = await reopened.load();
    expect(Object.hasOwn(reloaded.scheduledTasks, 'st1')).toBe(false);
    expect(Object.hasOwn(reloaded.runs, 'r1')).toBe(false);
  });

  test('the written dataset still satisfies AppDataSchema', async () => {
    // The store validates on save; asserting the shape here means a schema
    // regression surfaces as a naming failure instead of a store error path.
    const fs = new MemoryFs();
    const service = await openService(fs, seedData({ scheduledTasks: {}, runs: {} }));
    await service.upsert({
      id: 'st1',
      name: 'x',
      prompt: 'y',
      schedule: { kind: 'monthly', dayOfMonth: 31, time: '23:59' },
    });
    const data = await service.appendRun(
      makeRun('r1', 'st1', {
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'httpRequest',
            argsSummary: 'GET https://example.com',
            target: 'example.com',
            resultSummary: '200',
            durationMs: 80,
            at: 15,
          },
        ],
      }),
    );
    expect(() => AppDataSchema.parse(data)).not.toThrow();
    expect(AppDataSchema.parse(data).scheduledTasks.st1?.schedule).toEqual({
      kind: 'monthly',
      dayOfMonth: 31,
      time: '23:59',
    });
  });
});

describe('finalizeRun — running → 终态，且只朝这一个方向', () => {
  test('the running record is rewritten in place, with output and the whole audit', async () => {
    // CONTEXT.md：运行从开始就落库。So the write side is no longer append-only —
    // the one rewrite it accepts is the one that turns "started" into "finished",
    // and it must carry everything the running record could not have.
    const fs = new MemoryFs();
    const service = await openService(
      fs,
      seedData({ runs: { r1: makeRun('r1', 'st1'), r2: makeRunningRun('r2', 'st1') } }),
    );
    const call = {
      id: 'tc1',
      toolName: 'runCommand',
      argsSummary: 'git log',
      target: '/repo',
      resultSummary: '2 commits',
      durationMs: 90,
      at: 15,
    };
    const data = await service.finalizeRun(
      makeFinishedRun('r2', 'st1', { toolCalls: [call], output: '汇总完成' }),
    );
    const stored = data.runs.r2;
    expect(stored?.status).toBe('success');
    expect(stored?.output).toBe('汇总完成');
    expect(stored?.toolCalls).toEqual([call]);
    expect(stored?.finishedAt).toBe(20);
    // 同一个 id、同一段 startedAt：改写不是新增一条，也不是重新开始一次运行。
    expect(stored?.startedAt).toBe(10);
    expect(Object.keys(data.runs)).toEqual(['r1', 'r2']);
  });

  test('a terminal record is never rewritten — a repeated finish is a no-op', async () => {
    // 审计记录能改写就不再是追溯手段（ADR-0008）。So the guard is one-directional:
    // finishing an already-finished run changes nothing, rather than overwriting
    // an outcome a user has already read.
    const fs = new MemoryFs();
    const service = await openService(fs, seedData({ runs: { r1: makeRun('r1', 'st1') } }));
    const data = await service.finalizeRun(
      makeFinishedRun('r1', 'st1', { status: 'failed', error: 'boom', output: 'later words' }),
    );
    expect(data.runs.r1?.status).toBe('success');
    expect(data.runs.r1?.output).toBe('ok');
  });

  test('finishing a run whose start write never landed still records the outcome', async () => {
    // 开始那一次写失败时（磁盘满、store 拒写），手上这条终态记录是这次执行仅剩的
    // 痕迹——丢掉它比多一条更糟。
    const fs = new MemoryFs();
    const service = await openService(fs, seedData());
    const data = await service.finalizeRun(makeFinishedRun('r7', 'st1'));
    expect(data.runs.r7?.status).toBe('success');
  });

  test('a finished run naming a task that does not exist is not stored', async () => {
    const fs = new MemoryFs();
    const service = await openService(fs, seedData());
    const data = await service.finalizeRun(makeFinishedRun('r9', 'ghost'));
    expect(Object.hasOwn(data.runs, 'r9')).toBe(false);
  });

  test('the running record passes the dataset schema all the same', async () => {
    // Every save validates; a running record that the schema rejected would mean
    // a started run silently vanishing on its way to disk.
    const fs = new MemoryFs();
    const service = await openService(fs, seedData({ runs: { r2: makeRunningRun('r2', 'st1') } }));
    const data = await service.appendRun(makeRunningRun('r3', 'st1', { trigger: 'manual' }));
    expect(() => AppDataSchema.parse(data)).not.toThrow();
    expect(AppDataSchema.parse(data).runs.r3?.status).toBe('running');
  });
});

describe('reconcileInterruptedRuns — 启动对账，仿 isOfflineResume', () => {
  const seed = (runs: Record<string, ScheduledTaskRun>): AppData =>
    seedData({ scheduledTasks: { st1: makeTask('st1'), st2: makeTask('st2') }, runs });

  test('a stranded running record becomes interrupted, closed at the reconcile moment', async () => {
    // 进程在运行途中死掉：磁盘上剩下一条 running。启动对账把它改成 interrupted，
    // finishedAt 取对账时刻——那才是"这条不会再动了"的最早时刻。
    const fs = new MemoryFs();
    const service = await openService(
      fs,
      seed({
        r1: makeRun('r1', 'st1'),
        r2: makeRunningRun('r2', 'st1'),
      }),
    );
    const data = await service.reconcileInterruptedRuns(1_000);
    const stranded = data.runs.r2;
    expect(stranded?.status).toBe('interrupted');
    expect(stranded?.finishedAt).toBe(1_000);
    expect(stranded?.output).toBe('');
    expect(stranded?.error).toContain('进程在运行中结束');
    expect(stranded?.startedAt).toBe(10);
  });

  test('it only touches running records — a settled history is left alone', async () => {
    const fs = new MemoryFs();
    const service = await openService(
      fs,
      seed({
        r1: makeRun('r1', 'st1'),
        r2: makeRun('r2', 'st1', { status: 'skipped', startedAt: 11, finishedAt: 11 }),
        r3: makeFinishedRun('r3', 'st1', { status: 'interrupted', startedAt: 12, finishedAt: 30 }),
      }),
    );
    const data = await service.reconcileInterruptedRuns(1_000);
    expect(data.runs.r1?.finishedAt).toBe(20);
    expect(data.runs.r2?.finishedAt).toBe(11);
    // 上一次对账留下的 interrupted 也不会被再改一次时刻。
    expect(data.runs.r3?.finishedAt).toBe(30);
  });

  test('running it twice changes nothing the second time', async () => {
    // 幂等是敢在每次启动时跑的原因：热重载、未来的重新初始化都会再调一次。
    const fs = new MemoryFs();
    const service = await openService(fs, seed({ r2: makeRunningRun('r2', 'st1') }));
    const first = await service.reconcileInterruptedRuns(1_000);
    const second = await service.reconcileInterruptedRuns(2_000);
    expect(second.runs.r2?.finishedAt).toBe(1_000);
    expect(second.runs).toEqual(first.runs);
  });

  test('with nothing stranded it does not write at all', async () => {
    // 没有 running 时连一次写盘都不该发生：启动路径上任何多余的写入都是留给用户的
    // 风险（数据量小的用户恰恰是最容易被 guard 拦下的那批）。
    const fs = new MemoryFs();
    const service = await openService(fs, seed({ r1: makeRun('r1', 'st1') }));
    const before = await service.listRuns('st1');
    const writesBefore = fs.calls.filter((c) => c.startsWith('writeText')).length;
    await service.reconcileInterruptedRuns(1_000);
    expect(await service.listRuns('st1')).toEqual(before);
    expect(fs.calls.filter((c) => c.startsWith('writeText'))).toHaveLength(writesBefore);
  });

  test('reconciliation reaches the disk, so the next launch has nothing to sweep', async () => {
    const fs = new MemoryFs();
    const service = await openService(fs, seed({ r2: makeRunningRun('r2', 'st1') }));
    await service.reconcileInterruptedRuns(1_000);
    const reopened = await DataStore.open(DIR, fs);
    const reloaded = await reopened.load();
    expect(reloaded.runs.r2?.status).toBe('interrupted');
  });

  test('reconcileScheduledTaskRuns is the bootstrap entry point and does the same thing', async () => {
    const fs = new MemoryFs();
    const store = await DataStore.open(DIR, fs);
    await store.save(seed({ r2: makeRunningRun('r2', 'st1') }));
    await store.load();
    const data = await reconcileScheduledTaskRuns(store, silentLogger);
    expect(data.runs.r2?.status).toBe('interrupted');
    expect(data.runs.r2?.error).toContain('进程在运行中结束');
  });
});
