import { describe, expect, test } from 'bun:test';
import type { Task } from '@tiny-schedule/shared';
import {
  completedInCell,
  doneTodayCount,
  estimateRemainingMs,
  focusSeries7d,
  isUrgent,
  longTermPool,
  quadrantOf,
  quadrantTasks,
  workedTodayMs,
} from './tasks';

const TODAY = '2026-10-09';

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    title: patch.id,
    projectId: 'INBOX_PROJECT',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    isImportant: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
    ...patch,
  };
}

describe('isUrgent', () => {
  test('is false without a due day', () => {
    expect(isUrgent(task({ id: 'a' }), TODAY, 2)).toBe(false);
  });

  test('counts days up to the threshold and treats overdue as urgent', () => {
    expect(isUrgent(task({ id: 'a', dueDay: '2026-10-11' }), TODAY, 2)).toBe(true);
    expect(isUrgent(task({ id: 'a', dueDay: '2026-10-12' }), TODAY, 2)).toBe(false);
    expect(isUrgent(task({ id: 'a', dueDay: '2026-10-01' }), TODAY, 2)).toBe(true);
  });

  test('is false once the task is done', () => {
    expect(isUrgent(task({ id: 'a', dueDay: TODAY, isDone: true }), TODAY, 2)).toBe(false);
  });
});

describe('quadrantOf / quadrantTasks', () => {
  test('maps important × urgent onto the four cells', () => {
    expect(quadrantOf(task({ id: 'a', isImportant: true, dueDay: TODAY }), TODAY, 2)).toBe(
      'important-urgent',
    );
    expect(quadrantOf(task({ id: 'a', isImportant: true }), TODAY, 2)).toBe('important-notUrgent');
    expect(quadrantOf(task({ id: 'a', dueDay: TODAY }), TODAY, 2)).toBe('notImportant-urgent');
    expect(quadrantOf(task({ id: 'a' }), TODAY, 2)).toBe('notImportant-notUrgent');
  });

  test('only top-level open tasks land in a cell', () => {
    const tasks = [
      task({ id: 'open', isImportant: true }),
      task({ id: 'done', isDone: true }),
      task({ id: 'sub', parentTaskId: 'open' }),
    ];
    const cells = quadrantTasks(tasks, TODAY, 2);
    expect(cells['important-notUrgent'].map((t) => t.id)).toEqual(['open']);
  });
});

describe('completedInCell', () => {
  test("counts this cell's coordinates finished within the last week", () => {
    const tasks = [
      task({ id: 'a', isImportant: true, isDone: true, doneAt: new Date(2026, 9, 8).getTime() }),
      task({ id: 'b', isImportant: true, isDone: true, doneAt: new Date(2026, 8, 1).getTime() }),
      task({ id: 'c', isDone: true, doneAt: new Date(2026, 9, 8).getTime() }),
    ];
    expect(completedInCell(tasks, 'important-notUrgent', TODAY, 2)).toBe(1);
    expect(completedInCell(tasks, 'notImportant-notUrgent', TODAY, 2)).toBe(1);
  });
});

describe('longTermPool', () => {
  test('splits undated from far-future and drops everything else', () => {
    const tasks = [
      task({ id: 'none' }),
      task({ id: 'far', dueDay: '2026-11-30' }),
      task({ id: 'soon', dueDay: '2026-10-12' }),
      task({ id: 'done', dueDay: '2026-12-01', isDone: true }),
    ];
    const pool = longTermPool(tasks, TODAY);
    expect(pool.unscheduled.map((t) => t.id)).toEqual(['none']);
    expect(pool.farFuture.map((t) => t.id)).toEqual(['far']);
  });

  test('orders the far-future section by due day', () => {
    const tasks = [
      task({ id: 'later', dueDay: '2026-12-01' }),
      task({ id: 'sooner', dueDay: '2026-11-01' }),
    ];
    expect(longTermPool(tasks, TODAY).farFuture.map((t) => t.id)).toEqual(['sooner', 'later']);
  });
});

describe('focusSeries7d', () => {
  test('returns 7 ascending days ending today', () => {
    const series = focusSeries7d([], TODAY);
    expect(series).toHaveLength(7);
    expect(series[0]?.date).toBe('2026-10-03');
    expect(series[6]?.date).toBe(TODAY);
  });

  test('sums every task recorded on a day', () => {
    const tasks = [
      task({ id: 'a', timeSpentOnDay: { [TODAY]: 60_000 } }),
      task({ id: 'b', timeSpentOnDay: { [TODAY]: 30_000, '2026-10-05': 10_000 } }),
    ];
    const series = focusSeries7d(tasks, TODAY);
    expect(series[6]?.ms).toBe(90_000);
    expect(series[2]?.ms).toBe(10_000);
  });
});

describe('home stats', () => {
  test('workedTodayMs counts every task, subtasks included', () => {
    const tasks = [task({ id: 'a', timeSpentOnDay: { [TODAY]: 60_000 } })];
    expect(workedTodayMs(tasks, TODAY)).toBe(60_000);
  });

  test('estimateRemainingMs only owes time on tasks due today or earlier', () => {
    const tasks = [
      task({ id: 'due', dueDay: TODAY, timeEstimate: 100, timeSpent: 40 }),
      task({ id: 'over', dueDay: '2026-10-01', timeEstimate: 100 }),
      task({ id: 'future', dueDay: '2026-12-01', timeEstimate: 100 }),
      task({ id: 'done', dueDay: TODAY, timeEstimate: 100, isDone: true }),
    ];
    expect(estimateRemainingMs(tasks, TODAY)).toBe(60 + 100);
  });

  test('doneTodayCount counts top-level tasks completed today', () => {
    const tasks = [
      task({ id: 'a', isDone: true, doneAt: new Date(2026, 9, 9, 10).getTime() }),
      task({ id: 'b', isDone: true, doneAt: new Date(2026, 9, 8).getTime() }),
      task({ id: 'sub', parentTaskId: 'a', isDone: true, doneAt: new Date(2026, 9, 9).getTime() }),
    ];
    expect(doneTodayCount(tasks, TODAY)).toBe(1);
  });
});
