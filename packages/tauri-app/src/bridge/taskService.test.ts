import { describe, expect, test } from 'bun:test';
import {
  type ActiveTimer,
  type AppData,
  emptyAppData,
  localDate,
  type TimingStopResult,
} from '@tiny-schedule/shared';
import { type AiLogger, silentLogger } from '@/ai/logger';
import { joinPath, MemoryFs } from '@/bridge/fsAdapter';
import { DataStore } from './dataStore';
import { createTaskService } from './taskService';

const DIR = '/data';

function dataPath(): string {
  return joinPath(DIR, 'data.json');
}

function backupPath(generation: number): string {
  return joinPath(DIR, `data.backup.${generation}.json`);
}

function makeTask(id: string, overrides: Partial<AppData['tasks'][string]> = {}) {
  return {
    id,
    title: `task ${id}`,
    projectId: 'inbox',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
    ...overrides,
  } as AppData['tasks'][string];
}

function makeTimer(overrides: Partial<ActiveTimer> = {}): ActiveTimer {
  return {
    taskId: 't1',
    startedAt: 1_000,
    accumulatedMs: 0,
    isPaused: false,
    ...overrides,
  };
}

function seedData(overrides: Partial<AppData> = {}): AppData {
  return {
    ...emptyAppData(),
    tasks: { t1: makeTask('t1'), t2: makeTask('t2') },
    ...overrides,
  } as AppData;
}

/** A store over a `data.json` that already holds `data`, so `get()` is a cache hit. */
async function storeOver(data: AppData, logger: AiLogger = silentLogger) {
  const fs = new MemoryFs({ [dataPath()]: JSON.stringify(data) });
  const store = await DataStore.open(DIR, fs, logger);
  await store.load();
  return { fs, store, service: createTaskService({ store, logger }) };
}

/** Records every log line so the drop/refusal paths can be asserted directly. */
function recordingLogger(): AiLogger & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    info: (payload) => lines.push(payload),
    warn: (payload) => lines.push(payload),
    error: (payload) => lines.push(payload),
  };
}

/**
 * Narrow to the domain-rejection branch that carries a dataset.
 *
 * `!result.ok` alone does not get there: WRITE_REFUSED is also not-ok and
 * deliberately carries none, so the assertion below is only meaningful if the
 * test really did land on a rejection that wrote something. Throwing instead
 * of returning undefined keeps a drifting branch from reading as a passing
 * assertion on `undefined`.
 */
type RejectedWithData = Extract<TimingStopResult, { ok: false; data: AppData }>;

function rejectedWithData(result: TimingStopResult): RejectedWithData {
  if (result.ok || !('data' in result)) {
    throw new Error(
      `expected a domain rejection carrying data, got ${result.ok ? 'ok' : result.error}`,
    );
  }
  return result;
}

describe('taskService.stopTiming — the settlement', () => {
  test('settles a running timer into its task and reports the ms recorded', async () => {
    const now = 61_000;
    const { store, service } = await storeOver(seedData({ activeTimer: makeTimer() }));

    const result = await service.stopTiming(now);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected a settlement, got ${result.error}`);
    expect(result.settledMs).toBe(now - 1_000);
    // The authoritative answer, not a prediction: the caller reports what the
    // store actually recorded.
    expect(result.data.tasks.t1?.timeSpent).toBe(60_000);
    expect(result.data.tasks.t1?.timeEntries).toHaveLength(1);
    expect(result.data.activeTimer).toBeNull();
    // One write, and it is the transition that both bills and clears: an
    // interruption between the two would leave a settled task whose
    // activeTimer still points at it, which is the double-billing case.
    expect((await store.get()).tasks.t1?.timeSpentOnDay[localDate(now)]).toBe(60_000);
  });

  test('a paused timer banks only the segments before the pause', async () => {
    const { service } = await storeOver(
      seedData({
        activeTimer: makeTimer({ accumulatedMs: 30_000, isPaused: true, pausedAt: 31_000 }),
      }),
    );

    const result = await service.stopTiming(500_000);

    expect(result.ok && result.settledMs).toBe(30_000);
  });

  test('a stop of zero length records no entry and no day key', async () => {
    // The same millisecond start and stop. Without the guard this appends a
    // phantom TimeEntry and a zero-valued timeSpentOnDay key — and those two
    // are exactly what the worklog and the delete-confirmation dialog read to
    // decide "this task has recorded time".
    const { service } = await storeOver(seedData({ activeTimer: makeTimer({ startedAt: 1_000 }) }));

    const result = await service.stopTiming(1_000);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected a settlement, got ${result.error}`);
    expect(result.settledMs).toBe(0);
    expect(result.data.tasks.t1?.timeEntries).toHaveLength(0);
    expect(result.data.tasks.t1?.timeSpentOnDay).toEqual({});
    expect(result.data.activeTimer).toBeNull();
  });

  test('banked accumulatedMs survives a pause/resume across segments', async () => {
    const { service } = await storeOver(
      seedData({
        activeTimer: makeTimer({
          accumulatedMs: 10_000,
          startedAt: 50_000,
          sessionStartedAt: 1_000,
        }),
      }),
    );

    const result = await service.stopTiming(80_000);

    expect(result.ok && result.settledMs).toBe(40_000);
  });
});

describe('taskService.stopTiming — the rejection branches', () => {
  test('no timer on record is NO_ACTIVE_TIMER and carries the data', async () => {
    const { service } = await storeOver(seedData());

    const result = await service.stopTiming();

    const rejected = rejectedWithData(result);
    expect(rejected.error).toBe('NO_ACTIVE_TIMER');
    // The data is the caller's convergence state; a branch without it would
    // leave the renderer showing a timer that was never there.
    expect(rejected.data.tasks.t1?.timeSpent).toBe(0);
  });

  test('a timer for another task is TIMER_MISMATCH, not NO_ACTIVE_TIMER', async () => {
    // The distinction is the whole point: NO_ACTIVE_TIMER tells the caller
    // nothing was running, while here a real session is still accruing on
    // someone else's task. Collapsing the two reported "nothing happened" for
    // a stop that declined to bill an interval that is still being counted.
    const { fs, store, service } = await storeOver(
      seedData({ activeTimer: makeTimer({ taskId: 't2' }) }),
    );
    fs.calls.length = 0;

    const result = await service.stopTiming(61_000, 't1');

    const rejected = rejectedWithData(result);
    expect(rejected.error).toBe('TIMER_MISMATCH');
    expect(rejected.data.activeTimer?.taskId).toBe('t2');
    // Declined, not declined-and-dropped: the running session must survive.
    expect((await store.get()).activeTimer?.taskId).toBe('t2');
    expect((await store.get()).tasks.t2?.timeSpent).toBe(0);
    // A read-only answer: nothing was written on the way to refusing.
    expect(fs.calls.some((c) => c.startsWith('writeText'))).toBe(false);
  });

  test('the expected taskId matches, so the timer is settled as asked', async () => {
    const { service } = await storeOver(seedData({ activeTimer: makeTimer({ taskId: 't1' }) }));

    const result = await service.stopTiming(61_000, 't1');

    expect(result.ok && result.settledMs).toBe(60_000);
  });

  test('a timer whose task is gone is TASK_NOT_FOUND, and the drop is persisted', async () => {
    const logger = recordingLogger();
    const { store, service } = await storeOver(
      seedData({ tasks: {}, activeTimer: makeTimer({ taskId: 'ghost' }) }),
      logger,
    );

    const result = await service.stopTiming(61_000);

    const rejected = rejectedWithData(result);
    expect(rejected.error).toBe('TASK_NOT_FOUND');
    // Carries the *persisted* dataset, because the drop did land — a caller
    // that adopts this converges on the same state a fresh load would see.
    expect(rejected.data.activeTimer).toBeNull();
    expect((await store.get()).activeTimer).toBeNull();
    expect(logger.lines).toContainEqual({
      action: 'timer:drop:stop',
      taskId: 'ghost',
      reason: 'not-found',
    });
  });

  test('a timer on a done task is TASK_ALREADY_DONE, distinct from not-found', async () => {
    // Distinct because the row exists and the refusal was deliberate: its time
    // may already have been settled. Conflating the two with TASK_NOT_FOUND
    // told the renderer "nothing to stop" for a stop that threw the session
    // away, and the unbilled interval was lost.
    const logger = recordingLogger();
    const { store, service } = await storeOver(
      seedData({
        tasks: { t1: makeTask('t1', { isDone: true, timeSpent: 90_000 }) },
        activeTimer: makeTimer(),
      }),
      logger,
    );

    const result = await service.stopTiming(61_000);

    const rejected = rejectedWithData(result);
    expect(rejected.error).toBe('TASK_ALREADY_DONE');
    expect(rejected.data.activeTimer).toBeNull();
    expect((await store.get()).activeTimer).toBeNull();
    // Nothing was billed a second time.
    expect((await store.get()).tasks.t1?.timeSpent).toBe(90_000);
    expect(logger.lines).toContainEqual({
      action: 'timer:drop:stop',
      taskId: 't1',
      reason: 'task-done',
    });
  });
});

describe('taskService.stopTiming — a refused write is not a settlement', () => {
  test('WRITE_REFUSED carries no data, because nothing happened at all', async () => {
    // A truncated data.json latches the store read-only. The mutation is
    // computed and thrown away, so there is no dataset the caller could
    // legitimately adopt: handing back the degraded fallback is how a dropped
    // write gets reported as a success.
    const logger = recordingLogger();
    const fs = new MemoryFs({
      [dataPath()]: '{"version":1,"tasks":{"t1":{"titl',
      // The fallback the store loads, carrying the timer the caller will find.
      [backupPath(1)]: JSON.stringify(seedData({ activeTimer: makeTimer() })),
    });
    const store = await DataStore.open(DIR, fs, logger);
    const service = createTaskService({ store, logger });
    await store.load();

    const result = await service.stopTiming(61_000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toBe('WRITE_REFUSED');
    expect('data' in result).toBe(false);
    // The one line that says the interval was lost, with the ms it would have
    // been — which is why it is recomputed rather than read off `settledMs`.
    expect(logger.lines).toContainEqual({
      action: 'timer:settle:refused',
      taskId: 't1',
      ms: 60_000,
      note: 'the settlement was discarded; nothing was written to disk',
    });
    // The unreadable file is left exactly as the user left it.
    expect(await fs.readText(dataPath())).toBe('{"version":1,"tasks":{"t1":{"titl');
  });

  test('a refused drop does not report itself as a persisted rejection', async () => {
    // The TASK_NOT_FOUND / TASK_ALREADY_DONE branches carry data *because* the
    // drop was written. When the write is refused those branches must not run
    // either — but the drop is a single update() whose persisted flag is what
    // distinguishes them, so the refusal is checked on the settlement path
    // only. Asserted here as the guard it is: the store stays read-only and
    // the file is untouched rather than being overwritten with the fallback.
    const fs = new MemoryFs({
      [dataPath()]: '{"version":1,"tasks":{"t1":{"titl',
      [backupPath(1)]: JSON.stringify(
        seedData({ tasks: { t1: makeTask('t1', { isDone: true }) }, activeTimer: makeTimer() }),
      ),
    });
    const store = await DataStore.open(DIR, fs);
    const service = createTaskService({ store });
    await store.load();

    await service.stopTiming(61_000);

    expect(store.isWritable).toBe(false);
    expect(await fs.readText(dataPath())).toBe('{"version":1,"tasks":{"t1":{"titl');
  });
});

describe('taskService.settleForQuit', () => {
  test('reports the ms it settled, so the quit path has an answer to log', async () => {
    const { store, service } = await storeOver(seedData({ activeTimer: makeTimer() }));

    expect(await service.settleForQuit(61_000)).toBe(60_000);
    expect((await store.get()).activeTimer).toBeNull();
  });

  test('reports 0 for every rejection branch — the quit path has no caller to notify', async () => {
    const noTimer = await storeOver(seedData());
    expect(await noTimer.service.settleForQuit()).toBe(0);

    const doneTask = await storeOver(
      seedData({ tasks: { t1: makeTask('t1', { isDone: true }) }, activeTimer: makeTimer() }),
    );
    expect(await doneTask.service.settleForQuit(61_000)).toBe(0);
    // The drop still happened: the timer is what the quit path has to leave
    // behind clean, and 0 is the "nothing was billed" report, not a no-op.
    expect((await doneTask.store.get()).activeTimer).toBeNull();
  });

  test('stays callable after destructuring, which is how the quit path uses it', async () => {
    // The reason stopTiming is a closure and not an object method: this is
    // called from the quit handler with no receiver, and a `this`-bound method
    // would throw there and leave the app unquittable with a timer running.
    const { service } = await storeOver(seedData({ activeTimer: makeTimer() }));
    const { settleForQuit } = service;

    expect(await settleForQuit(61_000)).toBe(60_000);
  });
});
