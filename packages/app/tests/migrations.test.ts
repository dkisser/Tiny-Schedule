import { describe, expect, test } from 'bun:test';
import { emptyAppData, localDate, POMODORO_FOCUS_MS, SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { migrateActiveTimerPomodoroFocus, migrateRemoveTodayTag } from '../src/main/migrations';

describe('migrateRemoveTodayTag', () => {
  test('strips TODAY tag and backfills dueDay when missing', () => {
    const d = emptyAppData();
    d.tags[SYSTEM_TAG_IDS.today] = { id: SYSTEM_TAG_IDS.today, title: 'Today' };
    d.tasks.t1 = {
      id: 't1',
      title: 'T',
      projectId: 'INBOX_PROJECT',
      tagIds: [SYSTEM_TAG_IDS.today, 'custom1'],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 0,
    };
    const next = migrateRemoveTodayTag(d);
    expect(next.tasks.t1?.tagIds).toEqual(['custom1']);
    expect(next.tasks.t1?.dueDay).toBe(localDate(Date.now()));
    expect(next.tags[SYSTEM_TAG_IDS.today]).toBeUndefined();
  });

  test('keeps existing dueDay when present', () => {
    const d = emptyAppData();
    d.tasks.t1 = {
      id: 't1',
      title: 'T',
      projectId: 'INBOX_PROJECT',
      tagIds: [SYSTEM_TAG_IDS.today],
      subTaskIds: [],
      isDone: false,
      dueDay: '2026-01-02',
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 0,
    };
    const next = migrateRemoveTodayTag(d);
    expect(next.tasks.t1?.dueDay).toBe('2026-01-02');
  });

  test('returns same reference when nothing to migrate', () => {
    const d = emptyAppData();
    expect(migrateRemoveTodayTag(d)).toBe(d);
  });

  test('removes tag entity even without affected tasks', () => {
    const d = emptyAppData();
    d.tags[SYSTEM_TAG_IDS.today] = { id: SYSTEM_TAG_IDS.today, title: 'Today' };
    const next = migrateRemoveTodayTag(d);
    expect(next.tags[SYSTEM_TAG_IDS.today]).toBeUndefined();
  });
});

describe('migrateActiveTimerPomodoroFocus', () => {
  function pomodoroTimer(overrides: Record<string, unknown> = {}) {
    return {
      taskId: 't1',
      startedAt: 0,
      accumulatedMs: 0,
      isPaused: false,
      sessionStartedAt: 0,
      mode: 'pomodoro' as const,
      phase: 'focus' as const,
      phaseStartedAt: 0,
      phaseAccumulatedMs: 0,
      phaseDurationMs: POMODORO_FOCUS_MS,
      cyclesCompleted: 0,
      ...overrides,
    };
  }

  test('no-op when there is no active timer', () => {
    const d = emptyAppData();
    expect(migrateActiveTimerPomodoroFocus(d)).toBe(d);
  });

  test('no-op for free-mode timers', () => {
    const d = emptyAppData();
    d.activeTimer = { taskId: 't1', startedAt: 0, accumulatedMs: 0, isPaused: false };
    expect(migrateActiveTimerPomodoroFocus(d)).toBe(d);
  });

  test('no-op when focusAccumulatedMs is already set', () => {
    const d = emptyAppData();
    d.activeTimer = pomodoroTimer({ focusAccumulatedMs: 1234 });
    expect(migrateActiveTimerPomodoroFocus(d)).toBe(d);
  });

  test('focus phase: backfills 0 so live computeFocusElapsed takes over', () => {
    const d = emptyAppData();
    d.activeTimer = pomodoroTimer({ phase: 'focus' });
    const next = migrateActiveTimerPomodoroFocus(d);
    expect(next.activeTimer?.focusAccumulatedMs).toBe(0);
  });

  test('break phase: backfills cyclesCompleted * FOCUS_MS', () => {
    const d = emptyAppData();
    d.activeTimer = pomodoroTimer({ phase: 'break', cyclesCompleted: 2 });
    const next = migrateActiveTimerPomodoroFocus(d);
    expect(next.activeTimer?.focusAccumulatedMs).toBe(2 * POMODORO_FOCUS_MS);
  });
});
