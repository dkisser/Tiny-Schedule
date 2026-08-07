import { describe, expect, test } from 'bun:test';
import { emptyAppData, SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { mergeImport, normalizeBackup } from '../src/main/importer';
import fixture from './fixtures/backup.fixture.json';

describe('normalizeBackup', () => {
  test('maps tasks with all fields', () => {
    const { data, counts } = normalizeBackup(fixture);
    expect(counts).toEqual({ tasks: 3, projects: 2, tags: 3 });
    const t1 = data.tasks.t1;
    expect(t1?.title).toBe('写周报');
    expect(t1?.timeSpent).toBe(1_800_000);
    expect(t1?.timeEstimate).toBe(3_600_000);
    expect(t1?.timeSpentOnDay['2026-08-03']).toBe(1_800_000);
    expect(t1?.dueDay).toBe('2026-08-04');
    expect(t1?.tagIds).toEqual(['TODAY']);
    expect(t1?.subTaskIds).toEqual(['t3']);
    expect(t1?.timeEntries).toEqual([]);
    expect(data.tasks.t3?.parentTaskId).toBe('t1');
    expect(data.tasks.t2?.isDone).toBe(true);
  });

  test('maps projects and keeps system tags', () => {
    const { data } = normalizeBackup(fixture);
    expect(data.projects.p1?.title).toBe('工作');
    expect(data.projects.p1?.primaryColor).toBe('rgb(144, 187, 165)');
    expect(data.tags[SYSTEM_TAG_IDS.today]?.title).toBe('Today');
    expect(data.tags.custom1?.title).toBe('学习');
  });

  test('preserves raw sections', () => {
    const { data } = normalizeBackup(fixture);
    expect(data.timeTracking).toEqual(fixture.data.timeTracking);
    expect(data.planner).toEqual(fixture.data.planner);
    expect(data.misc.simpleCounter).toEqual(fixture.data.simpleCounter);
  });

  test('task without projectId falls back to INBOX_PROJECT', () => {
    const broken = structuredClone(fixture);
    delete (broken.data.task.entities.t2 as Record<string, unknown>).projectId;
    const { data } = normalizeBackup(broken);
    expect(data.tasks.t2?.projectId).toBe('INBOX_PROJECT');
  });

  test('rejects invalid backups', () => {
    expect(() => normalizeBackup(null)).toThrow('INVALID_BACKUP');
    expect(() => normalizeBackup({ data: {} })).toThrow('INVALID_BACKUP');
    expect(() => normalizeBackup({ data: { task: { entities: 'x' } } })).toThrow('INVALID_BACKUP');
  });

  test('snapshots project/tag display names onto tasks', () => {
    const { data } = normalizeBackup(fixture);
    expect(data.tasks.t1?.projectTitle).toBe('工作');
    expect(data.tasks.t1?.tagSnapshots?.TODAY?.title).toBe('Today');
  });
});

describe('mergeImport', () => {
  test('appends imported entities and keeps settings, timer and misc', () => {
    const current = emptyAppData();
    current.settings.userName = 'me';
    current.activeTimer = { taskId: 'x', startedAt: 1, accumulatedMs: 0, isPaused: false };
    current.tasks.local1 = {
      id: 'local1',
      title: '本地任务',
      projectId: 'INBOX_PROJECT',
      tagIds: [],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 1,
    };
    current.misc.chatSessions = [
      { id: 's1', title: '会话', createdAt: 1, updatedAt: 1, messages: [] },
    ];
    current.misc.aiHistory = [{ id: 'h1', content: 'x' }];
    const { data: imported } = normalizeBackup(fixture);
    const merged = mergeImport(current, imported);
    expect(merged.settings.userName).toBe('me');
    expect(merged.activeTimer?.taskId).toBe('x');
    // 3 imported + 1 existing local task
    expect(Object.keys(merged.tasks)).toHaveLength(4);
    expect(merged.tasks.local1?.title).toBe('本地任务');
    expect(merged.projects.p1?.title).toBe('工作');
    // AI sessions and history survive the import
    expect((merged.misc.chatSessions as unknown[]).length).toBe(1);
    expect((merged.misc.aiHistory as unknown[]).length).toBe(1);
  });

  test('imported entity wins on ID collision', () => {
    const current = emptyAppData();
    const { data: imported } = normalizeBackup(fixture);
    current.tasks.t1 = {
      id: 't1',
      title: '旧标题',
      projectId: 'INBOX_PROJECT',
      tagIds: [],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 1,
    };
    current.projects.p1 = { id: 'p1', title: '旧项目', isArchived: false };
    const merged = mergeImport(current, imported);
    expect(merged.tasks.t1?.title).toBe('写周报');
    expect(merged.projects.p1?.title).toBe('工作');
  });
});
