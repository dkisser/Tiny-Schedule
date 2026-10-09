import { describe, expect, test } from 'bun:test';
import { type AppData, emptyAppData, INBOX_PROJECT_ID } from '@tiny-schedule/shared';
import { DataStore } from '@/bridge/dataStore';
import { joinPath, MemoryFs } from '@/bridge/fsAdapter';
import { _resetKeyCacheForTest, initKeyStore } from '@/bridge/keys';
import { createDataApi } from './data';

const DIR = '/data';

function task(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: INBOX_PROJECT_ID,
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
    title: `task ${id}`,
    ...overrides,
  } as AppData['tasks'][string];
}

async function setup() {
  _resetKeyCacheForTest();
  const fs = new MemoryFs();
  await initKeyStore(DIR, fs);
  const store = await DataStore.open(DIR, fs);
  await store.save(emptyAppData());
  return { fs, store, api: createDataApi(store), dataPath: joinPath(DIR, 'data.json') };
}

describe('data api slice', () => {
  test('implements exactly the 17 data invokes and nothing else', async () => {
    const { api } = await setup();
    for (const key of [
      'dataLoad',
      'taskUpsert',
      'taskDelete',
      'followUpUpsert',
      'followUpDelete',
      'ideaUpsert',
      'ideaDelete',
      'orderSet',
      'projectCreate',
      'projectUpdate',
      'projectDelete',
      'tagCreate',
      'tagUpdate',
      'tagDelete',
      'settingsUpdate',
      'finishDay',
      'timerSync',
    ]) {
      expect(typeof api[key as keyof typeof api]).toBe('function');
    }
    expect(Object.keys(api).sort()).toHaveLength(17);
  });

  test('dataLoad returns masked data — no apiKeyEncrypted reaches the renderer', async () => {
    const { api } = await setup();
    await api.settingsUpdate({
      userName: 'u',
      aiProviders: [
        {
          id: 'p1',
          registryId: 'openai',
          apiKey: 'sk-secret-value',
          model: 'gpt',
          isDefault: true,
        },
      ],
    } as never);

    const loaded = await api.dataLoad();
    expect(loaded.settings.aiProviders[0]?.apiKeyEncrypted).toBe('');
    expect(loaded.settings.aiProviders[0]?.hasApiKey).toBe(true);
  });

  test('task CRUD round-trips and persists to disk', async () => {
    const { api, fs, dataPath } = await setup();

    const created = await api.taskUpsert(task('t1', { title: '买牛奶' }) as never);
    expect(created.data.tasks.t1?.title).toBe('买牛奶');

    const afterRead = await api.dataLoad();
    expect(afterRead.tasks.t1?.title).toBe('买牛奶');

    await api.taskUpsert(task('t1', { title: '买面包' }) as never);
    expect((await api.dataLoad()).tasks.t1?.title).toBe('买面包');

    const deleted = await api.taskDelete({ id: 't1' });
    expect(deleted.tasks.t1).toBeUndefined();

    // Persisted, not just cached.
    const raw = JSON.parse(await fs.readText(dataPath));
    expect(raw.tasks.t1).toBeUndefined();
  });

  test('taskDelete detaches the id from a parent subTaskIds list', async () => {
    const { api } = await setup();
    await api.taskUpsert(task('child') as never);
    await api.taskUpsert(task('parent', { subTaskIds: ['child'] }) as never);

    const after = await api.taskDelete({ id: 'child' });
    expect(after.tasks.parent?.subTaskIds).toEqual([]);
  });

  test('taskUpsert settles the running timer when a task is completed', async () => {
    const { api, store } = await setup();
    await api.taskUpsert(task('t1', { timeSpent: 4000 }) as never);
    // A timer must actually be running, otherwise there is nothing to settle.
    await api.timerSync({
      timer: {
        taskId: 't1',
        startedAt: Date.now() - 30_000,
        accumulatedMs: 30_000,
        isPaused: false,
      },
    } as never);

    const res = await api.taskUpsert(
      task('t1', { isDone: true, timeSpent: 4000, timeEstimate: 60_000 }) as never,
    );

    expect(res.settledMs).toBeGreaterThan(0);
    expect(res.data.tasks.t1?.isDone).toBe(true);
    // Settling must also clear the timer, or a done task stays "being timed".
    expect((await store.get()).activeTimer).toBeNull();
  });

  test('re-saving an already-done task settles nothing', async () => {
    const { api } = await setup();
    await api.taskUpsert(task('t1', { isDone: true }) as never);

    const res = await api.taskUpsert(task('t1', { isDone: true, title: 'renamed' }) as never);
    expect(res.settledMs).toBe(0);
  });

  test('rejects a malformed request before it reaches the store', async () => {
    const { api } = await setup();
    // Contract requires a non-empty id.
    await expect(api.taskDelete({ id: '' })).rejects.toThrow();
  });

  test('projectCreate truncates the title and assigns an id', async () => {
    const { api } = await setup();
    const long = 'x'.repeat(100);
    const next = await api.projectCreate({ title: long } as never);

    const created = Object.values(next.projects).find((p) => p.id !== INBOX_PROJECT_ID);
    expect(created?.title).toHaveLength(32);
  });

  test('projectUpdate refuses to modify the system Inbox project', async () => {
    const { api } = await setup();
    const before = await api.dataLoad();
    const inboxBefore = before.projects[INBOX_PROJECT_ID];

    const after = await api.projectUpdate({ id: INBOX_PROJECT_ID, title: 'hijacked' } as never);
    expect(after.projects[INBOX_PROJECT_ID]).toEqual(inboxBefore);
  });

  test('projectUpdate applies only the fields present in the request', async () => {
    const { api } = await setup();
    const created = await api.projectCreate({ title: 'Original', primaryColor: 'red' } as never);
    const id = Object.values(created.projects).find((p) => p.title === 'Original')?.id as string;

    const updated = await api.projectUpdate({ id, title: 'Renamed' } as never);
    expect(updated.projects[id]?.title).toBe('Renamed');
    // primaryColor was absent from the request, so it must survive untouched.
    expect(updated.projects[id]?.primaryColor).toBe('red');
  });

  test('projectDelete moves its tasks to Inbox', async () => {
    const { api } = await setup();
    const created = await api.projectCreate({ title: 'Doomed' } as never);
    const id = Object.values(created.projects).find((p) => p.title === 'Doomed')?.id as string;
    await api.taskUpsert(task('t1', { projectId: id }) as never);

    const after = await api.projectDelete({ id } as never);
    expect(after.projects[id]).toBeUndefined();
    expect(after.tasks.t1?.projectId).toBe(INBOX_PROJECT_ID);
  });

  test('tagDelete keeps task tagIds so chips stay visible', async () => {
    const { api } = await setup();
    const created = await api.tagCreate({ title: 'Urgent' } as never);
    const tagId = Object.keys(created.tags).find(
      (k) => created.tags[k]?.title === 'Urgent',
    ) as string;
    await api.taskUpsert(task('t1', { tagIds: [tagId] }) as never);

    const after = await api.tagDelete({ id: tagId } as never);
    expect(after.tags[tagId]).toBeUndefined();
    expect(after.tasks.t1?.tagIds).toEqual([tagId]);
  });

  test('settingsUpdate encrypts a new api key and keeps an unchanged one', async () => {
    const { api, store } = await setup();
    await api.settingsUpdate({
      aiProviders: [
        { id: 'p1', registryId: 'openai', apiKey: 'sk-first', model: 'gpt', isDefault: true },
      ],
    } as never);

    const withKey = await store.get();
    const cipher = withKey.settings.aiProviders[0]?.apiKeyEncrypted as string;
    expect(cipher.startsWith('v2:')).toBe(true);
    expect(cipher).not.toContain('sk-first');

    await api.settingsUpdate({
      aiProviders: [
        {
          id: 'p1',
          registryId: 'openai',
          apiKey: '<unchanged>',
          model: 'gpt-2',
          isDefault: true,
        },
      ],
    } as never);

    const after = await store.get();
    expect(after.settings.aiProviders[0]?.apiKeyEncrypted).toBe(cipher);
    expect(after.settings.aiProviders[0]?.model).toBe('gpt-2');
  });

  test('orderSet stores per-view ordering without touching tasks', async () => {
    const { api } = await setup();
    await api.taskUpsert(task('a') as never);
    await api.taskUpsert(task('b') as never);

    await api.orderSet({ viewKey: 'today', ids: ['b', 'a'] });
    const after = await api.dataLoad();

    expect(after.misc.taskOrder).toEqual({ today: ['b', 'a'] });
    expect(Object.keys(after.tasks).sort()).toEqual(['a', 'b']);
  });

  test('finishDay rolls unfinished due-today tasks to tomorrow', async () => {
    const { api } = await setup();
    const today = new Date().toISOString().slice(0, 10);
    await api.taskUpsert(task('t1', { dueDay: today }) as never);
    await api.taskUpsert(
      task('done', { dueDay: today, isDone: true, doneAt: Date.now() }) as never,
    );

    const after = await api.finishDay({ date: today } as never);

    expect(after.tasks.t1?.dueDay).not.toBe(today);
    expect(after.tasks.done?.dueDay).toBe(today);
    expect(after.misc.lastFinishDay).toBe(today);
  });

  test('timerSync refuses to persist a timer for an already-done task', async () => {
    const { api, store } = await setup();
    await api.taskUpsert(task('done', { isDone: true, doneAt: Date.now() }) as never);

    await api.timerSync({
      timer: {
        taskId: 'done',
        startedAt: Date.now() - 5000,
        accumulatedMs: 5000,
        isPaused: false,
      },
    } as never);

    expect((await store.get()).activeTimer).toBeNull();
  });

  test('timerSync persists a valid timer', async () => {
    const { api, store } = await setup();
    await api.taskUpsert(task('live') as never);

    await api.timerSync({
      timer: {
        taskId: 'live',
        startedAt: Date.now() - 5000,
        accumulatedMs: 5000,
        isPaused: false,
      },
    } as never);

    expect((await store.get()).activeTimer?.taskId).toBe('live');
  });

  test('followUp and idea CRUD round-trip', async () => {
    const { api } = await setup();
    const followUp = {
      id: 'f1',
      title: '跟进',
      notes: '',
      entries: [],
      createdAt: 1,
      nextFollowUpDay: undefined,
      isResolved: false,
      resolvedAt: undefined,
    };
    await api.followUpUpsert(followUp as never);
    expect((await api.dataLoad()).followUps.f1?.title).toBe('跟进');
    expect((await api.followUpDelete({ id: 'f1' })).followUps.f1).toBeUndefined();

    const idea = {
      id: 'i1',
      createdAt: 1,
      title: '一个想法',
      notes: '',
      result: 'validated',
      text: '结论',
      closedAt: 0,
    };
    await api.ideaUpsert(idea as never);
    expect((await api.dataLoad()).ideas.i1?.title).toBe('一个想法');
    expect((await api.ideaDelete({ id: 'i1' })).ideas.i1).toBeUndefined();
  });
});
