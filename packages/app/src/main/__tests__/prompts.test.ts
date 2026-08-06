import { describe, expect, test } from 'bun:test';
import { emptyAppData, localDate, SYSTEM_TAG_IDS, type Task } from '@tiny-schedule/shared';
import { buildAnalysisData, DEFAULT_PROMPT, renderPrompt } from '../ai/prompts';

function task(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    title: '写周报',
    projectId: 'p1',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    timeEstimate: 3_600_000,
    timeSpent: 1_800_000,
    timeSpentOnDay: { '2026-08-04': 1_800_000 },
    timeEntries: [],
    notes: '',
    created: 0,
    ...overrides,
  };
}

describe('renderPrompt', () => {
  test('replaces placeholders', () => {
    const out = renderPrompt('日期 {{date}} 数据 {{data}}', { date: '2026-08-04', data: '[]' });
    expect(out).toBe('日期 2026-08-04 数据 []');
  });

  test('empty template falls back to default', () => {
    const out = renderPrompt('', { date: '2026-08-04', data: '[]' });
    expect(out).toContain('2026-08-04');
    expect(out).toContain('[]');
    expect(out).toBe(renderPrompt(DEFAULT_PROMPT, { date: '2026-08-04', data: '[]' }));
  });
});

describe('buildAnalysisData', () => {
  test('today scope filters tasks touched today', () => {
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.tasks.t1 = task({});
    d.tasks.t2 = task({ id: 't2', title: '无关任务', timeSpentOnDay: { '2026-01-01': 100 } });
    const json = JSON.parse(buildAnalysisData(d, { scope: 'today', date: '2026-08-04' }));
    expect(json.tasks).toHaveLength(1);
    expect(json.tasks[0].title).toBe('写周报');
    expect(json.summary.totalSpentMs).toBe(1_800_000);
    expect(json.summary.doneCount).toBe(0);
  });

  test('week scope uses date range on timeSpentOnDay or dueDay', () => {
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.tasks.t1 = task({ timeSpentOnDay: { '2026-08-03': 100 } });
    d.tasks.t2 = task({
      id: 't2',
      title: '只有截止日',
      dueDay: '2026-08-05',
      timeSpent: 0,
      timeSpentOnDay: {},
    });
    const json = JSON.parse(buildAnalysisData(d, { scope: 'week', date: '2026-08-04' }));
    expect(json.tasks.map((t: { title: string }) => t.title).sort()).toEqual([
      '写周报',
      '只有截止日',
    ]);
  });

  test('week scope: Sunday anchor maps to the preceding Monday..Sunday (TZ-independent)', () => {
    // 2026-08-09 is a Sunday — assert via local construction (TZ-independent)
    expect(new Date(2026, 8 - 1, 9).getDay()).toBe(0);
    const expectedFrom = localDate(new Date(2026, 8 - 1, 3).getTime());
    const expectedTo = localDate(new Date(2026, 8 - 1, 9).getTime());
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.tasks.t1 = task({ timeSpentOnDay: { [expectedFrom]: 100 } });
    const json = JSON.parse(buildAnalysisData(d, { scope: 'week', date: '2026-08-09' }));
    expect(json.range).toBe(`${expectedFrom} ~ ${expectedTo}`);
    expect(json.tasks).toHaveLength(1);
    expect(json.summary.totalSpentMs).toBe(100);
  });

  test('project scope filters by projectId', () => {
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.projects.p2 = { id: 'p2', title: '其他', isArchived: false };
    d.tasks.t1 = task({});
    d.tasks.t2 = task({ id: 't2', projectId: 'p2' });
    const json = JSON.parse(
      buildAnalysisData(d, { scope: 'project', date: '2026-08-04', projectId: 'p2' }),
    );
    expect(json.tasks).toHaveLength(1);
    expect(json.project).toBe('其他');
  });

  test('includes tag titles and system tag mapping', () => {
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.tags[SYSTEM_TAG_IDS.today] = { id: SYSTEM_TAG_IDS.today, title: 'Today' };
    d.tasks.t1 = task({ tagIds: [SYSTEM_TAG_IDS.today] });
    const json = JSON.parse(buildAnalysisData(d, { scope: 'today', date: '2026-08-04' }));
    expect(json.tasks[0].tags).toEqual(['Today']);
  });
});
