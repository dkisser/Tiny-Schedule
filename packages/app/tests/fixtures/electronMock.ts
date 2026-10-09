/**
 * One mock for the `electron` module, shared by every test that needs one.
 *
 * bun's mock.module is global and last-registration-wins, so two test files
 * mocking `electron` with different shapes race: whichever registers last
 * silently removes the other's exports, and the victim fails with
 * "Export named 'x' not found" at import time rather than at the call it cared
 * about. Every mock in this repo therefore comes from here, so the shape only
 * has to be right in one place.
 *
 * Each test gets its own instance via {@link mockElectron} when it needs to
 * observe the registrations; the default singleton covers the rest.
 */
export interface ElectronMock {
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw: unknown) => unknown) => void;
  };
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string) => void;
    removeListener: () => void;
  };
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void };
  powerMonitor: {
    on: (event: string, cb: () => void) => void;
    getSystemIdleTime: () => number;
  };
  net: { fetch: (url: string, init?: RequestInit) => Promise<Response> };
  safeStorage: {
    isEncryptionAvailable: () => boolean;
    encryptString: (s: string) => Buffer;
    decryptString: (b: Buffer) => string;
  };
  dialog: Record<string, unknown>;
  shell: { openExternal: (url: string) => Promise<void> };
  Notification: unknown;
  app: { getPath: (name: string) => string; getVersion: () => string };
}

/** A fresh, inert electron stand-in. Every hook is a no-op until a test wants it. */
export function mockElectron(over: Partial<ElectronMock> = {}): ElectronMock {
  return {
    ipcMain: { handle: () => {} },
    ipcRenderer: {
      invoke: () => Promise.resolve(),
      on: () => {},
      removeListener: () => {},
    },
    contextBridge: { exposeInMainWorld: () => {} },
    powerMonitor: { on: () => {}, getSystemIdleTime: () => 0 },
    net: { fetch: () => Promise.reject(new Error('electron is mocked')) },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => b.toString('utf8'),
    },
    dialog: {},
    shell: { openExternal: async () => {} },
    Notification: class {
      static isSupported() {
        return false;
      }
      show() {}
    },
    app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
    ...over,
  };
}

/** The shared singleton most tests use; mutate it only in beforeEach. */
export const electronMock: ElectronMock = mockElectron();
