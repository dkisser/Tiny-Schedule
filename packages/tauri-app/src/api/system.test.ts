import { beforeEach, describe, expect, test } from 'bun:test';
import { emptyAppData } from '@tiny-schedule/shared';
import { DataStore } from '@/bridge/dataStore';
import { MemoryFs } from '@/bridge/fsAdapter';
import { installTauriMocks } from '@/test/tauriMocks';

/**
 * Tauri host modules are stubbed through the shared helper, which spreads the
 * real module and overrides only the calls under test. An earlier version of
 * this file stubbed `@tauri-apps/api/app`, `plugin-opener` and `plugin-http`
 * as bare literals purely to survive `bridge/sseFetch.test.ts` replacing
 * `@tauri-apps/api/core` with a stub that had no `Resource` export; that is
 * exactly the cross-file pollution the helper removes, so the workarounds are
 * gone.
 *
 * The plugin-http stub is never called: every `appCheckUpdate` test injects
 * `fetchImpl`, so `bridge/updater.ts`'s default transport stays unused.
 */
installTauriMocks();

// Imported dynamically, and only because `mock.module` is not hoisted above
// static imports in bun: `./system` must resolve *after* the stubs above are
// registered.
const { createSystemApi, isAllowedExternalUrl } = await import('./system');

/**
 * Everything the Tauri runtime would answer is injected through
 * `SystemApiDeps` instead of being faked at the module boundary — the system
 * slice is the one place where the command name, its argument names and its
 * wire shape are the contract, and a recorded call asserts that far better
 * than a module mock can.
 */
const opened: string[] = [];
const invokes: { cmd: string; args: unknown }[] = [];
let invokeResult: unknown = { ok: true, eventId: 'evt-1' };
let invokeRejects: Error | null = null;

const testDeps = {
  openExternal: async (url: string) => {
    opened.push(url);
  },
  invokeFn: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    invokes.push({ cmd, args });
    if (invokeRejects) throw invokeRejects;
    return invokeResult as T;
  },
};

const DIR = '/data';

async function setup() {
  const fs = new MemoryFs();
  const store = await DataStore.open(DIR, fs);
  await store.save(emptyAppData());
  return store;
}

function seedTask(store: Awaited<ReturnType<typeof setup>>, task: Record<string, unknown>) {
  return store.update((d) => ({
    ...d,
    tasks: {
      ...d.tasks,
      [task.id as string]: {
        id: 't1',
        title: '写周报',
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
        ...task,
      } as (typeof d.tasks)[string],
    },
  }));
}

describe('isAllowedExternalUrl', () => {
  test('accepts only https', () => {
    expect(isAllowedExternalUrl('https://github.com/dkisser/Tiny-Schedule')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('HTTPS://example.com')).toBe(false);
    // The original used a bare prefix test; keep the same case sensitivity so a
    // capitalised scheme does not silently become a second accepted spelling.
    expect(isAllowedExternalUrl('ftp://example.com')).toBe(false);
    expect(isAllowedExternalUrl('')).toBe(false);
  });
});

describe('appOpenExternal', () => {
  beforeEach(() => {
    opened.length = 0;
  });

  test('opens an https url', async () => {
    const api = createSystemApi(await setup(), testDeps);
    await api.appOpenExternal({ url: 'https://example.com' });
    expect(opened).toEqual(['https://example.com']);
  });

  test('refuses every other scheme without touching the opener', async () => {
    const api = createSystemApi(await setup(), testDeps);
    for (const url of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      await api.appOpenExternal({ url });
    }
    expect(opened).toEqual([]);
  });
});

describe('appCheckUpdate', () => {
  // The transport is injected rather than mocked at the module: plugin-http
  // routes through `invoke`, and with `invoke` already stubbed above it never
  // settles, so a real call here would hang the run instead of failing it.
  function release(tag: string) {
    return async () =>
      new Response(JSON.stringify({ tag_name: tag }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  test('reports an update against the runtime version', async () => {
    const api = createSystemApi(await setup(), {
      getVersion: async () => '0.1.9',
      ...testDeps,
      fetchImpl: release('v0.1.10'),
    });
    const result = await api.appCheckUpdate();
    expect(result.current).toBe('0.1.9');
    expect(result.latest).toBe('0.1.10');
    expect(result.hasUpdate).toBe(true);
  });

  test('only prompts; it never returns a download url or a download step', async () => {
    const api = createSystemApi(await setup(), {
      getVersion: async () => '0.1.9',
      ...testDeps,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://example.com/r', body: 'x' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const result = await api.appCheckUpdate();
    // `url` points at the release page, never at an asset: the v1 updater is
    // "check and tell the user", not "download and install".
    expect(result.url).toBe('https://example.com/r');
    expect(JSON.stringify(result)).not.toContain('browser_download_url');
  });

  test('an offline check degrades into `error` instead of throwing', async () => {
    const api = createSystemApi(await setup(), {
      getVersion: async () => '0.1.9',
      ...testDeps,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    const result = await api.appCheckUpdate();
    expect(result).toEqual({
      current: '0.1.9',
      hasUpdate: false,
      latest: null,
      url: null,
      notes: null,
      error: 'offline',
    });
  });
});

describe('calendarAddTask', () => {
  beforeEach(() => {
    invokes.length = 0;
    invokeRejects = null;
    invokeResult = { ok: true, eventId: 'evt-1' };
  });

  test('sends the project-prefixed title, dueDay and notes', async () => {
    const store = await setup();
    await seedTask(store, { id: 't1', title: '写周报', dueDay: '2026-08-04', notes: 'n' });
    await store.update((d) => ({
      ...d,
      projects: { ...d.projects, p1: { id: 'p1', title: '工作', isArchived: false } },
    }));
    const api = createSystemApi(store, testDeps);
    const result = await api.calendarAddTask({ taskId: 't1' });
    expect(result).toEqual({ ok: true, eventId: 'evt-1' });
    expect(invokes).toEqual([
      {
        cmd: 'calendar_add_task',
        // Nested, and not incidentally: `calendar_add_task` declares
        // `request: CalendarRequest`, and Tauri v2 binds command arguments by
        // name. A flat payload has no `request` key, so the invoke rejects and
        // the caller reports `unknown` — the button appears to do nothing. The
        // old assertion here encoded that flat shape, so the test passed
        // against a call that could never succeed.
        args: {
          request: { title: '[工作] 写周报', dueDay: '2026-08-04', notes: 'n' },
        },
      },
    ]);
  });

  test('omits the prefix when the task has no project', async () => {
    const store = await setup();
    await seedTask(store, { id: 't1', title: '写周报', dueDay: '2026-08-04' });
    const api = createSystemApi(store, testDeps);
    await api.calendarAddTask({ taskId: 't1' });
    expect((invokes[0]?.args as { request: { title: string } }).request.title).toBe('写周报');
  });

  test('a task with no dueDay is refused before Rust is called', async () => {
    const store = await setup();
    await seedTask(store, { id: 't1', dueDay: undefined });
    const api = createSystemApi(store, testDeps);
    const result = await api.calendarAddTask({ taskId: 't1' });
    expect(result).toEqual({ ok: false, code: 'no-dueDay', message: '任务没有截止日期' });
    expect(invokes).toEqual([]);
  });

  test('an unknown task id is refused before Rust is called', async () => {
    const api = createSystemApi(await setup(), testDeps);
    const result = await api.calendarAddTask({ taskId: 'nope' });
    expect(result).toEqual({ ok: false, code: 'unknown', message: '任务不存在' });
    expect(invokes).toEqual([]);
  });

  test('a rejected invoke becomes an `unknown` failure rather than throwing', async () => {
    const store = await setup();
    await seedTask(store, { id: 't1', dueDay: '2026-08-04' });
    invokeRejects = new Error('helper not found');
    const api = createSystemApi(store, testDeps);
    expect(await api.calendarAddTask({ taskId: 't1' })).toEqual({
      ok: false,
      code: 'unknown',
      message: 'helper not found',
    });
  });
});
