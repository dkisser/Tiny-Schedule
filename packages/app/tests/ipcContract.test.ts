import { beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  type AppData,
  emptyAppData,
  Ipc,
  IpcChatEventChannels,
  IpcEventChannels,
  IpcInvokeContract,
  IpcUiEventChannels,
} from '@tiny-schedule/shared';
import type { Logger } from 'pino';
import type { DataStore } from '../src/main/infra/dataStore';

// IPC contract test: catches the two failure classes the type system cannot
// see across the process boundary —
//   S1: preload invokes a channel main never registered
//   S5: main/preload disagree on the event channels
// (S2/S3/S6 are compile errors via IpcInvokeContract; S4 is scripts/check-ipc-literals.ts.)

const registered = new Set<string>();
const invoked = new Set<string>();
const listened = new Set<string>();
// Keep the handler so a test can dispatch a real request through it, exactly as
// the renderer would once preload invoked the channel.
const handlerFor = new Map<string, (event: unknown, raw: unknown) => unknown>();
let exposedApi: Record<string, (...args: unknown[]) => unknown> | null = null;

mock.module('electron', () => ({
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
    on: (channel: string) => {
      listened.add(channel);
    },
    removeListener: () => {},
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      exposedApi = api as Record<string, (...args: unknown[]) => unknown>;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
  dialog: {},
  shell: { openExternal: async () => {} },
  Notification: class {
    static isSupported() {
      return false;
    }
    show() {}
  },
}));

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../src/main/ipcHandlers');
  // Faithful DataStore stand-in: update() must reassign, or a service that
  // loads-then-persists would never see its own write.
  let data = emptyAppData();
  const store = {
    get: () => data,
    update: (fn: (current: AppData) => AppData) => {
      data = fn(data);
      return data;
    },
  } as unknown as DataStore;
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
      'onUpdateAvailable',
      'onTimerChanged',
    ];
    expect(keys.sort()).toEqual(expected.sort());
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

  test('timingStop with no running timer reports the reason', () => {
    expect(call('timingStop')).toEqual({ ok: false, error: 'NO_ACTIVE_TIMER' });
  });

  test('ideaUpsert refuses a request carrying status fields', () => {
    // The narrowed write contract: a status can only be written by a command.
    // A stray `status` in the payload is stripped by zod rather than honoured.
    const before = (call('dataLoad') as AppData).ideas.i2?.status;
    call('ideaUpsert', {
      id: 'i2',
      title: '偷偷改状态',
      notes: '',
      createdAt: 1,
      status: 'discarded',
    });
    expect((call('dataLoad') as AppData).ideas.i2?.status).toBe(before);
  });

  test('ideaUpsert still edits the non-status fields', () => {
    call('ideaUpsert', { id: 'i2', title: '新标题', notes: '新备注', createdAt: 1 });
    const after = (call('dataLoad') as AppData).ideas.i2;
    expect(after?.title).toBe('新标题');
    expect(after?.notes).toBe('新备注');
  });

  test('the followUp resolve/reopen channels drive the transition', () => {
    call('followUpUpsert', {
      id: 'f1',
      title: '等审核',
      notes: '',
      entries: [],
      createdAt: 1,
      isResolved: false,
    });
    const resolved = call('followUpResolve', { id: 'f1' }) as AppData;
    expect(resolved.followUps.f1?.isResolved).toBe(true);
    expect(resolved.followUps.f1?.resolvedAt).toBeGreaterThan(0);

    const reopened = call('followUpReopen', { id: 'f1' }) as AppData;
    expect(reopened.followUps.f1?.isResolved).toBe(false);
    expect(reopened.followUps.f1?.resolvedAt).toBeUndefined();
  });
});
