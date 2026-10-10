import { beforeEach, describe, expect, test } from 'bun:test';
import { dropStaleTiming, emptyAppData } from '@tiny-schedule/shared';
import { DataStore } from '@/bridge/dataStore';
import { MemoryFs } from '@/bridge/fsAdapter';
import { installTauriMocks } from '@/test/tauriMocks';

/**
 * The dialog and fs plugins are mocked at the module boundary so these tests
 * drive the real `importRun` / `exportMarkdown` / `selectAvatar` bodies and
 * only fake the OS. What is under test is the sequence — read, confirm,
 * merge, persist, announce — not the plugin wiring.
 */

// What `plugin-dialog`'s `open`/`save` will hand back, and whether the user
// accepts the merge prompt.
let openResult: string | null = null;
let saveResult: string | null = null;
let askResult = true;
let askedCount = 0;

const files = new Map<string, string>();
const bytes = new Map<string, Uint8Array>();
let writeLog: { path: string; text: string }[] = [];

// The dialog and fs plugins are stubbed through the shared helper, which
// spreads the real module and overrides only the calls under test. An earlier
// version replaced them with hand-written literals, which stripped every other
// export for the whole run — see src/test/tauriMocks.ts.
installTauriMocks({
  dialog: {
    open: async () => openResult,
    save: async () => saveResult,
    ask: async () => {
      askedCount += 1;
      return askResult;
    },
  },
  fs: {
    readTextFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    writeTextFile: async (path: string, text: string) => {
      files.set(path, text);
      writeLog.push({ path, text });
    },
    readFile: async (path: string) => {
      const data = bytes.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      return data;
    },
  },
});

// Only `./files` is imported dynamically, and only because it must resolve
// *after* the plugin stubs above are registered — `mock.module` is not hoisted
// above static imports in bun.
const { createFilesApi } = await import('./files');

const DIR = '/data';
const BACKUP = '/Users/me/Downloads/backup.json';
const AVATAR = '/Users/me/Pictures/me.JPG';

/** The real Super Productivity backup shape, trimmed to one task. */
const backup = {
  data: {
    task: { entities: { t1: { title: '写周报', projectId: 'p1', tagIds: [] } } },
    project: { entities: { p1: { title: '工作' } } },
    tag: { entities: {} },
  },
};

async function setup() {
  const fs = new MemoryFs();
  const store = await DataStore.open(DIR, fs);
  await store.save(emptyAppData());
  return store;
}

/** Gives the store one local task, so the merge prompt has a reason to fire. */
async function seedLocalTask(store: Awaited<ReturnType<typeof setup>>) {
  await store.update((d) => ({
    ...d,
    tasks: {
      ...d.tasks,
      local1: {
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
      },
    },
  }));
  return store;
}

describe('importRun', () => {
  beforeEach(() => {
    openResult = BACKUP;
    askResult = true;
    askedCount = 0;
    files.clear();
    writeLog = [];
    files.set(BACKUP, JSON.stringify(backup));
  });

  test('merges the backup into an empty store and persists it', async () => {
    const store = await setup();
    const api = createFilesApi(store);
    expect(await api.importRun()).toEqual({
      ok: true,
      // 2, not 1: the backup has no Inbox project, and `normalizeBackup`
      // synthesizes one so imported tasks always have a project to land in.
      counts: { tasks: 1, projects: 2, tags: 0 },
    });
    const saved = await store.get();
    expect(saved.tasks.t1?.title).toBe('写周报');
    expect(saved.projects.p1?.title).toBe('工作');
  });

  test('cancelling the picker is a CANCELLED result, not a write', async () => {
    const store = await setup();
    openResult = null;
    expect(await createFilesApi(store).importRun()).toEqual({ ok: false, error: 'CANCELLED' });
    expect(Object.keys((await store.get()).tasks)).toHaveLength(0);
  });

  test('asks before merging into a store that already has tasks', async () => {
    const store = await seedLocalTask(await setup());
    expect(await createFilesApi(store).importRun()).toEqual({
      ok: true,
      counts: { tasks: 1, projects: 2, tags: 0 },
    });
    const saved = await store.get();
    // The prompt exists precisely so the merge is never a surprise.
    expect(Object.keys(saved.tasks).sort()).toEqual(['local1', 't1']);
  });

  test('declining the merge prompt leaves the store untouched', async () => {
    const store = await seedLocalTask(await setup());
    askResult = false;
    expect(await createFilesApi(store).importRun()).toEqual({ ok: false, error: 'CANCELLED' });
    const saved = await store.get();
    expect(Object.keys(saved.tasks)).toEqual(['local1']);
  });

  test('an empty store imports without ever showing the prompt', async () => {
    const store = await setup();
    expect(askedCount).toBe(0);
    await createFilesApi(store).importRun();
    // Importing into nothing is not a conflict, so the confirmation must not
    // appear — an unnecessary modal on first run would be a regression.
    expect(askedCount).toBe(0);
    expect((await store.get()).tasks.t1).toBeDefined();
  });

  test('a malformed file reports the parse error instead of throwing', async () => {
    const store = await setup();
    files.set(BACKUP, '{not json');
    const result = await createFilesApi(store).importRun();
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toBeTruthy();
  });

  test('a valid-JSON file that is not a backup reports INVALID_BACKUP', async () => {
    const store = await setup();
    files.set(BACKUP, JSON.stringify({ hello: 'world' }));
    const result = await createFilesApi(store).importRun();
    expect(result).toEqual({ ok: false, error: 'INVALID_BACKUP: missing data object' });
  });

  test('a timer on a task the import overwrites is dropped and announced', async () => {
    const store = await setup();
    await store.update((d) => ({
      ...d,
      tasks: {
        ...d.tasks,
        t1: {
          id: 't1',
          title: '写周报',
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
        },
      },
      activeTimer: { taskId: 't1', startedAt: 1, accumulatedMs: 0, isPaused: false },
    }));
    // The imported t1 is not done, so the timer survives and nothing is announced.
    let announced = 0;
    const api = createFilesApi(store, { onTimerChanged: () => (announced += 1) });
    await api.importRun();
    expect((await store.get()).activeTimer?.taskId).toBe('t1');
    expect(announced).toBe(0);
  });

  test('a done task imported over a running timer is swept and announced', async () => {
    const store = await setup();
    await store.update((d) => ({
      ...d,
      tasks: {
        ...d.tasks,
        t1: {
          id: 't1',
          title: '写周报',
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
        },
      },
      activeTimer: { taskId: 't1', startedAt: 1, accumulatedMs: 0, isPaused: false },
    }));
    files.set(
      BACKUP,
      JSON.stringify({
        data: {
          task: { entities: { t1: { title: '写周报', isDone: true } } },
          project: { entities: {} },
          tag: { entities: {} },
        },
      }),
    );
    let announced = 0;
    const api = createFilesApi(store, { onTimerChanged: () => (announced += 1) });
    await api.importRun();
    const saved = await store.get();
    expect(saved.tasks.t1?.isDone).toBe(true);
    expect(saved.activeTimer).toBeNull();
    expect(announced).toBe(1);
    // The same invariant the data slice enforces on taskUpsert.
    expect(dropStaleTiming(saved).activeTimer).toBeNull();
  });
});

describe('exportMarkdown', () => {
  beforeEach(() => {
    saveResult = null;
    writeLog = [];
  });

  async function seeded() {
    const store = await setup();
    await store.update((d) => ({
      ...d,
      projects: { ...d.projects, p1: { id: 'p1', title: '工作', isArchived: false } },
      tasks: {
        ...d.tasks,
        t1: {
          id: 't1',
          title: '任务A',
          projectId: 'p1',
          tagIds: [],
          subTaskIds: [],
          isDone: false,
          isImportant: false,
          timeEstimate: 0,
          timeSpent: 0,
          timeSpentOnDay: {},
          timeEntries: [],
          notes: '',
          created: 0,
        },
      },
    }));
    return store;
  }

  test('writes the project list to the chosen path', async () => {
    saveResult = '/Users/me/Desktop/工作-任务清单.md';
    const result = await createFilesApi(await seeded()).exportMarkdown({
      mode: 'projectList',
      projectId: 'p1',
    });
    expect(result).toEqual({ savedPath: '/Users/me/Desktop/工作-任务清单.md' });
    expect(writeLog).toHaveLength(1);
    expect(writeLog[0]?.text).toContain('# 工作');
    expect(writeLog[0]?.text).toContain('- [ ] 任务A');
  });

  test('projectList without a projectId is refused before the dialog opens', async () => {
    const result = await createFilesApi(await seeded()).exportMarkdown({ mode: 'projectList' });
    expect(result).toEqual({ savedPath: null, error: 'MISSING_PROJECT_ID' });
    expect(writeLog).toEqual([]);
  });

  test('an unknown project surfaces the exporter error, not a written file', async () => {
    const result = await createFilesApi(await seeded()).exportMarkdown({
      mode: 'projectList',
      projectId: 'nope',
    });
    expect(result).toEqual({ savedPath: null, error: 'UNKNOWN_PROJECT: nope' });
    expect(writeLog).toEqual([]);
  });

  test('cancelling the save dialog writes nothing and reports no error', async () => {
    saveResult = null;
    const result = await createFilesApi(await seeded()).exportMarkdown({
      mode: 'projectList',
      projectId: 'p1',
    });
    // No `error` key: the UI tells cancel apart from failure by its absence.
    expect(result).toEqual({ savedPath: null });
    expect(writeLog).toEqual([]);
  });

  test('worklog mode defaults the window to the full range', async () => {
    saveResult = '/tmp/log.md';
    const store = await setup();
    await store.update((d) => ({
      ...d,
      tasks: {
        ...d.tasks,
        t1: {
          id: 't1',
          title: '任务A',
          projectId: 'p1',
          tagIds: [],
          subTaskIds: [],
          isDone: false,
          isImportant: false,
          timeEstimate: 0,
          timeSpent: 3_600_000,
          timeSpentOnDay: { '2026-08-03': 3_600_000 },
          timeEntries: [],
          notes: '',
          created: 0,
        },
      },
    }));
    const result = await createFilesApi(store).exportMarkdown({ mode: 'worklog' });
    expect(result.savedPath).toBe('/tmp/log.md');
    expect(writeLog[0]?.text).toContain('# 工作日志 1970-01-01 ~ 2999-12-31');
  });
});

describe('selectAvatar', () => {
  beforeEach(() => {
    openResult = AVATAR;
    bytes.clear();
    bytes.set(AVATAR, new Uint8Array([1, 2, 3, 250]));
  });

  test('returns a data URL with the mime derived from the extension', async () => {
    expect(await createFilesApi(await setup()).selectAvatar()).toBe(
      `data:image/jpeg;base64,${Buffer.from([1, 2, 3, 250]).toString('base64')}`,
    );
  });

  test('jpg and jpeg both map to image/jpeg, others to image/<ext>', async () => {
    const api = createFilesApi(await setup());
    for (const [path, mime] of [
      ['/a/b.png', 'image/png'],
      // The extension is lowercased before the mime is derived, so an
      // upper-case pick from the OS does not produce `image/WEBP`.
      ['/a/b.WebP', 'image/webp'],
      ['/a/b.jpeg', 'image/jpeg'],
      ['/a/b.gif', 'image/gif'],
    ] as const) {
      bytes.set(path, new Uint8Array([1, 2, 3]));
      openResult = path;
      expect(await api.selectAvatar()).toMatch(
        new RegExp(`^data:${mime.replace('/', '\\/')};base64,`),
      );
    }
  });

  test('cancelling the picker returns null', async () => {
    openResult = null;
    expect(await createFilesApi(await setup()).selectAvatar()).toBeNull();
  });
});
