import { beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  type AppData,
  AppDataSchema,
  DROPPED_TIMER,
  emptyAppData,
  Ipc,
  IpcChatEventChannels,
  IpcEventChannels,
  IpcInvokeContract,
  IpcUiEventChannels,
  REFUSED_TIMER,
} from '@tiny-schedule/shared';
import type { Logger } from 'pino';
import type { DataStore } from '../src/main/infra/dataStore';
import { mockElectron } from './fixtures/electronMock';

// IPC contract test: catches the two failure classes the type system cannot
// see across the process boundary —
//   S1: preload invokes a channel main never registered
//   S5: main/preload disagree on the event channels
// (S2/S3/S6 are compile errors via IpcInvokeContract; S4 is scripts/check-ipc-literals.ts.)

const registered = new Set<string>();
const invoked = new Set<string>();
/** Direct handle on the store the handlers were wired to, for seeding/asserting. */
let storeRef: DataStore;
const listened = new Set<string>();
/** The registered ipcRenderer listeners, so a test can deliver a push for real. */
const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
// Keep the handler so a test can dispatch a real request through it, exactly as
// the renderer would once preload invoked the channel.
const handlerFor = new Map<string, (event: unknown, raw: unknown) => unknown>();
let exposedApi: Record<string, (...args: unknown[]) => unknown> | null = null;

mock.module('electron', () =>
  mockElectron({
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, raw: unknown) => unknown) => {
        registered.add(channel);
        handlerFor.set(channel, handler);
      },
    },
    ipcRenderer: {
      invoke: (channel: string) => {
        invoked.add(channel);
        return Promise.resolve();
      },
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
        listened.add(channel);
        listeners.set(channel, listener);
      },
      removeListener: () => {},
    },
    contextBridge: {
      exposeInMainWorld: (_key: string, api: unknown) => {
        exposedApi = api as Record<string, (...args: unknown[]) => unknown>;
      },
    },
  }),
);

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../src/main/ipcHandlers');
  // Faithful DataStore stand-in: update() must reassign, or a service that
  // loads-then-persists would never see its own write — and it must parse,
  // because the real save() does. Skipping the parse made this whole suite
  // blind to every AppDataSchema defect: a zod object strips keys it does not
  // declare, so a handler persisting a pomodoro timer with focusAccumulatedMs
  // passed green here and only corrupted data.json against the real store.
  let data = emptyAppData();
  const store = {
    get: () => data,
    update: (fn: (current: AppData) => AppData) => {
      // Same cast as the real DataStore: zod infers z.unknown() fields as
      // optional in the parsed output type.
      data = AppDataSchema.parse(fn(data)) as AppData;
      return { data, persisted: true };
    },
    // registerIpcHandlers subscribes to push the read-only mode; the real store
    // reports the current state immediately on subscribe.
    onModeChanged: (listener: (writable: boolean, reason: string | null) => void) => {
      listener(true, null);
      return () => {};
    },
  } as unknown as DataStore;
  storeRef = store;
  const logger = { info: () => {}, error: () => {} } as unknown as Logger;
  registerIpcHandlers({ store, logger, getWindow: () => null, getVersion: () => '0.0.0' });
  await import('../src/preload/index');
  expect(exposedApi).not.toBeNull();
  // Exercise every exposed method so all preload channels get recorded.
  for (const fn of Object.values(exposedApi as Record<string, unknown>)) {
    if (typeof fn === 'function') fn(() => {});
  }
});

const contractChannels = Object.values(IpcInvokeContract).map((e) => e.ch);
const allChannels = Object.values(Ipc);
const eventChannels = [...IpcEventChannels, ...IpcChatEventChannels, ...IpcUiEventChannels];

describe('IPC contract', () => {
  test('every channel preload invokes has a handler registered in main (S1)', () => {
    const missing = [...invoked].filter((ch) => !registered.has(ch));
    expect(missing).toEqual([]);
  });

  test('main registers exactly the invoke channels from the contract (S6)', () => {
    expect([...registered].sort()).toEqual([...contractChannels].sort());
  });

  test('no channel outside the shared Ipc table is registered or invoked', () => {
    const known = new Set<string>(allChannels);
    expect([...registered].filter((ch) => !known.has(ch))).toEqual([]);
    expect([...invoked].filter((ch) => !known.has(ch))).toEqual([]);
    expect([...listened].filter((ch) => !known.has(ch))).toEqual([]);
  });

  test('preload listens on exactly the main->renderer event channels (S5)', () => {
    expect([...listened].sort()).toEqual([...eventChannels].sort());
  });

  test('invoke and event channels partition the full Ipc table', () => {
    const leftover = allChannels.filter((ch) => !registered.has(ch) && !listened.has(ch));
    expect(leftover).toEqual([]);
  });

  test('Ipc channels are unique', () => {
    expect(new Set(allChannels).size).toBe(allChannels.length);
  });

  test('preload api exposes every contract method plus event subscribers', () => {
    const keys = Object.keys(exposedApi as object);
    const expected = [
      ...Object.keys(IpcInvokeContract),
      'onAiEvent',
      'onChatEvent',
      'onNewTask',
      'onStoreWritable',
      'onUpdateAvailable',
      'onTimerChanged',
    ];
    expect(keys.sort()).toEqual(expected.sort());
  });

  test('preload hands the renderer both timerChanged branches unchanged', () => {
    // The payload is a discriminated union across a wire this test can check
    // end to end. Preload must not narrow it: re-wrapping or coercing here is
    // how `null` came back for a refusal in the first place, and the two
    // branches have to arrive at the renderer as the two values they are.
    const seen: unknown[] = [];
    (exposedApi as Record<string, (...args: unknown[]) => unknown>).onTimerChanged?.((p: unknown) =>
      seen.push(p),
    );
    const deliver = listeners.get(Ipc.timerChanged);
    if (!deliver) throw new Error('preload never subscribed to timerChanged');
    deliver(null, DROPPED_TIMER);
    deliver(null, REFUSED_TIMER);
    deliver(null, { kind: 'timer', timer: { taskId: 't1', startedAt: 0, accumulatedMs: 0 } });
    expect(seen).toEqual([
      DROPPED_TIMER,
      REFUSED_TIMER,
      { kind: 'timer', timer: { taskId: 't1', startedAt: 0, accumulatedMs: 0 } },
    ]);
  });
});

describe('new command channels dispatch through their real handlers', () => {
  /** Invoke a contract channel the way ipcMain would, including zod parsing. */
  const call = (key: keyof typeof IpcInvokeContract, raw?: unknown) => {
    const entry = IpcInvokeContract[key] as { ch: string; req?: { parse(r: unknown): unknown } };
    const handler = handlerFor.get(entry.ch);
    if (!handler) throw new Error(`no handler registered for ${key}`);
    // ipcMain handlers are (event, request); the event slot is unused here.
    return handler(undefined, entry.req ? entry.req.parse(raw) : raw);
  };

  test('the six idea intent commands are registered on their own channels', () => {
    expect(IpcInvokeContract.ideaComplete.ch).toBe('idea:complete');
    expect(IpcInvokeContract.ideaDiscard.ch).toBe('idea:discard');
    expect(IpcInvokeContract.ideaReopen.ch).toBe('idea:reopen');
    expect(IpcInvokeContract.ideaConvertToTask.ch).toBe('idea:convertToTask');
    expect(IpcInvokeContract.ideaUpgradeToProject.ch).toBe('idea:upgradeToProject');
    expect(IpcInvokeContract.ideaCloseWithVerdict.ch).toBe('idea:closeWithVerdict');
  });

  test('timingStop is registered on the timing:stop channel', () => {
    expect(IpcInvokeContract.timingStop.ch).toBe('timing:stop');
  });

  test('ideaComplete transitions an open idea and reports ok', () => {
    // Seed through the legacy upsert, then drive the intent command.
    call('ideaUpsert', {
      id: 'i1',
      title: '一个想法',
      notes: '',
      createdAt: 1,
      status: 'open',
    });
    const r = call('ideaComplete', { id: 'i1' }) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  test('ideaUpgradeToProject is one atomic command: project and status arrive together', () => {
    call('ideaUpsert', {
      id: 'i2',
      title: '想验证的',
      notes: '',
      createdAt: 1,
      status: 'open',
    });
    const r = call('ideaUpgradeToProject', { id: 'i2', title: '验证项目' }) as {
      ok: boolean;
      projectId?: string;
      data: AppData;
    };
    expect(r.ok).toBe(true);
    expect(r.data.ideas.i2?.status).toBe('incubating');
    expect(r.data.ideas.i2?.projectId).toBe(r.projectId);
    expect(r.data.projects[r.projectId as string]?.title).toBe('验证项目');
  });

  test('ideaComplete rejects a request whose id fails schema validation', () => {
    // zod runs before the handler, so an empty id never reaches the service.
    expect(() => call('ideaComplete', { id: '' })).toThrow();
  });

  test('a missing idea is a domain rejection, not a thrown error', () => {
    const r = call('ideaReopen', { id: 'does-not-exist' });
    expect(r).toEqual({ ok: false, error: 'IDEA_NOT_FOUND' });
  });

  test('timingStop with no running timer reports the reason and the dataset', () => {
    // The rejection carries `data` too: the main process may already have
    // dropped the timer, and the renderer has to converge on that.
    const r = call('timingStop', {}) as { ok: boolean; error: string; data: AppData };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NO_ACTIVE_TIMER');
    expect(r.data.tasks).toBeDefined();
  });

  test('ideaUpsert refuses a request carrying status fields', () => {
    // The narrowed write contract: a status can only be written by a command.
    // A stray `status` in the payload is stripped by zod rather than honoured.
    // Seeds its own id: this used to read `i2` seeded by an earlier test, so
    // it passed in a full run and failed standalone under `-t`, `--bail` or a
    // sharded runner — for the wrong reason when it passed.
    call('ideaUpsert', { id: 'iStatus', title: '种子', notes: '', createdAt: 1 });
    call('ideaComplete', { id: 'iStatus' });
    const before = (call('dataLoad') as AppData).ideas.iStatus?.status;
    expect(before).toBe('done');
    call('ideaUpsert', {
      id: 'iStatus',
      title: '偷偷改状态',
      notes: '',
      createdAt: 1,
      status: 'discarded',
    });
    expect((call('dataLoad') as AppData).ideas.iStatus?.status).toBe(before);
  });

  test('ideaUpsert still edits the non-status fields', () => {
    call('ideaUpsert', { id: 'i2', title: '新标题', notes: '新备注', createdAt: 1 });
    const after = (call('dataLoad') as AppData).ideas.i2;
    expect(after?.title).toBe('新标题');
    expect(after?.notes).toBe('新备注');
  });

  test('the followUp resolve/reopen channels drive the transition', () => {
    // No isResolved: the field edit no longer carries state at all.
    call('followUpUpsert', { id: 'f1', title: '等审核', notes: '', createdAt: 1 });
    const resolved = call('followUpResolve', { id: 'f1' }) as { ok: boolean; data: AppData };
    expect(resolved.ok).toBe(true);
    expect(resolved.data.followUps.f1?.isResolved).toBe(true);
    expect(resolved.data.followUps.f1?.resolvedAt).toBeGreaterThan(0);

    const reopened = call('followUpReopen', { id: 'f1' }) as { ok: boolean; data: AppData };
    expect(reopened.ok).toBe(true);
    expect(reopened.data.followUps.f1?.isResolved).toBe(false);
    expect(reopened.data.followUps.f1?.resolvedAt).toBeUndefined();
  });

  test('follow-up command datasets are masked on success too', () => {
    // Same guarantee as the idea channels, through the shared choke point in
    // deps.ts rather than an inlined copy: the renderer adopts this dataset
    // wholesale, so an unmasked branch ships the ciphertext across the bridge.
    storeRef.update((d) => ({
      ...d,
      settings: {
        ...d.settings,
        aiProviders: [
          {
            id: 'pr1',
            registryId: 'openai',
            apiKeyEncrypted: 'SECRET-CIPHERTEXT',
            model: 'gpt-x',
            isDefault: true,
          },
        ],
      },
    }));
    call('followUpUpsert', { id: 'f9', title: '待办', notes: '', createdAt: 1 });
    const resolved = call('followUpResolve', { id: 'f9' }) as { ok: boolean; data: AppData };
    expect(resolved.ok).toBe(true);
    expect(resolved.data.settings.aiProviders[0]?.apiKeyEncrypted).toBe('');
  });

  test('the timeline commands dispatch and drive the transition', () => {
    call('ideaUpsert', { id: 'i7', title: '有日志的想法', notes: '', createdAt: 1 });
    const added = call('ideaAddEntry', { id: 'i7', text: '第一步' }) as {
      ok: boolean;
      data: AppData;
    };
    expect(added.ok).toBe(true);
    expect(added.data.ideas.i7?.timeline).toHaveLength(1);
    const entryId = added.data.ideas.i7?.timeline?.[0]?.id as string;
    const updated = call('ideaUpdateEntry', { id: 'i7', entryId, text: '改过的' }) as {
      ok: boolean;
      data: AppData;
    };
    expect(updated.data.ideas.i7?.timeline?.[0]?.text).toBe('改过的');
    const deleted = call('ideaDeleteEntry', { id: 'i7', entryId }) as {
      ok: boolean;
      data: AppData;
    };
    // The last removal leaves an empty list rather than dropping the key.
    expect(deleted.data.ideas.i7?.timeline).toEqual([]);
  });

  test('the follow-up state commands do not reuse the delete request schema', () => {
    // Distinct *objects*, not just the same shape: an alias would still let a
    // field added to the delete schema change these two commands' wire shape
    // with nothing to notice.
    const deleteReq = IpcInvokeContract.followUpDelete.req as object;
    expect(IpcInvokeContract.followUpResolve.req).not.toBe(deleteReq);
    expect(IpcInvokeContract.followUpReopen.req).not.toBe(deleteReq);
  });

  test('a followUp command on a missing id rejects instead of returning null', () => {
    const r = call('followUpResolve', { id: 'nope' }) as { ok: boolean; error: string };
    expect(r).toEqual({ ok: false, error: 'FOLLOW_UP_NOT_FOUND' });
  });

  test('idea intent commands never leak provider key ciphertext to the renderer', () => {
    // Every channel that returns AppData must mask it: the renderer adopts
    // these datasets wholesale, so one unmasked return ships the ciphertext
    // across the contextBridge. Four of the six commands were unmasked here.
    storeRef.update((d) => ({
      ...d,
      settings: {
        ...d.settings,
        aiProviders: [
          {
            id: 'pr1',
            registryId: 'openai',
            apiKeyEncrypted: 'SECRET-CIPHERTEXT',
            model: 'gpt-x',
            isDefault: true,
          },
        ],
      },
    }));
    // Prove the fixture is not vacuous: the store really does hold the secret.
    expect(storeRef.get().settings.aiProviders[0]?.apiKeyEncrypted).toBe('SECRET-CIPHERTEXT');

    // ideaUpsert carries no status (that is the point of the narrowed write
    // contract), so each idea is walked into the state its command needs
    // using commands — then the command under test returns a dataset.
    const seedOpen = (id: string) =>
      call('ideaUpsert', { id, title: '要脱敏的', notes: '', createdAt: 1 });

    const expectMasked = (key: keyof typeof IpcInvokeContract, req: unknown) => {
      const r = call(key, req) as { ok: boolean; data?: AppData };
      expect(r.ok).toBe(true);
      expect(r.data?.settings.aiProviders[0]?.apiKeyEncrypted).toBe('');
      expect(r.data?.settings.aiProviders[0]?.hasApiKey).toBe(true);
    };

    seedOpen('i3');
    expectMasked('ideaComplete', { id: 'i3' });

    seedOpen('i4');
    expectMasked('ideaDiscard', { id: 'i4' });

    seedOpen('i5');
    call('ideaComplete', { id: 'i5' }); // open -> done
    expectMasked('ideaReopen', { id: 'i5' });

    seedOpen('i6');
    call('ideaUpgradeToProject', { id: 'i6', title: '验证项目' }); // open -> incubating
    expectMasked('ideaCloseWithVerdict', { id: 'i6', result: 'validated' });
  });
});
