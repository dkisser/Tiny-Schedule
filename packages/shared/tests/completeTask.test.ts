import { describe, expect, test } from 'bun:test';
import type { AppData } from '../src/domain/appData';
import type { ActiveTimer, Task } from '../src/domain/task';
import {
  advancePomodoroPhase,
  completeTask,
  dropStaleTiming,
  POMODORO_BREAK_MS,
  POMODORO_FOCUS_MS,
  pauseTimer,
  startPomodoroFocus,
  startTimer,
  upsertTaskWithTiming,
} from '../src/domain/task';

const T0 = 1_785_700_000_000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '写文档',
    projectId: 'p',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: T0,
    ...overrides,
  };
}

describe('completeTask', () => {
  test('marks done and stops the running timer on that task', () => {
    const r = completeTask(task(), startTimer('t1', T0), T0 + 90_000);
    expect(r.task.isDone).toBe(true);
    expect(r.task.doneAt).toBe(T0 + 90_000);
    expect(r.timer).toBeNull();
    expect(r.settlement?.ms).toBe(90_000);
    expect(r.task.timeSpent).toBe(90_000);
  });

  // The reported bug: the task showed as done while its timer kept running.
  test('leaves no running timer for a task that is now done', () => {
    const r = completeTask(task(), startTimer('t1', T0), T0 + 60_000);
    expect(r.timer?.taskId).toBeUndefined();
  });

  test('writes a single time entry settled at the completion instant', () => {
    const r = completeTask(task(), startTimer('t1', T0), T0 + 30_000);
    expect(r.task.timeEntries).toHaveLength(1);
    expect(r.task.timeEntries[0]?.end).toBe(T0 + 30_000);
    expect(r.task.timeSpentOnDay[r.task.timeEntries[0]!.date]).toBe(30_000);
  });

  test('freezes at the completion instant, not at confirm time', () => {
    // The dialog pauses on open; a long deliberation must not be billed.
    const opened = pauseTimer(startTimer('t1', T0), T0 + 90_000);
    const r = completeTask(task(), opened, T0 + 900_000);
    expect(r.settlement?.ms).toBe(90_000);
    expect(r.settlement?.entry.end).toBe(T0 + 90_000);
  });

  test('an already-paused timer settles at its own pausedAt', () => {
    const paused = pauseTimer(startTimer('t1', T0), T0 + 45_000);
    const r = completeTask(task(), paused, T0 + 600_000);
    expect(r.settlement?.ms).toBe(45_000);
    expect(r.settlement?.entry.end).toBe(T0 + 45_000);
  });

  test('leaves a timer on a different task running', () => {
    const other = startTimer('t2', T0);
    const r = completeTask(task(), other, T0 + 90_000);
    expect(r.timer).toBe(other);
    expect(r.settlement).toBeNull();
    expect(r.task.timeSpent).toBe(0);
    expect(r.task.isDone).toBe(true);
  });

  test('completes cleanly with no timer at all', () => {
    const r = completeTask(task(), null, T0 + 90_000);
    expect(r.task.isDone).toBe(true);
    expect(r.task.timeEntries).toHaveLength(0);
    expect(r.timer).toBeNull();
  });

  test('preserves history already on the task', () => {
    const existing = { date: '2026-08-04', start: T0, end: T0 + 5_000, ms: 5_000 };
    const r = completeTask(
      task({ timeSpent: 5_000, timeSpentOnDay: { '2026-08-04': 5_000 }, timeEntries: [existing] }),
      startTimer('t1', T0),
      T0 + 65_000,
    );
    expect(r.task.timeEntries).toHaveLength(2);
    expect(r.task.timeSpent).toBe(70_000);
  });

  test('does not mutate the input task', () => {
    const t = task();
    completeTask(t, startTimer('t1', T0), T0 + 90_000);
    expect(t.isDone).toBe(false);
    expect(t.timeSpent).toBe(0);
    expect(t.timeEntries).toHaveLength(0);
  });

  describe('pomodoro', () => {
    test('mid-set completion keeps only focus time, discarding the break', () => {
      let t: ActiveTimer = startPomodoroFocus('t1', T0);
      t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS).next; // → break
      const duringBreak = T0 + POMODORO_FOCUS_MS + 60_000; // 1 min into the break
      const r = completeTask(task(), t, duringBreak);
      expect(r.settlement?.ms).toBe(POMODORO_FOCUS_MS);
      expect(r.timer).toBeNull();
    });

    test('mid-set completion is allowed and counts the running focus phase', () => {
      let t: ActiveTimer = startPomodoroFocus('t1', T0);
      t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS).next;
      t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS + POMODORO_BREAK_MS).next; // → focus 2
      const partial = T0 + POMODORO_FOCUS_MS + POMODORO_BREAK_MS + 600_000;
      const r = completeTask(task(), t, partial);
      expect(r.settlement?.ms).toBe(POMODORO_FOCUS_MS + 600_000);
    });

    test('a zero-length session ends the timer without an empty entry', () => {
      const r = completeTask(task(), startPomodoroFocus('t1', T0), T0);
      expect(r.timer).toBeNull();
      expect(r.settlement).toBeNull();
      expect(r.task.timeEntries).toHaveLength(0);
      expect(r.task.isDone).toBe(true);
    });
  });
});

function dataOf(t: Task, activeTimer: ActiveTimer | null = null): AppData {
  return { tasks: { [t.id]: t }, activeTimer } as unknown as AppData;
}

describe('upsertTaskWithTiming', () => {
  test('completing a timed task settles it and clears the timer in one transition', () => {
    const d = dataOf(task(), startTimer('t1', T0));
    const r = upsertTaskWithTiming(d, { ...task(), isDone: true }, T0 + 90_000);
    expect(r.data.tasks.t1?.isDone).toBe(true);
    expect(r.data.activeTimer).toBeNull();
    expect(r.settledMs).toBe(90_000);
    expect(r.data.tasks.t1?.timeEntries).toHaveLength(1);
  });

  // The regression from code review: a settle-then-clear pair of writes leaves
  // a done, already-recorded task still holding the timer, and recovery then
  // records the same span a second time.
  test('the result can never be a done task still holding its own timer', () => {
    const d = dataOf(task(), startTimer('t1', T0));
    const r = upsertTaskWithTiming(d, { ...task(), isDone: true }, T0 + 90_000);
    expect(r.data.tasks[r.data.tasks.t1!.id]?.isDone).toBe(true);
    expect(r.data.activeTimer?.taskId).not.toBe('t1');
  });

  test('completing an un-timed task records nothing and leaves other timing alone', () => {
    const d = dataOf(task(), null);
    const r = upsertTaskWithTiming(d, { ...task(), isDone: true }, T0 + 90_000);
    expect(r.settledMs).toBe(0);
    expect(r.data.tasks.t1?.timeEntries).toHaveLength(0);
    expect(r.data.activeTimer).toBeNull();
  });

  test('completing a task leaves a timer on a different task running', () => {
    const other = startTimer('t2', T0);
    const r = upsertTaskWithTiming(dataOf(task(), other), { ...task(), isDone: true }, T0 + 90_000);
    expect(r.data.activeTimer).toBe(other);
    expect(r.settledMs).toBe(0);
  });

  test('re-saving an already-done task does not touch the timer', () => {
    const other = startTimer('t2', T0);
    const done = { ...task(), isDone: true, doneAt: T0 + 1000 };
    const r = upsertTaskWithTiming(dataOf(done, other), { ...done, title: '改名' }, T0 + 90_000);
    expect(r.data.activeTimer).toBe(other);
    expect(r.settledMs).toBe(0);
  });

  test('un-completing clears doneAt and does not disturb timing', () => {
    const other = startTimer('t2', T0);
    const done = { ...task(), isDone: true, doneAt: T0 + 1000 };
    const r = upsertTaskWithTiming(dataOf(done, other), { ...done, isDone: false }, T0 + 90_000);
    expect(r.data.tasks.t1?.isDone).toBe(false);
    expect(r.data.tasks.t1?.doneAt).toBeUndefined();
    expect(r.data.activeTimer).toBe(other);
  });

  test('normalizes doneAt on completion and keeps a supplied one', () => {
    const supplied = T0 + 5000;
    const a = upsertTaskWithTiming(dataOf(task()), { ...task(), isDone: true }, T0 + 90_000);
    expect(a.data.tasks.t1?.doneAt).toBe(T0 + 90_000);
    const b = upsertTaskWithTiming(
      dataOf(task()),
      { ...task(), isDone: true, doneAt: supplied },
      T0 + 90_000,
    );
    expect(b.data.tasks.t1?.doneAt).toBe(supplied);
  });

  test('preserves other tasks and the pomodoro focus-only rule', () => {
    let pom: ActiveTimer = startPomodoroFocus('t1', T0);
    pom = advancePomodoroPhase(pom, T0 + POMODORO_FOCUS_MS).next; // → break
    const base = dataOf(task(), pom);
    const withOther = { ...base, tasks: { ...base.tasks, t9: { ...task(), id: 't9' } } };
    const r = upsertTaskWithTiming(
      withOther,
      { ...task(), isDone: true },
      T0 + POMODORO_FOCUS_MS + 60_000,
    );
    expect(r.settledMs).toBe(POMODORO_FOCUS_MS);
    expect(r.data.tasks.t9?.isDone).toBe(false);
    expect(r.data.activeTimer).toBeNull();
  });

  test('a non-completing write also sweeps a stale timer on a done task', () => {
    // N1: re-saving an already-done task must not leave it being timed, even
    // when the renderer's copy had not caught up and believed it was open.
    const done = { ...task(), isDone: true, doneAt: T0 + 1000 };
    const r = upsertTaskWithTiming(
      dataOf(done, startTimer('t1', T0)),
      { ...done, title: '改名' },
      T0 + 90_000,
    );
    expect(r.settledMs).toBe(0);
    expect(r.data.activeTimer).toBeNull();
    expect(r.data.tasks.t1?.timeSpent).toBe(0);
  });

  test('an already-done task keeps its original doneAt instead of sliding to now', () => {
    // N3: sliding doneAt would change which days it counts as done on.
    const done = { ...task(), isDone: true, doneAt: T0 + 1000 };
    const r = upsertTaskWithTiming(dataOf(done), { ...done, doneAt: undefined }, T0 + 90_000);
    expect(r.data.tasks.t1?.doneAt).toBe(T0 + 1000);
  });

  test('settledMs reports what was recorded, 0 when nothing was', () => {
    const timed = upsertTaskWithTiming(
      dataOf(task(), startTimer('t1', T0)),
      { ...task(), isDone: true },
      T0 + 90_000,
    );
    expect(timed.settledMs).toBe(90_000);
    const untimed = upsertTaskWithTiming(dataOf(task()), { ...task(), isDone: true }, T0 + 90_000);
    expect(untimed.settledMs).toBe(0);
  });

  test('completing an untimed task also sweeps a done task left holding the timer', () => {
    // `result.timer` is the *other* task's timer on this path, and that task
    // may already be done: an import keeps the current activeTimer while
    // letting an imported task win an id collision.
    const done = { ...task(), id: 't1', isDone: true, doneAt: T0 + 1000 };
    const other = { ...task(), id: 't2' };
    const r = upsertTaskWithTiming(
      { tasks: { t1: done, t2: other }, activeTimer: startTimer('t1', T0) } as unknown as AppData,
      { ...other, isDone: true },
      T0 + 90_000,
    );
    expect(r.settledMs).toBe(0);
    expect(r.data.tasks.t2?.isDone).toBe(true);
    expect(r.data.activeTimer).toBeNull();
  });

  test('completing an untimed task still keeps a live timer on an open task', () => {
    const open = { ...task(), id: 't9' };
    const other = startTimer('t9', T0);
    const r = upsertTaskWithTiming(
      { tasks: { t2: task(), t9: open }, activeTimer: other } as unknown as AppData,
      { ...task(), id: 't2', isDone: true },
      T0 + 90_000,
    );
    expect(r.data.activeTimer).toBe(other);
  });

  test('an unknown task id is a no-op rather than a crash', () => {
    const d = dataOf(task());
    const r = upsertTaskWithTiming(d, { ...task(), id: 'nope', isDone: true }, T0 + 1000);
    expect(r.data.tasks.t1?.isDone).toBe(false);
    expect(r.settledMs).toBe(0);
  });
});

describe('dropStaleTiming', () => {
  test('clears a timer left on an already-done task', () => {
    const done = { ...task(), isDone: true, doneAt: T0 };
    const clean = dropStaleTiming(dataOf(done, startTimer('t1', T0)));
    expect(clean.activeTimer).toBeNull();
  });

  // Clearing rather than settling: the time behind a dangling timer may already
  // have been recorded, and settling on that guess would double-bill it.
  test('clears without touching the task, so nothing is recorded twice', () => {
    const done = { ...task(), isDone: true, doneAt: T0, timeSpent: 90_000 };
    const clean = dropStaleTiming(dataOf(done, startTimer('t1', T0)));
    expect(clean.tasks.t1?.timeSpent).toBe(90_000);
    expect(clean.tasks.t1?.timeEntries).toHaveLength(0);
  });

  test('leaves a running timer alone', () => {
    const d = dataOf(task(), startTimer('t1', T0));
    expect(dropStaleTiming(d)).toBe(d);
  });

  test('leaves no-timer data alone', () => {
    const d = dataOf(task());
    expect(dropStaleTiming(d)).toBe(d);
  });
});
