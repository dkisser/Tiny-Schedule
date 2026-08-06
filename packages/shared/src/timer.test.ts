import { describe, expect, test } from 'bun:test';
import type { Task } from './models';
import {
  addDays,
  applySettlement,
  computeElapsed,
  localDate,
  pauseTimer,
  resumeTimer,
  settleTimer,
  startTimer,
} from './timer';

const T0 = 1_785_700_000_000;

describe('timer transitions', () => {
  test('start creates fresh timer', () => {
    const t = startTimer('task1', T0);
    expect(t).toEqual({ taskId: 'task1', startedAt: T0, accumulatedMs: 0, isPaused: false });
  });

  test('pause accumulates elapsed time', () => {
    const t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    expect(t.isPaused).toBe(true);
    expect(t.accumulatedMs).toBe(60_000);
    expect(t.pausedAt).toBe(T0 + 60_000);
  });

  test('pause is idempotent', () => {
    const t = startTimer('task1', T0);
    expect(pauseTimer(t, T0 + 1000)).toEqual(pauseTimer(pauseTimer(t, T0 + 1000), T0 + 9000));
  });

  test('resume restarts segment without losing accumulated time', () => {
    let t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    t = resumeTimer(t, T0 + 120_000);
    expect(t.isPaused).toBe(false);
    expect(t.startedAt).toBe(T0 + 120_000);
    expect(t.accumulatedMs).toBe(60_000);
    expect(computeElapsed(t, T0 + 150_000)).toBe(90_000);
  });

  test('computeElapsed excludes paused time', () => {
    const t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    expect(computeElapsed(t, T0 + 10 * 60_000)).toBe(60_000);
  });
});

describe('localDate', () => {
  test('formats local YYYY-MM-DD', () => {
    const d = new Date(2026, 7, 4, 9, 30); // Aug = month 7
    expect(localDate(d.getTime())).toBe('2026-08-04');
    expect(localDate(new Date(2026, 0, 1, 0, 0).getTime())).toBe('2026-01-01');
  });
});

describe('addDays', () => {
  test('adds one day', () => {
    expect(addDays('2026-08-04', 1)).toBe('2026-08-05');
  });
  test('rolls over month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  test('handles leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
  test('supports negative offsets', () => {
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
  });
});

describe('settlement', () => {
  test('settle running timer at now', () => {
    const t = startTimer('task1', T0);
    const s = settleTimer(t, T0 + 90_000);
    expect(s.ms).toBe(90_000);
    expect(s.entry.start).toBe(T0);
    expect(s.entry.end).toBe(T0 + 90_000);
    expect(s.entry.date).toBe(localDate(T0 + 90_000));
  });

  test('settle paused timer ends at pause time, not now', () => {
    const t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    const s = settleTimer(t, T0 + 300_000);
    expect(s.ms).toBe(60_000);
    expect(s.entry.end).toBe(T0 + 60_000);
  });

  test('applySettlement adds ms to task totals and appends entry', () => {
    const task: Task = {
      id: 'task1',
      title: 'T',
      projectId: 'p',
      tagIds: [],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 10_000,
      timeSpentOnDay: { '2026-08-04': 5_000 },
      timeEntries: [],
      notes: '',
      created: 0,
    };
    const t = startTimer('task1', T0);
    const settled = applySettlement(task, settleTimer(t, T0 + 90_000));
    const day = localDate(T0 + 90_000);
    expect(settled.timeSpent).toBe(100_000);
    expect(settled.timeSpentOnDay[day]).toBe((day === '2026-08-04' ? 5_000 : 0) + 90_000);
    expect(settled.timeEntries).toHaveLength(1);
    expect(settled.timeEntries[0]?.ms).toBe(90_000);
    // original not mutated
    expect(task.timeSpent).toBe(10_000);
  });
});
