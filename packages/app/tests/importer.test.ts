import { describe, expect, test } from 'bun:test';
import { emptyAppData, SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { mergeImport, normalizeBackup } from '../importer';
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
});

describe('mergeImport', () => {
  test('replaces tasks/projects/tags but keeps settings and timer', () => {
    const current = emptyAppData();
    current.settings.userName = 'me';
    current.activeTimer = { taskId: 'x', startedAt: 1, accumulatedMs: 0, isPaused: false };
    const { data: imported } = normalizeBackup(fixture);
    const merged = mergeImport(current, imported);
    expect(merged.settings.userName).toBe('me');
    expect(merged.activeTimer?.taskId).toBe('x');
    expect(Object.keys(merged.tasks)).toHaveLength(3);
    expect(merged.projects.p1?.title).toBe('工作');
  });
});
