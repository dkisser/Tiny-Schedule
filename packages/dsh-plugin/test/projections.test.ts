import { describe, expect, test } from 'bun:test';
import {
  applyManualOrder,
  completedInCell,
  estimateRemainingMs,
  filterTasks,
  isOverdue,
  isUrgent,
  longTermPool,
  quadrantMovePatch,
  quadrantOf,
  quadrantTasks,
  todayDoneTasks,
  todayTasks,
  workedTodayMs,
} from '../src/domain/projections.ts';
import { addDays, formatMs, localDate } from '../src/domain/time.ts';
import type { TaskView } from '../src/domain/types.ts';

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1',
    title: 'task',
    projectId: 'p1',
    projectTitle: 'Project',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    isImportant: false,
    timeEstimate: 0,
    notes: '',
    created: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    ...over,
  };
}

const TODAY = '2026-01-05';

describe('time helpers', () => {
  test('addDays crosses month and year boundaries in local time', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  test('formatMs uses the app house format', () => {
    expect(formatMs(45 * 60_000)).toBe('45m');
    expect(formatMs(90 * 60_000)).toBe('1h 30m');
  });
});

describe('urgency is derived, importance is stored', () => {
  test('a task due inside the threshold is urgent', () => {
    expect(isUrgent(task({ dueDay: addDays(TODAY, 2) }), TODAY, 2)).toBe(true);
    expect(isUrgent(task({ dueDay: addDays(TODAY, 3) }), TODAY, 2)).toBe(false);
  });

  test('an overdue task is urgent for free', () => {
    expect(isUrgent(task({ dueDay: addDays(TODAY, -5) }), TODAY, 2)).toBe(true);
  });

  test('a finished task is never urgent', () => {
    expect(isUrgent(task({ dueDay: TODAY, isDone: true }), TODAY, 2)).toBe(false);
  });

  test('a task without a due day is never urgent', () => {
    expect(isUrgent(task(), TODAY, 2)).toBe(false);
  });

  test('the quadrant combines the stored and the derived axis', () => {
    expect(quadrantOf(task({ isImportant: true, dueDay: TODAY }), TODAY, 2)).toBe(
      'important-urgent',
    );
    expect(quadrantOf(task({ isImportant: true, dueDay: addDays(TODAY, 30) }), TODAY, 2)).toBe(
      'important-notUrgent',
    );
    expect(quadrantOf(task({ dueDay: TODAY }), TODAY, 2)).toBe('notImportant-urgent');
    expect(quadrantOf(task({ dueDay: addDays(TODAY, 30) }), TODAY, 2)).toBe(
      'notImportant-notUrgent',
    );
  });
});

describe('today', () => {
  test('today holds unfinished work due today or earlier', () => {
    const tasks = [
      task({ id: 'due-today', dueDay: TODAY }),
      task({ id: 'overdue', dueDay: addDays(TODAY, -3) }),
      task({ id: 'later', dueDay: addDays(TODAY, 1) }),
      task({ id: 'undated' }),
      task({ id: 'done', dueDay: TODAY, isDone: true }),
      task({ id: 'sub', dueDay: TODAY, parentTaskId: 'parent' }),
    ];
    const ids = todayTasks(tasks, TODAY).map((t) => t.id);
    expect(ids).toEqual(['overdue', 'due-today']);
  });

  test('today done holds what was finished today', () => {
    const noon = new Date(`${TODAY}T12:00:00`).getTime();
    const tasks = [
      task({ id: 'a', isDone: true, doneAt: noon }),
      task({ id: 'b', isDone: true, doneAt: noon - 86_400_000 }),
    ];
    expect(todayDoneTasks(tasks, TODAY).map((t) => t.id)).toEqual(['a']);
  });
});

describe('quadrant board', () => {
  test('only top-level open tasks land in a cell', () => {
    const tasks = [
      task({ id: 'open', isImportant: true, dueDay: TODAY }),
      task({ id: 'sub', parentTaskId: 'open' }),
      task({ id: 'done', isDone: true, dueDay: TODAY }),
    ];
    const cells = quadrantTasks(tasks, TODAY, 2);
    expect(cells['important-urgent'].map((t) => t.id)).toEqual(['open']);
  });

  test('a cell reports its own weekly throughput', () => {
    const noon = new Date(`${TODAY}T12:00:00`).getTime();
    const tasks = [
      task({ id: 'done-today', isDone: true, doneAt: noon, isImportant: true, dueDay: TODAY }),
      task({
        id: 'done-long-ago',
        isDone: true,
        doneAt: noon - 20 * 86_400_000,
        isImportant: true,
        dueDay: TODAY,
      }),
    ];
    // A finished task is never urgent (the retired app's rule, kept verbatim),
    // so a completed task is counted in the notUrgent column of its importance.
    expect(completedInCell(tasks, 'important-notUrgent', TODAY, 2)).toBe(1);
    expect(completedInCell(tasks, 'important-urgent', TODAY, 2)).toBe(0);
  });
});

describe('long-term pool', () => {
  test('undated work and far-future work are separated', () => {
    const tasks = [
      task({ id: 'undated' }),
      task({ id: 'far', dueDay: addDays(TODAY, 30) }),
      task({ id: 'soon', dueDay: addDays(TODAY, 5) }),
    ];
    const pool = longTermPool(tasks, TODAY, 14);
    expect(pool.unscheduled.map((t) => t.id)).toEqual(['undated']);
    expect(pool.farFuture.map((t) => t.id)).toEqual(['far']);
  });
});

describe('derived time figures', () => {
  test('worked today sums every task, subtasks included', () => {
    const tasks = [
      task({ id: 'a', timeSpentOnDay: { [TODAY]: 60_000 } }),
      task({ id: 'b', timeSpentOnDay: { [TODAY]: 30_000 } }),
      task({ id: 'c', timeSpentOnDay: { [TODAY]: 10_000 }, parentTaskId: 'a' }),
    ];
    expect(workedTodayMs(tasks, TODAY)).toBe(100_000);
  });

  test('remaining estimate only counts work still owed', () => {
    const tasks = [
      task({ id: 'a', dueDay: TODAY, timeEstimate: 60_000, timeSpent: 20_000 }),
      task({ id: 'b', dueDay: TODAY, timeEstimate: 60_000, timeSpent: 90_000 }),
      task({ id: 'c', dueDay: addDays(TODAY, 5), timeEstimate: 60_000 }),
    ];
    expect(estimateRemainingMs(tasks, TODAY)).toBe(40_000);
  });
});

describe('filters', () => {
  const tasks = [
    task({ id: 'a', dueDay: TODAY, isImportant: true, isDone: false }),
    task({ id: 'b', dueDay: addDays(TODAY, 30), isDone: false }),
    task({ id: 'c', dueDay: TODAY, isDone: true, doneAt: new Date(`${TODAY}T10:00:00`).getTime() }),
    task({ id: 'sub', parentTaskId: 'a', dueDay: TODAY }),
  ];

  test('a quadrant filter selects one cell', () => {
    const matched = filterTasks(tasks, { quadrant: 'important-urgent' }, TODAY, 2, 14);
    expect(matched.map((t) => t.id)).toEqual(['a']);
  });

  test('the long-term filter selects undated and far-future work', () => {
    const matched = filterTasks(tasks, { longTerm: true }, TODAY, 2, 14);
    expect(matched.map((t) => t.id)).toEqual(['b']);
  });

  test('subtasks are excluded unless asked for', () => {
    expect(filterTasks(tasks, {}, TODAY, 2, 14).map((t) => t.id)).not.toContain('sub');
    expect(filterTasks(tasks, { includeSubtasks: true }, TODAY, 2, 14).map((t) => t.id)).toContain(
      'sub',
    );
  });

  test('a completion window selects by completion day', () => {
    const matched = filterTasks(tasks, { doneFrom: TODAY, doneTo: TODAY }, TODAY, 2, 14);
    expect(matched.map((t) => t.id)).toEqual(['c']);
  });
});

describe('manual order', () => {
  test('manual ids come first, the rest keep their default order', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })];
    expect(applyManualOrder(tasks, ['c', 'a']).map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(applyManualOrder(tasks, []).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('a drop on the board is translated into field changes', () => {
  test('becoming urgent rewrites the due day to today', () => {
    const subject = task({ dueDay: addDays(TODAY, 9) });
    expect(quadrantMovePatch(subject, 'notImportant-urgent', TODAY, 2)).toEqual({
      dueDay: TODAY,
    });
  });

  test('leaving the urgent side pushes the due day past the threshold', () => {
    const subject = task({ dueDay: TODAY });
    expect(quadrantMovePatch(subject, 'important-notUrgent', TODAY, 2)).toEqual({
      dueDay: addDays(TODAY, 3),
      isImportant: true,
    });
  });

  test('crossing the importance axis flips the stored flag', () => {
    const subject = task({ dueDay: TODAY, isImportant: false });
    expect(quadrantMovePatch(subject, 'important-urgent', TODAY, 2)).toEqual({
      isImportant: true,
    });
  });

  test('a drop that changes nothing changes no field', () => {
    const subject = task({ dueDay: TODAY, isImportant: true });
    expect(quadrantMovePatch(subject, 'important-urgent', TODAY, 2)).toEqual({});
  });
});

describe('overdue', () => {
  test('only unfinished work past its due day is overdue', () => {
    expect(
      isOverdue(task({ dueDay: addDays(TODAY, -1) }), new Date(`${TODAY}T08:00:00`).getTime()),
    ).toBe(true);
    expect(isOverdue(task({ dueDay: TODAY }), new Date(`${TODAY}T08:00:00`).getTime())).toBe(false);
    expect(isOverdue(task({ dueDay: addDays(TODAY, -1), isDone: true }), Date.now())).toBe(false);
  });
});

test('localDate formats the local calendar day', () => {
  expect(localDate(new Date(2026, 0, 5, 23, 30).getTime())).toBe('2026-01-05');
});
