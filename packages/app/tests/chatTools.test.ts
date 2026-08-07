import { describe, expect, test } from 'bun:test';
import type { AppData } from '@tiny-schedule/shared';
import { getSummary, listMeta, queryTasks } from '../src/main/ai/chatTools';

function fixture(): AppData {
  return {
    version: 1,
    tasks: {
      t1: {
        id: 't1',
        title: '写周报',
        projectId: 'p1',
        tagIds: ['tag1'],
        subTaskIds: [],
        isDone: true,
        doneAt: 1,
        dueDay: '2026-08-03',
        timeEstimate: 3600_000,
        timeSpent: 1800_000,
        timeSpentOnDay: { '2026-08-03': 1800_000 },
        timeEntries: [],
        notes: '',
        created: 1,
      },
      t2: {
        id: 't2',
        title: '修 bug',
        projectId: 'p1',
        tagIds: [],
        subTaskIds: [],
        isDone: false,
        dueDay: '2026-08-04',
        timeEstimate: 7200_000,
        timeSpent: 900_000,
        timeSpentOnDay: { '2026-08-04': 900_000 },
        timeEntries: [],
        notes: '',
        created: 2,
      },
      t3: {
        id: 't3',
        title: '子任务',
        projectId: 'p1',
        tagIds: [],
        subTaskIds: [],
        parentTaskId: 't2',
        isDone: false,
        timeEstimate: 0,
        timeSpent: 0,
        timeSpentOnDay: {},
        timeEntries: [],
        notes: '',
        created: 3,
      },
    },
    projects: { p1: { id: 'p1', title: '工作', isArchived: false } },
    tags: { tag1: { id: 'tag1', title: '文档' } },
    timeTracking: null,
    notes: null,
    planner: null,
    metric: null,
    boards: null,
    misc: {},
    settings: {
      userName: '',
      avatar: null,
      theme: 'system',
      aiProviders: [],
      aiPrompt: '',
      autoAiAnalyzeOnFinishDay: false,
    },
    activeTimer: null,
  };
}

describe('queryTasks', () => {
  test('filters by date range and excludes subtasks', () => {
    const rows = queryTasks(fixture(), { from: '2026-08-03', to: '2026-08-03' });
    expect(rows.map((r) => r.id)).toEqual(['t1']);
    expect(rows[0]).toMatchObject({
      title: '写周报',
      project: '工作',
      tags: ['文档'],
      timeSpentInRangeMs: 1800_000,
    });
  });
  test('filters by projectId and isDone', () => {
    const rows = queryTasks(fixture(), { projectId: 'p1', isDone: false });
    expect(rows.map((r) => r.id).sort()).toEqual(['t2']);
  });
  test('no filters returns all top-level tasks', () => {
    expect(queryTasks(fixture(), {}).length).toBe(2);
  });
});

describe('getSummary', () => {
  test('today summary aggregates', () => {
    const s = getSummary(fixture(), { scope: 'today', date: '2026-08-04' });
    expect(s.taskCount).toBe(1);
    expect(s.doneCount).toBe(0);
    expect(s.totalSpentMs).toBe(900_000);
    expect(s.byProject).toEqual([{ project: '工作', taskCount: 1, spentMs: 900_000 }]);
  });
  test('week summary includes byTag', () => {
    const s = getSummary(fixture(), { scope: 'week', date: '2026-08-04' });
    expect(s.taskCount).toBe(2);
    expect(s.byTag).toEqual([{ tag: '文档', taskCount: 1, spentMs: 1800_000 }]);
  });
});

describe('listMeta', () => {
  test('returns projects and tags', () => {
    const m = listMeta(fixture());
    expect(m.projects).toEqual([{ id: 'p1', title: '工作', isArchived: false }]);
    expect(m.tags).toEqual([{ id: 'tag1', title: '文档' }]);
  });
});
