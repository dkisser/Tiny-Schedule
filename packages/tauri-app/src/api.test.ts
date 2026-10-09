import { describe, expect, test } from 'bun:test';
import {
  DROPPED_TIMER,
  emptyAppData,
  IpcInvokeContract,
  type IpcInvokeKey,
  REFUSED_TIMER,
  type RendererApi,
  type Task,
  type TimerChangedPayload,
} from '@tiny-schedule/shared';
import { DataStore } from '@/bridge/dataStore';
import { MemoryFs } from '@/bridge/fsAdapter';
import { installTauriMocks } from '@/test/tauriMocks';

/**
 * Contract completeness for the assembled renderer API.
 *
 * The point of this file is to make the failure mode that `createApi` was
 * written to eliminate impossible to reintroduce: a slice that forgets a key,
 * or a key left throwing `not implemented`, both show up here as a missing
 * method rather than as a blank window or a toast nobody can explain.
 *
 * The Tauri host is stubbed through the shared helper so this file publishes
 * every real export of each module it touches — see `src/test/tauriMocks.ts`
 * for why that matters to a run that loads many test files.
 */
installTauriMocks();

// Imported dynamically: `./api` resolves after the stubs are registered.
const { CONTRACT_INVOKE_KEYS, CONTRACT_SUBSCRIPTION_KEYS, createApi } = await import('./api');

async function buildApi(): Promise<RendererApi> {
  const fs = new MemoryFs();
  const store = await DataStore.open('/data', fs);
  await store.save(emptyAppData());
  return createApi({ store });
}

/** A throwing stub's message, matched instead of a snapshot of the text. */
const STUB_PATTERN = /not implemented/i;

describe('contract completeness', () => {
  test('the contract is 35 invokes and 5 subscriptions', () => {
    // Pinned so a change to packages/shared cannot quietly shrink the surface
    // this file claims to cover.
    expect(CONTRACT_INVOKE_KEYS).toHaveLength(35);
    expect(CONTRACT_SUBSCRIPTION_KEYS).toHaveLength(5);
    expect(CONTRACT_INVOKE_KEYS).toEqual(Object.keys(IpcInvokeContract) as IpcInvokeKey[]);
  });

  test('every invoke key is present and callable', async () => {
    const api = await buildApi();
    const missing = CONTRACT_INVOKE_KEYS.filter((key) => typeof api[key] !== 'function');
    expect(missing).toEqual([]);
  });

  test('every subscription is present and callable', async () => {
    const api = await buildApi();
    const missing = CONTRACT_SUBSCRIPTION_KEYS.filter(
      (key) => typeof api[key as keyof RendererApi] !== 'function',
    );
    expect(missing).toEqual([]);
  });

  test('no invoke is a throwing stub', async () => {
    const api = await buildApi();
    // The stubs that used to live here all shared one closure, so identity
    // alone would prove little; the message check is what actually pins it.
    const stubs = CONTRACT_INVOKE_KEYS.filter((key) => STUB_PATTERN.test(String(api[key])));
    expect(stubs).toEqual([]);
  });

  test('the object has exactly the contract keys and nothing else', async () => {
    const api = await buildApi();
    expect(Object.keys(api).sort()).toEqual(
      [...CONTRACT_INVOKE_KEYS, ...CONTRACT_SUBSCRIPTION_KEYS].sort(),
    );
  });
});

describe('slices partition the contract', () => {
  test('no key is claimed by two slices, and none is unclaimed', async () => {
    const api = await buildApi();
    // Composed by spread, so a duplicate key would silently win. Counting the
    // surfaces each slice contributes catches an overlap the type system
    // cannot: `Pick<RendererApi, ...>` says nothing about two slices picking
    // the same member.
    const { createDataApi } = await import('@/api/data');
    const { createAiApi } = await import('@/api/ai');
    const { createFilesApi } = await import('@/api/files');
    const { createSystemApi } = await import('@/api/system');
    const { createTimerApi } = await import('@/api/timer');
    const { createWindowApi } = await import('@/api/window');

    const fs = new MemoryFs();
    const store = await DataStore.open('/data', fs);
    await store.save(emptyAppData());

    const slices: Record<string, object> = {
      data: createDataApi(store),
      ai: createAiApi({ store }),
      files: createFilesApi(store),
      system: createSystemApi(store, {}),
      timer: createTimerApi(),
      window: createWindowApi(),
    };

    const seen = new Map<string, string[]>();
    for (const [name, slice] of Object.entries(slices)) {
      for (const key of Object.keys(slice)) {
        seen.set(key, [...(seen.get(key) ?? []), name]);
      }
    }
    // `onTimerChanged` is owned by `api.ts` rather than by any slice: its only
    // producer is the local bus, so the timer slice has no channel to listen on.
    expect(seen.has('onTimerChanged')).toBe(false);
    expect(typeof api.onTimerChanged).toBe('function');

    const duplicated = [...seen].filter(([, owners]) => owners.length > 1).map(([key]) => key);
    const unclaimed = CONTRACT_INVOKE_KEYS.filter((key) => !seen.has(key) && !(key in api));
    expect(duplicated).toEqual([]);
    expect(unclaimed).toEqual([]);
  });
});

describe('the local timer-changed channel', () => {
  const task = (over: Partial<Task> = {}): Task => ({
    id: 't1',
    title: '计时任务',
    projectId: 'inbox',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 1,
    ...over,
  });
  const running = { taskId: 't1', startedAt: 1, accumulatedMs: 0, isPaused: false };

  /** A task that is already done, so the store will refuse to time it. */
  async function withDoneTask(api: RendererApi): Promise<void> {
    await api.taskUpsert(task({ isDone: true, doneAt: 1 }));
  }

  test('a swept timer reaches onTimerChanged subscribers as DROPPED_TIMER', async () => {
    // The renderer started a clock; the store dropped the timing because the
    // task was already done. Without the announcement the clock keeps ticking
    // against a timer nothing persisted.
    const api = await buildApi();
    await withDoneTask(api);
    const seen: TimerChangedPayload[] = [];
    api.onTimerChanged((payload) => seen.push(payload));
    await api.timerSync({ timer: running });
    expect(seen).toEqual([DROPPED_TIMER]);
    expect((await api.dataLoad()).activeTimer).toBeNull();
  });

  test('a refused write announces REFUSED_TIMER, not a drop', async () => {
    // The case ADR-0004 exists for. data.json will not parse, so the store
    // latches read-only and the sync writes nothing. The timer's absence from
    // the store looks identical to a completed task's, but announcing a drop
    // would clear a clock the user never stopped — so the payload has to say
    // "not saved" and leave the decision to the banner.
    const fs = new MemoryFs();
    await fs.mkdir('/data');
    await fs.writeText('/data/data.json', '{ truncated');
    const store = await DataStore.open('/data', fs);
    await store.load();
    const api = createApi({ store });
    expect(store.isWritable).toBe(false);

    const seen: TimerChangedPayload[] = [];
    api.onTimerChanged((payload) => seen.push(payload));
    await api.timerSync({ timer: running });

    expect(seen).toEqual([REFUSED_TIMER]);
  });

  test('a kept timer announces nothing', async () => {
    const api = await buildApi();
    await api.taskUpsert(task());
    const seen: TimerChangedPayload[] = [];
    api.onTimerChanged((payload) => seen.push(payload));
    await api.timerSync({ timer: running });
    expect(seen).toEqual([]);
    expect((await api.dataLoad()).activeTimer?.taskId).toBe('t1');
  });

  test('clearing the timer announces nothing', async () => {
    // `timerSync({timer: null})` is a write the caller already knows about;
    // announcing it back would be noise, and the caller's own state is the
    // authority.
    const api = await buildApi();
    await api.taskUpsert(task());
    await api.timerSync({ timer: running });
    const seen: TimerChangedPayload[] = [];
    api.onTimerChanged((payload) => seen.push(payload));
    await api.timerSync({ timer: null });
    expect(seen).toEqual([]);
  });

  test('unsubscribing detaches the local bus', async () => {
    const api = await buildApi();
    await withDoneTask(api);
    let notified = 0;
    const off = api.onTimerChanged(() => {
      notified += 1;
    });
    off();
    await api.timerSync({ timer: running });
    expect(notified).toBe(0);
  });
});
