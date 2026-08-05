import { describe, expect, test } from 'bun:test';
import { type AppData, emptyAppData, type Task } from '@tiny-schedule/shared';
import { formatDuration } from '../duration';
import { exportProjectTaskList, exportWorklog } from '../exporter';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    title: '任务A',
    projectId: 'p1',
    tagIds: ['TAGX'],
    subTaskIds: [],
    isDone: false,
    timeEstimate: 7_200_000,
    timeSpent: 3_600_000,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
    ...overrides,
  };
}

function makeData(tasks: Task[], withTag = true): AppData {
  const d = emptyAppData();
  d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
  if (withTag) d.tags.TAGX = { id: 'TAGX', title: '学习' };
  for (const t of tasks) d.tasks[t.id] = t;
  return d;
}

describe('formatDuration', () => {
  test('formats h/m/s', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45_000)).toBe('0m');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(7_200_000)).toBe('2h');
  });
});

describe('exportProjectTaskList', () => {
  test('groups by done state with metadata', () => {
    const open = makeTask({ id: 't1', dueDay: '2026-08-05' });
    const done = makeTask({ id: 't2', title: '任务B', isDone: true, tagIds: [] });
    const md = exportProjectTaskList(makeData([done, open]), 'p1');
    expect(md).toContain('# 工作');
    expect(md).toContain('## 进行中');
    expect(md).toContain('- [ ] 任务A');
    expect(md).toContain('`学习`');
    expect(md).toContain('截止 2026-08-05');
    expect(md).toContain('预估 2h');
    expect(md).toContain('实际 1h');
    expect(md).toContain('## 已完成');
    expect(md).toContain('- [x] 任务B');
    // done section appears after open section
    expect(md.indexOf('## 已完成')).toBeGreaterThan(md.indexOf('## 进行中'));
  });

  test('throws for unknown project', () => {
    expect(() => exportProjectTaskList(makeData([]), 'nope')).toThrow('UNKNOWN_PROJECT');
  });
});

describe('exportWorklog', () => {
  test('lists days in range with totals and day window', () => {
    const t = makeTask({
      timeSpentOnDay: { '2026-08-03': 3_600_000, '2026-08-04': 1_800_000 },
    });
    const d = makeData([t]);
    d.timeTracking = { tag: { TODAY: { '2026-08-03': { s: 1785600000000, e: 1785603600000 } } } };
    const md = exportWorklog(d, { from: '2026-08-03', to: '2026-08-04' });
    expect(md).toContain('# 工作日志');
    expect(md).toContain('## 2026-08-03');
    expect(md).toContain('合计 1h');
    expect(md).toContain('- 任务A | 1h');
    expect(md).toContain('## 2026-08-04');
    expect(md).toContain('合计 30m');
    expect(md).not.toContain('## 2026-08-05');
  });

  test('empty range produces empty-state message', () => {
    const md = exportWorklog(makeData([]), { from: '2026-08-01', to: '2026-08-02' });
    expect(md).toContain('没有工作记录');
  });

  test('projectId filter limits tasks', () => {
    const t1 = makeTask({ id: 't1', projectId: 'p1', timeSpentOnDay: { '2026-08-03': 3_600_000 } });
    const t2 = makeTask({ id: 't2', projectId: 'p2', timeSpentOnDay: { '2026-08-03': 2000 } });
    const d = makeData([t1, t2]);
    d.projects.p2 = { id: 'p2', title: '其他', isArchived: false };
    const md = exportWorklog(d, { from: '2026-08-03', to: '2026-08-03', projectId: 'p1' });
    expect(md).toContain('任务A');
    expect(md).toContain('合计 1h');
    expect(md).not.toContain('合计 0m');
  });
});
