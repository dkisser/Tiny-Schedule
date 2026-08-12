import { describe, expect, test } from 'bun:test';
import type { Task } from '../src/models';
import {
  addDays,
  applyEntryChange,
  applySettlement,
  autoPauseTimer,
  computeElapsed,
  idleThresholdReached,
  localDate,
  pauseTimer,
  resumeTimer,
  settleTimer,
  startTimer,
} from '../src/timer';

const T0 = 1_785_700_000_000;

describe('timer transitions', () => {
  test('start creates fresh timer', () => {
    const t = startTimer('task1', T0);
    expect(t).toEqual({
      taskId: 'task1',
      startedAt: T0,
      accumulatedMs: 0,
      isPaused: false,
      sessionStartedAt: T0,
    });
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

describe('sessionStartedAt', () => {
  test('start records the session start', () => {
    expect(startTimer('task1', T0).sessionStartedAt).toBe(T0);
  });

  test('settle of a resumed session uses the session start, not the last segment', () => {
    let t = startTimer('task1', T0);
    t = pauseTimer(t, T0 + 60_000);
    t = resumeTimer(t, T0 + 300_000);
    const s = settleTimer(t, T0 + 360_000);
    expect(s.entry.start).toBe(T0);
    expect(s.entry.end).toBe(T0 + 360_000);
    expect(s.ms).toBe(120_000);
  });
});

describe('autoPauseTimer', () => {
  test('sleep pause stops the running segment at now with a reason', () => {
    const t = autoPauseTimer(startTimer('task1', T0), T0 + 60_000, 'sleep');
    expect(t.isPaused).toBe(true);
    expect(t.autoPausedBy).toBe('sleep');
    expect(t.accumulatedMs).toBe(60_000);
    expect(t.pausedAt).toBe(T0 + 60_000);
  });

  test('idle pause backdates so unattended time is not counted', () => {
    const t = autoPauseTimer(startTimer('task1', T0), T0 + 600_000, 'idle', 480_000);
    expect(t.isPaused).toBe(true);
    expect(t.autoPausedBy).toBe('idle');
    expect(t.accumulatedMs).toBe(120_000);
    expect(t.pausedAt).toBe(T0 + 120_000);
  });

  test('no-op when already paused', () => {
    const paused = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    expect(autoPauseTimer(paused, T0 + 120_000, 'idle', 60_000)).toEqual(paused);
  });

  test('manual pause clears the auto-pause reason', () => {
    const auto = autoPauseTimer(startTimer('task1', T0), T0 + 60_000, 'sleep');
    const manual = pauseTimer(resumeTimer(auto, T0 + 90_000), T0 + 120_000);
    expect(manual.autoPausedBy).toBeUndefined();
  });
});

describe('applyEntryChange', () => {
  // 2026-08-04 23:50 local, so +20min crosses into 2026-08-05
  const lateNight = new Date(2026, 7, 4, 23, 50).getTime();
  const day1 = localDate(lateNight);
  const day2 = localDate(lateNight + 20 * 60_000);

  function baseTask(): Task {
    return {
      id: 'task1',
      title: 'T',
      projectId: 'p',
      tagIds: [],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 100_000,
      timeSpentOnDay: { [day1]: 100_000 },
      timeEntries: [{ date: day1, start: lateNight, end: lateNight + 100_000, ms: 100_000 }],
      notes: '',
      created: 0,
    };
  }

  test('editing an entry adjusts totals by the delta and replaces it', () => {
    const task = baseTask();
    const oldEntry = task.timeEntries[0]!;
    const newEntry = { ...oldEntry, end: oldEntry.end + 50_000, ms: 150_000 };
    const next = applyEntryChange(task, oldEntry, newEntry);
    expect(next.timeSpent).toBe(150_000);
    expect(next.timeSpentOnDay[day1]).toBe(150_000);
    expect(next.timeEntries).toEqual([newEntry]);
    // original not mutated
    expect(task.timeSpent).toBe(100_000);
  });

  test('editing across midnight moves time between days', () => {
    const task = baseTask();
    const oldEntry = task.timeEntries[0]!;
    const newStart = lateNight;
    const newEnd = lateNight + 20 * 60_000;
    const newEntry = { date: day2, start: newStart, end: newEnd, ms: newEnd - newStart };
    const next = applyEntryChange(task, oldEntry, newEntry);
    expect(next.timeSpent).toBe(newEntry.ms);
    expect(next.timeSpentOnDay[day1]).toBeUndefined();
    expect(next.timeSpentOnDay[day2]).toBe(newEntry.ms);
  });

  test('deleting an entry subtracts its time', () => {
    const task = baseTask();
    const next = applyEntryChange(task, task.timeEntries[0]!, null);
    expect(next.timeSpent).toBe(0);
    expect(next.timeSpentOnDay[day1]).toBeUndefined();
    expect(next.timeEntries).toEqual([]);
  });

  test('legacy timeSpent without entries is preserved on other-entry edits', () => {
    const task = baseTask();
    task.timeSpent = 999_999; // includes imported time not backed by entries
    const oldEntry = task.timeEntries[0]!;
    const next = applyEntryChange(task, oldEntry, null);
    expect(next.timeSpent).toBe(899_999);
  });

  test('totals never go negative', () => {
    const task = baseTask();
    task.timeSpent = 50_000; // inconsistent with entries
    task.timeSpentOnDay = { [day1]: 10_000 };
    const next = applyEntryChange(task, task.timeEntries[0]!, null);
    expect(next.timeSpent).toBe(0);
    expect(next.timeSpentOnDay[day1]).toBeUndefined();
  });
});

describe('idleThresholdReached', () => {
  const settings = { idlePauseEnabled: true, idlePauseMinutes: 5 };

  test('false when idle detection is disabled', () => {
    expect(idleThresholdReached({ ...settings, idlePauseEnabled: false }, 10 * 60_000)).toBe(false);
  });

  test('false below the threshold', () => {
    expect(idleThresholdReached(settings, 5 * 60_000 - 1)).toBe(false);
  });

  test('true at and above the threshold', () => {
    expect(idleThresholdReached(settings, 5 * 60_000)).toBe(true);
    expect(idleThresholdReached(settings, 60 * 60_000)).toBe(true);
  });
});
