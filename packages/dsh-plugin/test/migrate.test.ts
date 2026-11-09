import { describe, expect, test } from 'bun:test';
import {
  GlobalStateSchema,
  IdeaRecordSchema,
  TaskRecordSchema,
  TimeEntryRecordSchema,
} from '../src/domain/schema.ts';
import { migrateAppData, serializeUnit } from '../src/migrate/fromAppData.ts';

const legacy = {
  version: 1,
  tasks: {
    t1: {
      id: 't1',
      title: '写插件',
      projectId: 'p1',
      projectTitle: 'dsh',
      tagIds: ['g1'],
      subTaskIds: [],
      isDone: false,
      isImportant: true,
      dueDay: '2026-01-05',
      timeEstimate: 3_600_000,
      timeSpent: 1_800_000,
      timeSpentOnDay: { '2026-01-05': 1_800_000 },
      timeEntries: [{ date: '2026-01-05', start: 100, end: 1_800_100, ms: 1_800_000 }],
      notes: '备注',
      created: 1,
    },
    t2: {
      id: 't2',
      title: '已完成',
      projectId: 'INBOX_PROJECT',
      tagIds: [],
      subTaskIds: [],
      isDone: true,
      doneAt: 123,
      isImportant: false,
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 2,
    },
  },
  projects: { p1: { id: 'p1', title: 'dsh', isArchived: false, primaryColor: null } },
  tags: { g1: { id: 'g1', title: '插件', color: '#fff' } },
  ideas: {
    i1: { id: 'i1', title: '想法', notes: '', createdAt: 3, convertedAt: 4 },
    i2: { id: 'i2', title: '新想法', notes: '', createdAt: 5 },
  },
  followUps: {
    f1: {
      id: 'f1',
      title: '等回复',
      notes: '',
      entries: [],
      createdAt: 6,
      nextFollowUpDay: '2026-01-09',
      isResolved: false,
    },
  },
  settings: { urgencyThresholdDays: 3 },
  activeTimer: null,
  misc: { taskOrder: { today: ['t1', 't2'] }, chatSessions: [{ big: 'blob' }] },
  timeTracking: { legacy: true },
  boards: { boardCfgs: [] },
};

describe('migration', () => {
  const result = migrateAppData(legacy);

  test('tasks keep their shape but lose the duplicated time totals', () => {
    const task = result.unit.tables.tasks.t1!;
    expect(task).toBeDefined();
    expect(task.title).toBe('写插件');
    expect(task.isImportant).toBe(true);
    expect(task.dueDay).toBe('2026-01-05');
    expect('timeSpent' in task).toBe(false);
    expect('timeSpentOnDay' in task).toBe(false);
    expect(TaskRecordSchema.safeParse(task).success).toBe(true);
  });

  test('the per-day aggregate becomes a time entry', () => {
    const entries = Object.values(result.unit.tables.time_entries);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.taskId).toBe('t1');
    expect(entry.date).toBe('2026-01-05');
    expect(entry.ms).toBe(1_800_000);
    // The single raw interval matched the aggregate, so its exact bounds survive.
    expect(entry.start).toBe(100);
    expect(entry.end).toBe(1_800_100);
    expect(TimeEntryRecordSchema.safeParse(entry).success).toBe(true);
  });

  test('an idea without a status derives one from convertedAt', () => {
    expect(result.unit.tables.ideas.i1?.status).toBe('converted');
    expect(result.unit.tables.ideas.i2?.status).toBe('open');
    expect(IdeaRecordSchema.safeParse(result.unit.tables.ideas.i1).success).toBe(true);
  });

  test('the manual order moves into its own table', () => {
    expect(result.unit.tables.task_order.today?.ids).toEqual(['t1', 't2']);
  });

  test('the urgency threshold comes from the old settings', () => {
    expect(result.unit.global.settings.urgencyThresholdDays).toBe(3);
    expect(result.unit.global.settings.longTermHorizonDays).toBe(14);
    expect(GlobalStateSchema.safeParse(result.unit.global).success).toBe(true);
  });

  test('the legacy blobs are dropped and reported', () => {
    expect(result.stats.dropped.timeTracking).toBeGreaterThan(0);
    expect(result.stats.dropped.boards).toBeGreaterThan(0);
    expect(result.unit.tables).not.toHaveProperty('timeTracking');
  });

  test('the counts are reported', () => {
    expect(result.stats.tasks).toBe(2);
    expect(result.stats.projects).toBe(1);
    expect(result.stats.ideas).toBe(2);
    expect(result.stats.followUps).toBe(1);
    expect(result.stats.timeEntries).toBe(1);
  });

  test('the serialized unit carries the backend header', () => {
    const document = JSON.parse(serializeUnit(result.unit)) as {
      unit: { name: string; version: number };
      global: unknown;
      tables: Record<string, unknown>;
    };
    expect(document.unit.name).toBe('task_tracker');
    expect(document.unit.version).toBe(1);
    expect(Object.keys(document.tables).sort()).toEqual([
      'follow_ups',
      'ideas',
      'projects',
      'tags',
      'task_order',
      'tasks',
      'time_entries',
    ]);
  });

  test('a document without tasks is rejected', () => {
    expect(() => migrateAppData({ projects: {} })).toThrow(/tasks/);
    expect(() => migrateAppData('nope')).toThrow(/JSON object/);
  });

  test('migrating twice produces the same unit', () => {
    const again = migrateAppData(legacy);
    expect(serializeUnit(again.unit)).toBe(serializeUnit(result.unit));
  });
});
