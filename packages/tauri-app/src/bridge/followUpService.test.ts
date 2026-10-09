import { describe, expect, test } from 'bun:test';
import {
  type AppData,
  emptyAppData,
  type FollowUp,
  type FollowUpEdit,
} from '@tiny-schedule/shared';
import { type AiLogger, silentLogger } from '../ai/logger';
import { DataStore } from './dataStore';
import { createFollowUpService, type FollowUpCommandWrite } from './followUpService';
import { joinPath, MemoryFs } from './fsAdapter';

const DIR = '/data';

function dataPath(): string {
  return joinPath(DIR, 'data.json');
}

function backupPath(generation: number): string {
  return joinPath(DIR, `data.backup.${generation}.json`);
}

function makeFollowUp(id: string, overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id,
    title: `follow up ${id}`,
    notes: '',
    entries: [],
    createdAt: 1,
    isResolved: false,
    ...overrides,
  };
}

function seedData(overrides: Partial<AppData> = {}): AppData {
  return { ...emptyAppData(), followUps: { f1: makeFollowUp('f1') }, ...overrides } as AppData;
}

/**
 * The only supported construction: `open` is what creates the directory, and
 * `load()` is what seeds the cache the service reads and the guard that decides
 * whether a write is accepted.
 */
async function openService(fs: MemoryFs, logger: AiLogger = silentLogger) {
  const store = await DataStore.open(DIR, fs, logger);
  await store.load();
  return createFollowUpService({ store, logger });
}

/**
 * A brand-new store over the same filesystem — the in-test equivalent of a
 * restart, and the only way to tell "written to disk" from "in the cache".
 */
async function reload(fs: MemoryFs): Promise<AppData> {
  const store = await DataStore.open(DIR, fs);
  return store.load();
}

/**
 * A store whose data.json will not parse, beside an intact backup generation 1.
 *
 * The load falls back to the backup and latches read-only, so the cache is a
 * *fallback* rather than the user's data. Every write is refused from there on:
 * persisting the fallback would overwrite the only intact copy with a degraded
 * one.
 */
async function openRefusedService(): Promise<{
  fs: MemoryFs;
  service: ReturnType<typeof createFollowUpService>;
}> {
  const fs = new MemoryFs({
    [dataPath()]: '{"version":1,"followUps":{"f1":{"titl',
    [backupPath(1)]: JSON.stringify(seedData()),
  });
  return { fs, service: await openService(fs) };
}

/**
 * Narrows a command result to its ok branch.
 *
 * An `expect(result.ok).toBe(true)` does not narrow the union for the
 * compiler, so the assertions below would not type-check without this — and
 * reading `.data` off the rejection branch is exactly the mistake the envelope
 * exists to make impossible in the handler.
 */
function expectWritten(result: FollowUpCommandWrite): { data: AppData; persisted: boolean } {
  if (!result.ok) throw new Error(`expected a write, got ${result.error}`);
  return result;
}

describe('followUpService.resolve', () => {
  test('records the 办结 moment and puts it on disk', async () => {
    const fs = new MemoryFs({ [dataPath()]: JSON.stringify(seedData()) });
    const service = await openService(fs);

    const result = expectWritten(await service.resolve('f1', 1_700_000_000_000));

    expect(result.persisted).toBe(true);
    const stored = result.data.followUps.f1 as FollowUp;
    expect(stored.isResolved).toBe(true);
    expect(stored.resolvedAt).toBe(1_700_000_000_000);
    // The other fields are carried, not replaced: a resolve is not an upsert of
    // a freshly built record.
    expect(stored.title).toBe('follow up f1');
    expect(stored.createdAt).toBe(1);

    const onDisk = (await reload(fs)).followUps.f1 as FollowUp;
    expect(onDisk.isResolved).toBe(true);
    expect(onDisk.resolvedAt).toBe(1_700_000_000_000);
  });

  test('a missing follow-up is an envelope, not a null dataset', async () => {
    const fs = new MemoryFs({ [dataPath()]: JSON.stringify(seedData()) });
    const service = await openService(fs);

    // The renderer adopts the returned value wholesale as the dataset, so a
    // null here would leave the app stuck on "loading" with no way to tell
    // "that follow-up is gone" from "the dataset never arrived".
    expect(await service.resolve('nope')).toEqual({
      ok: false,
      error: 'FOLLOW_UP_NOT_FOUND',
    });
  });

  test('reports the refusal instead of pretending the 办结 happened', async () => {
    const { fs, service } = await openRefusedService();

    const result = expectWritten(await service.resolve('f1'));

    // Same visible outcome as NOT_FOUND — nothing changed — for the same
    // reason: nothing was written. Reporting it as persisted would be a
    // success the user's disk never saw.
    expect(result.persisted).toBe(false);
    expect(await fs.readText(dataPath())).toBe('{"version":1,"followUps":{"f1":{"titl');
    expect(fs.has(backupPath(2))).toBe(false);
  });
});

describe('followUpService.reopen', () => {
  test('clears the 办结 moment and returns the follow-up to 等待中', async () => {
    const fs = new MemoryFs({
      [dataPath()]: JSON.stringify(
        seedData({ followUps: { f1: makeFollowUp('f1', { isResolved: true, resolvedAt: 42 }) } }),
      ),
    });
    const service = await openService(fs);

    const result = expectWritten(await service.reopen('f1'));

    expect(result.persisted).toBe(true);
    const stored = result.data.followUps.f1 as FollowUp;
    expect(stored.isResolved).toBe(false);
    // `undefined`, not left at 42: isFollowUpDue and the list both read this as
    // "when did this close", and a reopen that kept the old stamp would put a
    // date back on a follow-up that is waiting again.
    expect(stored.resolvedAt).toBeUndefined();
    expect(stored.title).toBe('follow up f1');

    const onDisk = (await reload(fs)).followUps.f1 as FollowUp;
    expect(onDisk.isResolved).toBe(false);
    expect('resolvedAt' in onDisk).toBe(false);
  });

  test('a missing follow-up is an envelope', async () => {
    const fs = new MemoryFs({ [dataPath()]: JSON.stringify(seedData()) });
    const service = await openService(fs);

    expect(await service.reopen('nope')).toEqual({
      ok: false,
      error: 'FOLLOW_UP_NOT_FOUND',
    });
  });

  test('reports the refusal instead of pretending the reopen happened', async () => {
    const { fs, service } = await openRefusedService();

    const result = expectWritten(await service.reopen('f1'));

    expect(result.persisted).toBe(false);
    expect(await fs.readText(dataPath())).toBe('{"version":1,"followUps":{"f1":{"titl');
  });
});

describe('followUpService.edit', () => {
  test('a stale snapshot cannot undo a 办结', async () => {
    // The regression this whitelist exists for, end to end: the renderer edits
    // with `{ ...followUp, ...patch }`, always spreading its render-time
    // snapshot — isResolved and resolvedAt included. MarkdownEditor's cleanup
    // closure captured the mount-time record, so resolving from the list row
    // beside an open notes editor and then closing it wrote back isResolved:
    // false and reverted the 办结 with no error and no log.
    const mounted = makeFollowUp('f1');
    const fs = new MemoryFs({ [dataPath()]: JSON.stringify(seedData()) });
    const service = await openService(fs);
    await service.resolve('f1', 99);

    // The stale snapshot is replayed verbatim as a patch, state fields and all.
    const next = await service.edit({
      ...mounted,
      notes: 'edited after the resolve',
    } as FollowUpEdit);

    const stored = next.followUps.f1 as FollowUp;
    expect(stored.isResolved).toBe(true);
    expect(stored.resolvedAt).toBe(99);
    // The field the edit was actually for still lands.
    expect(stored.notes).toBe('edited after the resolve');

    const onDisk = (await reload(fs)).followUps.f1 as FollowUp;
    expect(onDisk.isResolved).toBe(true);
    expect(onDisk.resolvedAt).toBe(99);
  });

  test('merges into the stored record and leaves omitted fields alone', async () => {
    const fs = new MemoryFs({
      [dataPath()]: JSON.stringify(
        seedData({
          followUps: {
            f1: makeFollowUp('f1', {
              notes: 'kept',
              entries: [{ id: 'e1', at: 5, text: 'called' }],
              nextFollowUpDay: '2026-01-02',
            }),
          },
        }),
      ),
    });
    const service = await openService(fs);

    const next = await service.edit({ id: 'f1', title: 'renamed', createdAt: 1 } as FollowUpEdit);

    const stored = next.followUps.f1 as FollowUp;
    expect(stored.title).toBe('renamed');
    expect(stored.notes).toBe('kept');
    expect(stored.entries).toHaveLength(1);
    expect(stored.nextFollowUpDay).toBe('2026-01-02');
  });

  test('null clears nextFollowUpDay and undefined leaves it alone', async () => {
    const fs = new MemoryFs({
      [dataPath()]: JSON.stringify(
        seedData({ followUps: { f1: makeFollowUp('f1', { nextFollowUpDay: '2026-01-02' }) } }),
      ),
    });
    const service = await openService(fs);

    const cleared = await service.edit({
      id: 'f1',
      title: 'x',
      createdAt: 1,
      nextFollowUpDay: null,
    } as FollowUpEdit);
    expect('nextFollowUpDay' in (cleared.followUps.f1 as FollowUp)).toBe(false);

    const kept = await service.edit({
      id: 'f1',
      title: 'x',
      createdAt: 1,
      nextFollowUpDay: '2026-02-02',
    } as FollowUpEdit);
    expect((kept.followUps.f1 as FollowUp).nextFollowUpDay).toBe('2026-02-02');
  });

  test('an unknown id creates a 等待中 follow-up', async () => {
    const fs = new MemoryFs({ [dataPath()]: JSON.stringify(seedData()) });
    const service = await openService(fs);

    const next = await service.edit({
      id: 'f9',
      title: 'brand new',
      notes: '',
      createdAt: 7,
    } as FollowUpEdit);

    const stored = next.followUps.f9 as FollowUp;
    expect(stored.isResolved).toBe(false);
    expect(stored.entries).toEqual([]);
    expect((await reload(fs)).followUps.f9?.title).toBe('brand new');
  });

  test('a refused store still hands back a dataset, and writes nothing', async () => {
    const { fs, service } = await openRefusedService();

    const next = await service.edit({ id: 'f1', title: 'renamed', createdAt: 1 } as FollowUpEdit);

    // The fallback is what the caller adopts on screen. It is not what reached
    // the disk — the refusal is the store's to report, and the file is left
    // exactly as the user left it.
    expect((next.followUps.f1 as FollowUp | undefined)?.title).toBe('follow up f1');
    expect(await fs.readText(dataPath())).toBe('{"version":1,"followUps":{"f1":{"titl');
  });
});

describe('followUpService.remove', () => {
  test('deletes the follow-up and persists the deletion', async () => {
    const fs = new MemoryFs({ [dataPath()]: JSON.stringify(seedData()) });
    const service = await openService(fs);

    const next = await service.remove('f1');

    expect(next.followUps.f1).toBeUndefined();
    expect((await reload(fs)).followUps.f1).toBeUndefined();
  });
});
