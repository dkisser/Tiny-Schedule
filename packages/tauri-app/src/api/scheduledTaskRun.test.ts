import { describe, expect, test } from 'bun:test';
import { type AppData, emptyAppData, type ScheduledTask } from '@tiny-schedule/shared';
import { silentLogger } from '@/ai/logger';
import { DataStore } from '@/bridge/dataStore';
import { MemoryFs } from '@/bridge/fsAdapter';
import { installTauriMocks } from '@/test/tauriMocks';
import { createScheduledTaskRunApi } from './scheduledTaskRun';

/**
 * The slice wires the real runner to the real store, so the only thing mocked
 * here is the host: `invoke` and the notification plugin. Everything that can go
 * wrong in this file is this file's own logic — the overlap guard and the three
 * result branches.
 */
installTauriMocks({
  notification: {
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
    sendNotification: async () => undefined,
  },
});

const TASK: ScheduledTask = {
  id: 'st1',
  name: '每日汇总',
  prompt: '汇总今天的提交',
  schedule: { kind: 'daily', time: '09:00' },
  workingDirectory: '/repo',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const PROVIDER = {
  id: 'p1',
  registryId: 'openai',
  apiKeyEncrypted: '',
  model: 'gpt-4o-mini',
  isDefault: true,
};

function seed(): AppData {
  const base = emptyAppData();
  return {
    ...base,
    scheduledTasks: { st1: TASK },
    settings: { ...base.settings, aiProviders: [PROVIDER] },
  } as AppData;
}

async function openApi() {
  const fs = new MemoryFs();
  const store = await DataStore.open('/data', fs);
  await store.save(seed());
  await store.load();
  return { store, api: createScheduledTaskRunApi({ store, logger: silentLogger }) };
}

describe('scheduledTaskRunNow', () => {
  test('an unknown task id reports TASK_NOT_FOUND and records nothing', async () => {
    const { store, api } = await openApi();
    const result = await api.scheduledTaskRunNow({ taskId: 'ghost' });
    expect(result).toEqual({ ok: false, error: 'TASK_NOT_FOUND' });
    // Nothing ran, so nothing to audit — the branch exists so the caller can
    // tell "this task is gone" from "this task failed".
    expect(Object.keys((await store.get()).runs)).toHaveLength(0);
  });

  test('a task with no configured provider fails the run, and the record says why', async () => {
    const { store, api } = await openApi();
    const data = await store.get();
    await store.save({ ...data, settings: { ...data.settings, aiProviders: [] } });

    const result = await api.scheduledTaskRunNow({ taskId: 'st1' });

    expect(result.ok).toBe(false);
    if (!result.ok && 'run' in result) {
      expect(result.run.status).toBe('failed');
      expect(result.error).toBe('NO_PROVIDER_CONFIGURED');
    }
    expect(Object.keys((await store.get()).runs)).toHaveLength(1);
  });

  test("the run lands in the store, so it shows up in that task's history", async () => {
    const { store, api } = await openApi();
    const result = await api.scheduledTaskRunNow({ taskId: 'st1' });
    if (result.ok || !('run' in result)) throw new Error('expected a failed run with a record');

    const stored = (await store.get()).runs[result.run.id];
    expect(stored?.id).toBe(result.run.id);
    expect(stored?.scheduledTaskId).toBe('st1');
    expect(stored?.trigger).toBe('manual');
  });

  test('a disabled task can still be run by hand — pressing the button is not a trigger', async () => {
    // 停用 means "no longer triggers". The scheduler checks `enabled`; a manual
    // run is the user asking for this one specifically.
    const { store, api } = await openApi();
    const data = await store.get();
    await store.save({
      ...data,
      scheduledTasks: { st1: { ...TASK, enabled: false } },
    });

    const result = await api.scheduledTaskRunNow({ taskId: 'st1' });
    expect('run' in result).toBe(true);
  });

  test('a second runNow while one is in flight records a skipped run, not a second execution', async () => {
    // 重叠保护是调用方的职责，而手动入口就是这个调用方。狂点"立即运行"得到的是
    // 一串 skipped 记录，而不是几个并行的 Agent 拿着同样的全部工具权限互相踩。
    const { store, api } = await openApi();
    const [first, second] = await Promise.all([
      api.scheduledTaskRunNow({ taskId: 'st1' }),
      api.scheduledTaskRunNow({ taskId: 'st1' }),
    ]);

    const statuses = [
      'run' in first ? first.run.status : 'none',
      'run' in second ? second.run.status : 'none',
    ].sort();
    expect(statuses).toEqual(['failed', 'skipped']);

    const runs = Object.values((await store.get()).runs);
    expect(runs).toHaveLength(2);
    const skipped = runs.find((r) => r.status === 'skipped');
    expect(skipped?.output).toBe('');
    expect(skipped?.toolCalls).toEqual([]);
    expect(skipped?.finishedAt).toBe(skipped?.startedAt);
  });

  test('a malformed request is refused at the wire, before the store is touched', async () => {
    const { store, api } = await openApi();
    expect(() => api.scheduledTaskRunNow({ taskId: '' })).toThrow();
    expect(Object.keys((await store.get()).runs)).toHaveLength(0);
  });
});
