import { describe, expect, test } from 'bun:test';
import {
  type AppData,
  emptyAppData,
  INBOX_PROJECT_ID,
  PROJECT_TITLE_MAX_LENGTH,
  SYSTEM_TAG_IDS,
  type Task,
} from '@tiny-schedule/shared';
import { exportProjectTaskList, exportWorklog, mergeImport, normalizeBackup } from './importExport';

/**
 * A Super Productivity backup, copied verbatim from the Electron build's
 * fixture at packages/app/tests/fixtures/backup.fixture.json — the same three
 * tasks, two projects, three tags, and the raw `timeTracking` / `planner` /
 * `simpleCounter` sections. It is inlined rather than imported because
 * `tsconfig.json` does not list JSON in the project, and that file is not this
 * wave's to change; keeping the cases runnable against the *same* data is worth
 * more than sharing the file on disk.
 */
const fixture = {
  timestamp: 1785700000000,
  lastUpdate: 1785700000000,
  crossModelVersion: 12,
  data: {
    task: {
      ids: ['t1', 't2', 't3'],
      entities: {
        t1: {
          id: 't1',
          title: '写周报',
          projectId: 'p1',
          tagIds: ['TODAY'],
          subTaskIds: ['t3'],
          timeSpent: 1800000,
          timeEstimate: 3600000,
          timeSpentOnDay: {
            '2026-08-03': 1800000,
          },
          isDone: false,
          created: 1785600000000,
          attachments: [],
          dueDay: '2026-08-04',
        },
        t2: {
          id: 't2',
          title: '已完成任务',
          projectId: 'p1',
          tagIds: [],
          subTaskIds: [],
          timeSpent: 600000,
          timeEstimate: 0,
          timeSpentOnDay: {},
          isDone: true,
          created: 1785500000000,
          attachments: [],
        },
        t3: {
          id: 't3',
          title: '子任务',
          projectId: 'p1',
          tagIds: [],
          subTaskIds: [],
          timeSpent: 0,
          timeEstimate: 0,
          timeSpentOnDay: {},
          isDone: false,
          created: 1785600001000,
          attachments: [],
        },
      },
      currentTaskId: null,
      isDataLoaded: true,
    },
    project: {
      ids: ['INBOX_PROJECT', 'p1'],
      entities: {
        INBOX_PROJECT: {
          id: 'INBOX_PROJECT',
          title: 'Inbox',
          icon: 'inbox',
          isArchived: false,
          theme: {
            primary: '#aaa',
          },
        },
        p1: {
          id: 'p1',
          title: '工作',
          icon: 'work',
          isArchived: false,
          theme: {
            primary: 'rgb(144, 187, 165)',
          },
        },
      },
    },
    tag: {
      ids: ['TODAY', 'EM_IMPORTANT', 'custom1'],
      entities: {
        TODAY: {
          id: 'TODAY',
          title: 'Today',
          taskIds: ['t1'],
        },
        EM_IMPORTANT: {
          id: 'EM_IMPORTANT',
          title: 'Important',
          taskIds: [],
        },
        custom1: {
          id: 'custom1',
          title: '学习',
          color: '#3b82f6',
          taskIds: [],
        },
      },
    },
    note: {
      ids: [],
      entities: {},
      todayOrder: [],
    },
    planner: {
      days: {
        '2026-08-03': ['t1'],
      },
    },
    metric: {
      ids: [],
      entities: {},
    },
    boards: {
      boardCfgs: [],
    },
    timeTracking: {
      tag: {
        TODAY: {
          '2026-08-03': {
            s: 1785600000000,
            e: 1785603600000,
            b: 1,
            bt: 300000,
          },
        },
      },
    },
    simpleCounter: {
      ids: [],
      entities: {},
    },
    taskRepeatCfg: {
      ids: [],
      entities: {},
    },
    globalConfig: {
      misc: {
        customTheme: 'default',
      },
    },
  },
};

/**
 * The Electron build proves this merge against that fixture in
 * packages/app/tests/importer.test.ts. The cases are kept equivalent on purpose:
 * the merge semantics are the contract, and a divergence here would mean the
 * Tauri build imports differently from the build users are migrating from.
 */
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
    expect(data.tasks.t2?.projectId).toBe(INBOX_PROJECT_ID);
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

  test('a backup with no Inbox project gets one synthesized', () => {
    const raw = structuredClone(fixture);
    delete (raw.data.project.entities as Record<string, unknown>).INBOX_PROJECT;
    const { data } = normalizeBackup(raw);
    expect(data.projects[INBOX_PROJECT_ID]?.title).toBe('Inbox');
  });

  test('long project titles are truncated to the shared limit', () => {
    const raw = structuredClone(fixture);
    (raw.data.project.entities.p1 as Record<string, unknown>).title = 'x'.repeat(200);
    const { data } = normalizeBackup(raw);
    expect(data.projects.p1?.title.length).toBe(PROJECT_TITLE_MAX_LENGTH);
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
      isImportant: false,
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
    current.ideas.localIdea = {
      id: 'localIdea',
      title: '本地想法',
      notes: '',
      createdAt: 1,
      status: 'incubating',
      projectId: 'p1',
      validationGoal: '验证目标',
      timeline: [{ id: 'e1', createdAt: 1, text: '进展' }],
    };
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
    // 本地想法（含验证记录）不被导入清空
    expect(merged.ideas.localIdea?.status).toBe('incubating');
    expect(merged.ideas.localIdea?.timeline).toHaveLength(1);
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
      isImportant: false,
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

  test('a section missing from the backup keeps the local value', () => {
    const current = emptyAppData();
    current.planner = { days: { '2026-01-01': ['local'] } } as typeof current.planner;
    const imported = normalizeBackup(fixture).data;
    const sparse = { ...imported, planner: null };
    const merged = mergeImport(current, sparse);
    expect(merged.planner).toEqual(current.planner);
  });

  test('does not mutate either input', () => {
    const current = emptyAppData();
    const imported = normalizeBackup(fixture).data;
    const beforeTasks = Object.keys(current.tasks).length;
    const beforeImported = Object.keys(imported.tasks).length;
    mergeImport(current, imported);
    expect(Object.keys(current.tasks)).toHaveLength(beforeTasks);
    expect(Object.keys(imported.tasks)).toHaveLength(beforeImported);
  });
});

describe('exportMarkdown', () => {
  const baseTask: Task = {
    id: 't1',
    title: '任务A',
    projectId: 'p1',
    tagIds: ['TAGX'],
    subTaskIds: [],
    isDone: false,
    isImportant: false,
    timeEstimate: 7_200_000,
    timeSpent: 3_600_000,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
  };

  function makeData(): AppData {
    const d = emptyAppData();
    d.projects.p1 = { id: 'p1', title: '工作', isArchived: false };
    d.tags.TAGX = { id: 'TAGX', title: '学习' };
    d.tasks.t1 = baseTask;
    return d;
  }

  test('project list groups open and done tasks and omits subtasks', () => {
    const d = makeData();
    d.tasks.t2 = { ...baseTask, id: 't2', title: '任务B', isDone: true };
    d.tasks.t3 = { ...baseTask, id: 't3', title: '子任务', parentTaskId: 't1' };
    const md = exportProjectTaskList(d, 'p1');
    expect(md).toContain('# 工作');
    expect(md).toContain('## 进行中');
    expect(md).toContain('## 已做完');
    expect(md).toContain('- [ ] 任务A');
    expect(md).toContain('- [x] 任务B');
    expect(md).not.toContain('子任务');
  });

  test('unknown project throws rather than writing an empty file', () => {
    expect(() => exportProjectTaskList(makeData(), 'nope')).toThrow('UNKNOWN_PROJECT');
  });

  test('worklog reports a per-day total and stays empty when nothing was spent', () => {
    const d = makeData();
    d.tasks.t1 = { ...baseTask, timeSpentOnDay: { '2026-08-03': 3_600_000 } };
    const md = exportWorklog(d, { from: '2026-08-01', to: '2026-08-31' });
    expect(md).toContain('# 工作日志 2026-08-01 ~ 2026-08-31');
    expect(md).toContain('## 2026-08-03（合计 1h）');
    expect(md).toContain('- 任务A | 1h');
    expect(exportWorklog(d, { from: '2020-01-01', to: '2020-01-02' })).toContain(
      '该时间段没有工作记录。',
    );
  });
});

/**
 * A completed task needs a completion time.
 *
 * Super Productivity's backup does not carry one, so an imported task arrived
 * as `isDone: true` with `doneAt` undefined. `upsertTaskWithTiming` resolves
 * `incoming.doneAt ?? stored?.doneAt ?? now`, so the first edit after an import
 * stamped the current time onto a task completed years ago: it reported
 * "做完于 今天" and landed in today's done group for work that was not done
 * today.
 */
describe('imported completed tasks carry a completion time', () => {
  const backupWith = (task: Record<string, unknown>) => ({
    data: {
      task: { entities: { t1: { title: '旧任务', ...task } } },
      project: { entities: {} },
      tag: { entities: {} },
    },
  });

  test('a done task without doneAt falls back to its created time', () => {
    const created = Date.UTC(2023, 4, 17);
    const { data } = normalizeBackup(backupWith({ isDone: true, created }));
    expect(data.tasks.t1?.isDone).toBe(true);
    expect(data.tasks.t1?.doneAt).toBe(created);
  });

  test('an explicit doneAt is preserved', () => {
    const doneAt = Date.UTC(2024, 0, 2);
    const { data } = normalizeBackup(backupWith({ isDone: true, doneAt, created: 1 }));
    expect(data.tasks.t1?.doneAt).toBe(doneAt);
  });

  test('an open task has no completion time', () => {
    const { data } = normalizeBackup(backupWith({ isDone: false, created: 1 }));
    expect(data.tasks.t1?.isDone).toBe(false);
    expect(data.tasks.t1?.doneAt).toBeUndefined();
  });
});
