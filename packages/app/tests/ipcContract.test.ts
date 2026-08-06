import { beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  type AppData,
  emptyAppData,
  Ipc,
  IpcEventChannels,
  IpcInvokeContract,
} from '@tiny-schedule/shared';
import type { Logger } from 'pino';
import type { DataStore } from '../src/main/dataStore';

// IPC contract test: catches the two failure classes the type system cannot
// see across the process boundary —
//   S1: preload invokes a channel main never registered
//   S5: main/preload disagree on the event channels
// (S2/S3/S6 are compile errors via IpcInvokeContract; S4 is scripts/check-ipc-literals.ts.)

const registered = new Set<string>();
const invoked = new Set<string>();
const listened = new Set<string>();
let exposedApi: Record<string, (...args: unknown[]) => unknown> | null = null;

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string) => {
      registered.add(channel);
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
}));

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../src/main/ipcHandlers');
  const data = emptyAppData();
  const store = {
    get: () => data,
    update: (fn: (current: AppData) => AppData) => fn(data),
  } as unknown as DataStore;
  const logger = { info: () => {}, error: () => {} } as unknown as Logger;
  registerIpcHandlers({ store, logger, getWindow: () => null });
  await import('../src/preload/index');
  expect(exposedApi).not.toBeNull();
  // Exercise every exposed method so all preload channels get recorded.
  for (const fn of Object.values(exposedApi as Record<string, unknown>)) {
    if (typeof fn === 'function') fn(() => {});
  }
});

const contractChannels = Object.values(IpcInvokeContract).map((e) => e.ch);
const allChannels = Object.values(Ipc);
const eventChannels = [...IpcEventChannels];

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

  test('preload api exposes every contract method plus onAiEvent', () => {
    const keys = Object.keys(exposedApi as object);
    const expected = [...Object.keys(IpcInvokeContract), 'onAiEvent'];
    expect(keys.sort()).toEqual(expected.sort());
  });
});
