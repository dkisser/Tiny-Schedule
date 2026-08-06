import { describe, expect, test } from 'bun:test';
import {
  AppDataSchema,
  ExportMarkdownReqSchema,
  Ipc,
  SettingsUpdateReqSchema,
  TaskSchema,
  TimerSyncReqSchema,
} from '../src/ipc';
import { emptyAppData } from '../src/models';

describe('Ipc channels', () => {
  test('channels are unique', () => {
    const values = Object.values(Ipc);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('schemas', () => {
  test('TaskSchema round-trips a valid task', () => {
    const task = {
      id: 't1',
      title: 'x',
      projectId: 'p1',
      tagIds: [],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 0,
    };
    expect(TaskSchema.parse(task)).toEqual(task);
  });

  test('TaskSchema rejects missing title', () => {
    const bad = { id: 't1', projectId: 'p1' };
    expect(() => TaskSchema.parse(bad)).toThrow();
  });

  test('AppDataSchema accepts emptyAppData()', () => {
    expect(AppDataSchema.parse(emptyAppData()).version).toBe(1);
  });

  test('SettingsUpdateReq is partial', () => {
    expect(SettingsUpdateReqSchema.parse({ theme: 'dark' }).theme).toBe('dark');
    expect(() => SettingsUpdateReqSchema.parse({ theme: 'blue' })).toThrow();
  });

  test('TimerSyncReq accepts null timer', () => {
    expect(TimerSyncReqSchema.parse({ timer: null }).timer).toBeNull();
  });

  test('ExportMarkdownReq validates mode', () => {
    expect(ExportMarkdownReqSchema.parse({ mode: 'projectList', projectId: 'p' }).mode).toBe(
      'projectList',
    );
    expect(
      ExportMarkdownReqSchema.parse({ mode: 'worklog', from: '2026-08-01', to: '2026-08-04' }).mode,
    ).toBe('worklog');
    expect(() => ExportMarkdownReqSchema.parse({ mode: 'bogus' })).toThrow();
  });
});
