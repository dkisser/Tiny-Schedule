import { describe, expect, test } from 'bun:test';
import { completeTask } from '../src/completeTask';
import type { ActiveTimer, Task } from '../src/models';
import {
  advancePomodoroPhase,
  POMODORO_BREAK_MS,
  POMODORO_FOCUS_MS,
  pauseTimer,
  startPomodoroFocus,
  startTimer,
} from '../src/timer';

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
