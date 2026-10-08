import { describe, expect, test } from 'bun:test';
import { type AppData, emptyAppData, type Task } from '@tiny-schedule/shared';
import type { DataStore } from '../src/main/infra/dataStore';
import { createTaskService } from '../src/main/services/taskService';

const logger = { info: () => {}, error: () => {}, warn: () => {} } as never;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '写代码',
    projectId: 'p1',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
    ...over,
  };
}

/** Timer started at NOW with `elapsedMs` already accumulated, so math is readable. */
function timerAt(now: number, elapsedMs: number) {
  return {
    taskId: 't1',
    startedAt: now - elapsedMs,
    accumulatedMs: 0,
    isPaused: false,
    sessionStartedAt: now - elapsedMs,
  };
}

function setup(tasks: Record<string, Task> = {}, activeTimer: AppData['activeTimer'] = null) {
  const data: AppData = { ...emptyAppData(), tasks, activeTimer };
  const store = {
    get: () => data,
    update: (fn: (c: AppData) => AppData) => {
      Object.assign(data, fn(data));
      return data;
    },
  } as unknown as DataStore;
  return { data, service: createTaskService({ store, logger }) };
}

const NOW = new Date(2026, 8, 8, 12, 0, 0).getTime();

describe('taskService.stopTiming — main-side settlement', () => {
  test('settles the running timer into the task and clears it', () => {
    const { data, service } = setup({ t1: task() }, timerAt(NOW, 60_000));
    const r = service.stopTiming(NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settledMs).toBe(60_000);
    expect(data.activeTimer).toBeNull();
    expect(data.tasks.t1?.timeSpent).toBe(60_000);
    expect(data.tasks.t1?.timeEntries).toHaveLength(1);
  });

  test('rejects when nothing is being timed, handing back the dataset', () => {
    const { data, service } = setup({ t1: task() });
    const r = service.stopTiming(NOW);
    expect(r).toEqual({ ok: false, error: 'NO_ACTIVE_TIMER', data });
  });

  test('drops a timer whose task is gone rather than inventing a task', () => {
    const { data, service } = setup({}, timerAt(NOW, 60_000));
    const r = service.stopTiming(NOW);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: 'TASK_NOT_FOUND' });
    expect(data.activeTimer).toBeNull();
  });

  test('refuses to settle a task other than the one the caller pinned', () => {
    // The renderer's heartbeat sync() can land between its local swap and its
    // stop call. Without the pin, main would settle the *newly started* timer
    // and the previous task's elapsed time would go unbilled.
    const { data, service } = setup({ t1: task(), t2: task({ id: 't2' }) }, timerAt(NOW, 60_000));
    const r = service.stopTiming(NOW, 't2');
    expect(r).toMatchObject({ ok: false, error: 'NO_ACTIVE_TIMER' });
    // Untouched: still running, still unbilled — but on the right session.
    expect(data.activeTimer).not.toBeNull();
    expect(data.tasks.t1?.timeSpent).toBe(0);
  });

  test('settles normally when the pinned task is the one running', () => {
    const { data, service } = setup({ t1: task() }, timerAt(NOW, 60_000));
    const r = service.stopTiming(NOW, 't1');
    expect(r).toMatchObject({ ok: true, settledMs: 60_000 });
    expect(data.activeTimer).toBeNull();
  });

  test('drops (never settles) a timer on an already-done task', () => {
    // The time may already have been recorded; settling again would double-bill.
    const { data, service } = setup(
      { t1: task({ isDone: true, timeSpent: 999 }) },
      timerAt(NOW, 60_000),
    );
    const r = service.stopTiming(NOW);
    expect(r.ok).toBe(false);
    // Distinct from TASK_NOT_FOUND: the row exists, we deliberately refused to
    // bill it, and the renderer has to be able to tell the two apart.
    expect(r).toMatchObject({ error: 'TASK_ALREADY_DONE' });
    expect(data.activeTimer).toBeNull();
    expect(data.tasks.t1?.timeSpent).toBe(999);
  });

  test('a paused timer settles at its own pausedAt, not at the stop instant', () => {
    const pausedAt = NOW - 30_000;
    const { data, service } = setup(
      { t1: task() },
      {
        taskId: 't1',
        startedAt: pausedAt - 60_000,
        accumulatedMs: 60_000,
        isPaused: true,
        pausedAt,
        sessionStartedAt: pausedAt - 60_000,
      },
    );
    const r = service.stopTiming(NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.settledMs).toBe(60_000);
    expect(data.tasks.t1?.timeEntries[0]?.end).toBe(pausedAt);
  });

  test('pomodoro settles focus time only, excluding the break', () => {
    const { data, service } = setup(
      { t1: task() },
      {
        taskId: 't1',
        startedAt: NOW - 120_000,
        accumulatedMs: 300_000,
        isPaused: true,
        pausedAt: NOW,
        sessionStartedAt: NOW - 300_000,
        mode: 'pomodoro',
        phase: 'break',
        phaseStartedAt: NOW - 60_000,
        phaseAccumulatedMs: 60_000,
        phaseDurationMs: 300_000,
        cyclesCompleted: 1,
        focusAccumulatedMs: 240_000,
      },
    );
    const r = service.stopTiming(NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.settledMs).toBe(240_000);
    expect(data.tasks.t1?.timeSpent).toBe(240_000);
  });
});

describe('taskService.settleForQuit — quit path shares the stop rules', () => {
  test('settles and reports the ms recorded', () => {
    const { data, service } = setup({ t1: task() }, timerAt(NOW, 45_000));
    expect(service.settleForQuit(NOW)).toBe(45_000);
    expect(data.activeTimer).toBeNull();
  });

  test('reports 0 and writes nothing when no timer is running', () => {
    const { service } = setup({ t1: task() });
    expect(service.settleForQuit(NOW)).toBe(0);
  });
});

describe('taskService.upsert — ADR-0002 invariant still enforced here', () => {
  test('completing a timed task settles it in the same write', () => {
    const { data, service } = setup({ t1: task() }, timerAt(NOW, 20_000));
    const r = service.upsert(task({ isDone: true }), NOW);
    expect(r.settledMs).toBe(20_000);
    expect(data.activeTimer).toBeNull();
    expect(data.tasks.t1?.timeSpent).toBe(20_000);
  });

  test('re-saving a done task does not settle anything', () => {
    const { data, service } = setup(
      { t1: task({ isDone: true, doneAt: 1 }) },
      timerAt(NOW, 20_000),
    );
    const r = service.upsert(task({ isDone: true, title: '改个名', doneAt: 1 }), NOW);
    expect(r.settledMs).toBe(0);
    expect(data.tasks.t1?.timeSpent).toBe(0);
  });
});

describe('taskService.finishDay', () => {
  test('rolls unfinished tasks due today to tomorrow and stamps lastFinishDay', () => {
    const today = '2026-09-08';
    const { data, service } = setup({
      a: task({ id: 'a', dueDay: today }),
      b: task({ id: 'b', dueDay: today, isDone: true }),
      c: task({ id: 'c', dueDay: '2026-09-09' }),
      d: task({ id: 'd' }),
    });
    service.finishDay(NOW);
    expect(data.tasks.a?.dueDay).toBe('2026-09-09');
    expect(data.tasks.b?.dueDay).toBe(today);
    expect(data.tasks.c?.dueDay).toBe('2026-09-09');
    expect(data.tasks.d?.dueDay).toBeUndefined();
    expect(data.misc.lastFinishDay).toBe(today);
  });
});

describe('taskService.syncTimer', () => {
  test('reports dropped when the timer belongs to a done task', () => {
    const { data, service } = setup({ t1: task({ isDone: true }) }, timerAt(NOW, 1_000));
    const r = service.syncTimer(timerAt(NOW, 1_000));
    expect(r.dropped).toBe(true);
    expect(data.activeTimer).toBeNull();
  });

  test('keeps a timer whose task is still open', () => {
    const { service } = setup({ t1: task() }, timerAt(NOW, 1_000));
    expect(service.syncTimer(timerAt(NOW, 1_000)).dropped).toBe(false);
  });
});
