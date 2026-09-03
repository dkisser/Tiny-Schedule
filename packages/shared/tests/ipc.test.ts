import { describe, expect, test } from 'bun:test';
import {
  AppDataSchema,
  CalendarAddTaskInputSchema,
  CalendarAddTaskOutputSchema,
  ExportMarkdownReqSchema,
  Ipc,
  ProjectUpdateReqSchema,
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

  test('ProjectUpdateReqSchema accepts isArchived toggle and merges with title/color', () => {
    const archived = ProjectUpdateReqSchema.parse({ id: 'p1', isArchived: true });
    expect(archived.isArchived).toBe(true);

    const restored = ProjectUpdateReqSchema.parse({ id: 'p1', isArchived: false });
    expect(restored.isArchived).toBe(false);

    // isArchived omitted leaves it undefined; other fields stay independent.
    const mixed = ProjectUpdateReqSchema.parse({
      id: 'p1',
      title: '改名',
      primaryColor: '#fff',
    });
    expect(mixed.isArchived).toBeUndefined();
    expect(mixed.title).toBe('改名');
    expect(mixed.primaryColor).toBe('#fff');
  });

  test('ProjectUpdateReqSchema rejects non-boolean isArchived', () => {
    expect(() => ProjectUpdateReqSchema.parse({ id: 'p1', isArchived: 'yes' })).toThrow();
  });
});

describe('calendarAddTask IPC', () => {
  test('calendar channel exists', () => {
    expect(Ipc.calendarAddTask).toBe('calendar:addTask');
  });

  test('input requires taskId', () => {
    expect(CalendarAddTaskInputSchema.safeParse({}).success).toBe(false);
    expect(CalendarAddTaskInputSchema.safeParse({ taskId: '' }).success).toBe(false);
    expect(CalendarAddTaskInputSchema.parse({ taskId: 't1' }).taskId).toBe('t1');
  });

  test('output success shape', () => {
    const ok = CalendarAddTaskOutputSchema.parse({ ok: true, eventId: 'evt-1' });
    expect(ok).toEqual({ ok: true, eventId: 'evt-1' });
  });

  test('output failure codes', () => {
    for (const code of [
      'no-dueDay',
      'permission-denied',
      'calendar-app-unavailable',
      'unknown',
    ] as const) {
      const r = CalendarAddTaskOutputSchema.parse({ ok: false, code, message: 'x' });
      expect(r).toEqual({ ok: false, code, message: 'x' });
    }
    expect(
      CalendarAddTaskOutputSchema.safeParse({ ok: false, code: 'bogus', message: 'x' }).success,
    ).toBe(false);
  });
});
