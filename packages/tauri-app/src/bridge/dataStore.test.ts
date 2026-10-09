import { describe, expect, test } from 'bun:test';
import { type AppData, emptyAppData } from '@tiny-schedule/shared';
import { DataStore } from './dataStore';
import { joinPath, MemoryFs } from './fsAdapter';
import { migrateRemoveTodayTag } from './migrations';

const DIR = '/data';

function makeTask(id: string, overrides: Partial<AppData['tasks'][string]> = {}) {
  return {
    id,
    projectId: 'inbox',
    tagIds: [],
    subTaskIds: [],
    parentTaskId: undefined,
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

function seedData(overrides: Partial<AppData> = {}): AppData {
  return { ...emptyAppData(), tasks: { t1: makeTask('t1') }, ...overrides } as AppData;
}

async function openStore(fs: MemoryFs) {
  return DataStore.open(DIR, fs);
}

describe('DataStore', () => {
  test('creates its directory on open', async () => {
    const fs = new MemoryFs();
    await openStore(fs);
    expect(fs.calls).toContain(`mkdir:${DIR}`);
  });

  test('writes via tmp then rename, never truncating data.json in place', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);

    await store.save(seedData());
    fs.calls.length = 0;
    await store.save(seedData({ tasks: { t1: makeTask('t1', { title: 'renamed' }) } }));

    const writeIndex = fs.calls.findIndex((c) => c.startsWith('writeText:'));
    const renameIndex = fs.calls.findIndex((c) => c.startsWith('rename:'));
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(writeIndex);
    expect(fs.calls[writeIndex]).toBe(`writeText:${joinPath(DIR, 'data.json')}.tmp`);
    expect(fs.calls[renameIndex]).toBe(
      `rename:${joinPath(DIR, 'data.json')}.tmp->${joinPath(DIR, 'data.json')}`,
    );
    // The tmp file must not survive a successful save.
    expect(fs.has(`${joinPath(DIR, 'data.json')}.tmp`)).toBe(false);
  });

  test('copies the previous file to data.backup.json before overwriting', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);

    await store.save(seedData());
    const firstWrite = fs.has(joinPath(DIR, 'data.json'))
      ? await fs.readText(joinPath(DIR, 'data.json'))
      : '';

    await store.save(seedData({ tasks: { t1: makeTask('t1', { title: 'second' }) } }));

    const backup = await fs.readText(joinPath(DIR, 'data.backup.json'));
    expect(JSON.parse(backup).tasks.t1.title).toBe('task t1');
    // The backup holds the *previous* contents, not the ones just written.
    expect(backup).toBe(firstWrite);
    expect(JSON.parse(await fs.readText(joinPath(DIR, 'data.json'))).tasks.t1.title).toBe('second');
  });

  test('does not create a backup when there is nothing to overwrite', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.save(seedData());
    expect(fs.has(joinPath(DIR, 'data.backup.json'))).toBe(false);
  });

  test('validates on write, so an invalid shape never reaches disk', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);

    await expect(store.save({ version: 99 } as unknown as AppData)).rejects.toThrow();
    expect(fs.has(joinPath(DIR, 'data.json'))).toBe(false);
  });

  test('backfills schema defaults for modules added after the file was written', async () => {
    // A pre-FollowUp/pre-Idea data.json: those keys are absent entirely.
    const legacy = { ...emptyAppData() } as Record<string, unknown>;
    delete legacy.followUps;
    delete legacy.ideas;
    const fs = new MemoryFs({ [joinPath(DIR, 'data.json')]: JSON.stringify(legacy) });

    const store = await openStore(fs);
    const loaded = await store.load();

    expect(loaded.followUps).toEqual({});
    expect(loaded.ideas).toEqual({});
  });

  test('falls back to the backup when data.json is corrupt', async () => {
    const good = JSON.stringify(
      seedData({ tasks: { t1: makeTask('t1', { title: 'from backup' }) } }),
    );
    const fs = new MemoryFs({
      [joinPath(DIR, 'data.json')]: '{ this is not json',
      [joinPath(DIR, 'data.backup.json')]: good,
    });

    const store = await openStore(fs);
    const loaded = await store.load();

    expect(loaded.tasks.t1?.title).toBe('from backup');
  });

  test('falls back to an empty seed when both files are unusable', async () => {
    const fs = new MemoryFs({
      [joinPath(DIR, 'data.json')]: 'not json at all',
      [joinPath(DIR, 'data.backup.json')]: '{"version":1}',
    });

    const store = await openStore(fs);
    const loaded = await store.load();

    expect(loaded).toEqual(emptyAppData());
    expect(loaded.tasks).toEqual({});
  });

  test('get() caches: a second call does not re-read from disk', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.save(seedData());

    fs.calls.length = 0;
    const first = await store.get();
    const second = await store.get();

    expect(first).toBe(second);
    expect(fs.calls.filter((c) => c.startsWith('readText'))).toHaveLength(0);
  });

  test('load() populates the cache, so a rescued dataset survives startup', async () => {
    // The rescue scenario, end to end. A truncated `data.json` beside an intact
    // backup recovers correctly — and then, without a cache, the startup
    // migrations' `migrated !== store.get()` reference comparison was always
    // true, so a save ran on a no-op launch. That save's first step copies
    // `data.json` over `data.backup.json`: the truncated file overwrites the
    // only good copy, before the recovered data is ever written. The recovery
    // destroys what it recovered.
    const good = JSON.stringify(seedData({ tasks: { t1: makeTask('t1', { title: 'precious' }) } }));
    const truncated = '{"version":1,"tasks":{"t1":{"titl';
    const fs = new MemoryFs({
      [joinPath(DIR, 'data.json')]: truncated,
      [joinPath(DIR, 'data.backup.json')]: good,
    });
    const store = await openStore(fs);

    // Bootstrap's exact sequence: load, then two migrations each deciding
    // whether to save by comparing references.
    const data = await store.get();
    expect(data.tasks.t1?.title).toBe('precious');

    const migrated = migrateRemoveTodayTag(await store.get());
    expect(migrated).toBe(await store.get()); // no-op migration, same reference

    // Nothing was written, so the intact backup is untouched — and the corrupt
    // primary is still the corrupt primary rather than having become the backup.
    expect(await fs.readText(joinPath(DIR, 'data.backup.json'))).toBe(good);
    expect(await fs.readText(joinPath(DIR, 'data.json'))).toBe(truncated);
  });

  test('a later legitimate save writes the recovered dataset, not the corrupt file', async () => {
    // Once something genuinely changes and a save is warranted, what lands in
    // `data.json` is the recovered dataset. The backup step still snapshots
    // whatever is on disk — which here is the truncated primary, so the good
    // backup is replaced by it. That is the original's backup-before-overwrite
    // semantics, unchanged, and it is not a loss: the recovered data is now the
    // primary, so the next backup is taken from something intact.
    const good = JSON.stringify(seedData({ tasks: { t1: makeTask('t1', { title: 'precious' }) } }));
    const fs = new MemoryFs({
      [joinPath(DIR, 'data.json')]: '{"version":1,"tasks":{"t1":{"titl',
      [joinPath(DIR, 'data.backup.json')]: good,
    });
    const store = await openStore(fs);
    const recovered = await store.get();

    await store.update((d) => ({ ...d, tasks: { t1: { ...d.tasks.t1!, title: 'precious' } } }));

    expect(JSON.parse(await fs.readText(joinPath(DIR, 'data.json'))).tasks.t1.title).toBe(
      'precious',
    );
    // And the next save's backup is taken from that intact primary.
    fs.calls.length = 0;
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'later' } }));
    expect(JSON.parse(await fs.readText(joinPath(DIR, 'data.backup.json'))).tasks.t1.title).toBe(
      'precious',
    );
    expect(recovered.tasks.t1?.title).toBe('precious');
  });

  test('update() persists the value the callback returns', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.save(seedData());

    const next = await store.update((d) => ({
      ...d,
      settings: { ...d.settings, userName: 'renamed-user' },
    }));

    expect(next.settings.userName).toBe('renamed-user');
    const onDisk = JSON.parse(await fs.readText(joinPath(DIR, 'data.json')));
    expect(onDisk.settings.userName).toBe('renamed-user');
  });

  test('load() round-trips a realistic dataset without dropping keys', async () => {
    const rich = seedData({
      tasks: {
        t1: makeTask('t1', { title: '中文标题', isDone: true, doneAt: 123, timeSpent: 5000 }),
        t2: makeTask('t2', { subTaskIds: ['t1'], timeSpentOnDay: { '2026-10-08': 1200 } }),
      },
      projects: { inbox: { id: 'inbox', title: '收件箱', isArchived: false } },
      tags: { g1: { id: 'g1', title: '重要', color: 'red' } },
    } as Partial<AppData>);

    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.save(rich);

    const loaded = await (
      await openStore(
        new MemoryFs({
          [joinPath(DIR, 'data.json')]: JSON.stringify(rich),
        }),
      )
    ).load();

    expect(loaded.tasks.t1?.title).toBe('中文标题');
    expect(loaded.tasks.t1?.isDone).toBe(true);
    expect(loaded.tasks.t2?.subTaskIds).toEqual(['t1']);
    expect(loaded.tasks.t2?.timeSpentOnDay).toEqual({ '2026-10-08': 1200 });
    expect(loaded.tags.g1?.color).toBe('red');
  });
});

describe('DataStore concurrency', () => {
  /**
   * Wraps {@link MemoryFs} so every operation yields to the event loop, which
   * is what real IPC does. Without the yield the read and the write of an
   * `update` would run in one tick and nothing could interleave — the
   * concurrency bug this file's tests are about is only reachable once there
   * is a suspension point in the middle of a read-modify-write.
   */
  class SlowFs extends MemoryFs {
    constructor(private readonly delayMs = 5) {
      super();
    }

    private async tick(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    override async exists(path: string) {
      await this.tick();
      return super.exists(path);
    }

    override async writeText(path: string, contents: string) {
      await this.tick();
      return super.writeText(path, contents);
    }

    override async copy(from: string, to: string) {
      await this.tick();
      return super.copy(from, to);
    }

    override async rename(from: string, to: string) {
      await this.tick();
      return super.rename(from, to);
    }

    override async readText(path: string) {
      await this.tick();
      return super.readText(path);
    }
  }

  async function onDisk(fs: MemoryFs): Promise<AppData> {
    return JSON.parse(await fs.readText(joinPath(DIR, 'data.json'))) as AppData;
  }

  test('two overlapping updates both land instead of one erasing the other', async () => {
    // The concrete race this guards: `settingsUpdate`'s callback awaits WebCrypto
    // before returning, while the 30s heartbeat fires `timerSync` against the
    // same dataset. Both read the same snapshot, both persist it, and the
    // second write silently reverts the first — the user sees their own
    // settings change disappear.
    const fs = new SlowFs();
    const store = await DataStore.open(DIR, fs);
    await store.save(seedData());

    await Promise.all([
      store.update(async (d) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ...d, settings: { ...d.settings, aiPrompt: 'hello' } };
      }),
      store.update((d) => ({
        ...d,
        activeTimer: {
          taskId: 't1',
          startedAt: 1_000,
          accumulatedMs: 0,
          isPaused: false,
          sessionStartedAt: 1_000,
        },
      })),
    ]);

    const disk = await onDisk(fs);
    expect(disk.settings.aiPrompt).toBe('hello');
    expect(disk.activeTimer?.taskId).toBe('t1');
  });

  test('a burst of concurrent updates keeps every one of them', async () => {
    const fs = new SlowFs(1);
    const store = await DataStore.open(DIR, fs);
    await store.save(seedData());

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.update((d) => ({
          ...d,
          settings: { ...d.settings, userName: `user-${i}` },
        })),
      ),
    );

    // Last writer wins on a shared field, but nothing is *lost*: every write
    // was a distinct dataset object and the queue preserved the ordering.
    const writes = fs.calls.filter((c) => c.startsWith('writeText:'));
    expect(writes).toHaveLength(13); // the seed plus twelve updates
    expect((await onDisk(fs)).settings.userName).toBe('user-11');
  });

  test('a failed update does not poison the ones queued behind it', async () => {
    // The chain's own rejection is swallowed so the queue keeps draining; the
    // failing call still rejects for its own caller. Without this, one bad
    // settings write would wedge every later write for the rest of the session.
    const fs = new SlowFs(1);
    const store = await DataStore.open(DIR, fs);
    await store.save(seedData());

    const failing = store.update(() => {
      throw new Error('schema rejected this');
    });
    const following = store.update((d) => ({
      ...d,
      settings: { ...d.settings, userName: 'after' },
    }));

    await expect(failing).rejects.toThrow('schema rejected this');
    await following;

    expect((await onDisk(fs)).settings.userName).toBe('after');
  });

  test('a direct save queues behind an in-flight update instead of interleaving', async () => {
    // Bootstrap's migrations call `save()` directly. Without it on the same
    // queue, a migration could land between an update's read and its write and
    // be reverted by it.
    const fs = new SlowFs(5);
    const store = await DataStore.open(DIR, fs);
    await store.save(seedData());

    await Promise.all([
      store.update(async (d) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ...d, settings: { ...d.settings, aiPrompt: 'from update' } };
      }),
      store.update((d) => ({
        ...d,
        tasks: { t1: { ...d.tasks.t1!, title: 'from migration' } },
      })),
    ]);

    const disk = await onDisk(fs);
    expect(disk.settings.aiPrompt).toBe('from update');
    expect(disk.tasks.t1?.title).toBe('from migration');
  });
});
