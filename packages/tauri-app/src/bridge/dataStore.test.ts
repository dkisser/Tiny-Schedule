import { describe, expect, test } from 'bun:test';
import { type AppData, emptyAppData, type Idea } from '@tiny-schedule/shared';
import { type AiLogger, silentLogger } from '../ai/logger';
import { DataStore } from './dataStore';
import { joinPath, MemoryFs } from './fsAdapter';
import { migrateRemoveTodayTag } from './migrations';

const DIR = '/data';

/**
 * Every name a backup has ever had, newest-generation-last. Enumerated rather
 * than listed off the filesystem because the adapter deliberately exposes no
 * directory read: the production binding cannot give one either, so a helper
 * that needed it would be asserting against a capability the store does not
 * have.
 */
const BACKUP_NAMES = ['data.backup.1.json', 'data.backup.2.json', 'data.backup.json'];

function dataPath(): string {
  return joinPath(DIR, 'data.json');
}

function backupPath(generation: number): string {
  return joinPath(DIR, `data.backup.${generation}.json`);
}

function legacyBackupPath(): string {
  return joinPath(DIR, 'data.backup.json');
}

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

function makeIdea(id: string, overrides: Partial<Idea> = {}): Idea {
  return { id, title: `idea ${id}`, notes: '', createdAt: 1, status: 'open', ...overrides };
}

function seedData(overrides: Partial<AppData> = {}): AppData {
  return { ...emptyAppData(), tasks: { t1: makeTask('t1') }, ...overrides } as AppData;
}

/** The only supported construction: `open` is what creates the directory. */
async function openStore(fs: MemoryFs, logger: AiLogger = silentLogger): Promise<DataStore> {
  return DataStore.open(DIR, fs, logger);
}

/**
 * A brand-new store over the same filesystem — the in-test equivalent of a
 * restart. Used wherever the assertion is about what a *later launch* would
 * see, which is the only way to tell "written" from "in cache".
 */
async function reload(fs: MemoryFs, logger: AiLogger = silentLogger): Promise<AppData> {
  const store = await openStore(fs, logger);
  return store.load();
}

async function readJson(fs: MemoryFs, path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readText(path)) as Record<string, unknown>;
}

/** Every backup file rotation left on disk, by name. */
function backupFiles(fs: MemoryFs): string[] {
  return BACKUP_NAMES.filter((name) => fs.has(joinPath(DIR, name))).sort();
}

/** What one generation holds, or null when that generation is not there. */
async function generation(fs: MemoryFs, n: number): Promise<AppData | null> {
  const path = backupPath(n);
  if (!fs.has(path)) return null;
  return JSON.parse(await fs.readText(path)) as AppData;
}

/** Task ids held by a generation, for the rotation assertions. */
async function generationTaskIds(fs: MemoryFs, n: number): Promise<string[]> {
  const held = await generation(fs, n);
  return Object.keys(held?.tasks ?? {});
}

async function seedFile(fs: MemoryFs, path: string, data: unknown): Promise<void> {
  await fs.writeText(path, JSON.stringify(data));
}

/** A logger that keeps everything, so an incident can be asserted on. */
function recordingLogger(lines: Record<string, unknown>[]): AiLogger {
  return {
    info: (payload) => lines.push(payload),
    warn: (payload) => lines.push(payload),
    error: (payload) => lines.push(payload),
  };
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

    // Anchored on the primary write specifically. The second save also renames
    // the *backup* into place (tmp + rename), so "the first rename" is no
    // longer the primary's once rotation exists.
    const writeIndex = fs.calls.indexOf(`writeText:${dataPath()}.tmp`);
    const renameIndex = fs.calls.indexOf(`rename:${dataPath()}.tmp->${dataPath()}`, writeIndex + 1);
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(writeIndex);
    // The tmp file must not survive a successful save.
    expect(fs.has(`${dataPath()}.tmp`)).toBe(false);
  });

  test('copies the previous file to generation 1 before overwriting', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);

    await store.save(seedData());
    const firstWrite = await fs.readText(dataPath());

    await store.save(seedData({ tasks: { t1: makeTask('t1', { title: 'second' }) } }));

    const backup = await fs.readText(backupPath(1));
    expect(JSON.parse(backup).tasks.t1.title).toBe('task t1');
    // The backup holds the *previous* contents, not the ones just written.
    expect(backup).toBe(firstWrite);
    expect(JSON.parse(await fs.readText(dataPath())).tasks.t1.title).toBe('second');
  });

  test('does not create a backup when there is nothing to overwrite', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.save(seedData());
    expect(fs.has(backupPath(1))).toBe(false);
  });

  test('validates on write, so an invalid shape never reaches disk', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);

    await expect(store.save({ version: 99 } as unknown as AppData)).rejects.toThrow();
    expect(fs.has(dataPath())).toBe(false);
  });

  test('backfills schema defaults for modules added after the file was written', async () => {
    // A pre-FollowUp/pre-Idea data.json: those keys are absent entirely.
    const legacy = { ...emptyAppData() } as Record<string, unknown>;
    delete legacy.followUps;
    delete legacy.ideas;
    const fs = new MemoryFs({ [dataPath()]: JSON.stringify(legacy) });

    const loaded = await (await openStore(fs)).load();

    expect(loaded.followUps).toEqual({});
    expect(loaded.ideas).toEqual({});
  });

  test('falls back to the newest backup when data.json is corrupt', async () => {
    const fs = new MemoryFs({
      [dataPath()]: '{ this is not json',
      [backupPath(1)]: JSON.stringify(
        seedData({ tasks: { t1: makeTask('t1', { title: 'gen 1' }) } }),
      ),
      [backupPath(2)]: JSON.stringify(
        seedData({ tasks: { t1: makeTask('t1', { title: 'gen 2' }) } }),
      ),
    });

    const loaded = await (await openStore(fs)).load();

    expect(loaded.tasks.t1?.title).toBe('gen 1');
  });

  test('falls back to an empty seed when every file is unusable', async () => {
    const fs = new MemoryFs({
      [dataPath()]: 'not json at all',
      [backupPath(1)]: '{ not this either',
      [backupPath(2)]: '{"version":1}',
    });

    const loaded = await (await openStore(fs)).load();

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
    // true, so a save ran on a no-op launch. That save's first step rotates
    // `data.json` into generation 1: the truncated file overwrites the only
    // good copy, before the recovered data is ever written. The recovery
    // destroys what it recovered.
    const good = JSON.stringify(seedData({ tasks: { t1: makeTask('t1', { title: 'precious' }) } }));
    const truncated = '{"version":1,"tasks":{"t1":{"titl';
    const fs = new MemoryFs({
      [dataPath()]: truncated,
      [backupPath(1)]: good,
    });
    const store = await openStore(fs);

    // Bootstrap's exact sequence: load, then two migrations each deciding
    // whether to save by comparing references.
    const data = await store.get();
    expect(data.tasks.t1?.title).toBe('precious');

    const migrated = migrateRemoveTodayTag(await store.get());
    expect(migrated).toBe(await store.get()); // no-op migration, same reference

    // Nothing was written, so the intact backup is untouched — and the corrupt
    // primary is still the corrupt primary rather than having become a backup.
    expect(await fs.readText(backupPath(1))).toBe(good);
    expect(await fs.readText(dataPath())).toBe(truncated);
  });

  test('a corrupt primary that fell back to a backup still refuses every write', async () => {
    // The Electron original latches here too, and the latch is the point: the
    // cache is a *fallback*, so persisting it would overwrite the only intact
    // copy with a degraded one. Recovering the data is not the same as being
    // able to write; the user has to repair the file (or delete it) first.
    const good = JSON.stringify(seedData({ tasks: { t1: makeTask('t1', { title: 'precious' }) } }));
    const fs = new MemoryFs({
      [dataPath()]: '{"version":1,"tasks":{"t1":{"titl',
      [backupPath(1)]: good,
    });
    const store = await openStore(fs);
    expect((await store.get()).tasks.t1?.title).toBe('precious');

    const result = await store.update((d) => ({
      ...d,
      settings: { ...d.settings, userName: 'later' },
    }));

    expect(result.persisted).toBe(false);
    // Both files exactly as the user left them.
    expect(await fs.readText(dataPath())).toBe('{"version":1,"tasks":{"t1":{"titl');
    expect(await fs.readText(backupPath(1))).toBe(good);
  });

  test('update() persists the value the callback returns', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.save(seedData());

    const { data: next } = await store.update((d) => ({
      ...d,
      settings: { ...d.settings, userName: 'renamed-user' },
    }));

    expect(next.settings.userName).toBe('renamed-user');
    const onDisk = JSON.parse(await fs.readText(dataPath()));
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

    const loaded = await reload(new MemoryFs({ [dataPath()]: JSON.stringify(rich) }));

    expect(loaded.tasks.t1?.title).toBe('中文标题');
    expect(loaded.tasks.t1?.isDone).toBe(true);
    expect(loaded.tasks.t2?.subTaskIds).toEqual(['t1']);
    expect(loaded.tasks.t2?.timeSpentOnDay).toEqual({ '2026-10-08': 1200 });
    expect(loaded.tags.g1?.color).toBe('red');
  });
});

describe('DataStore — a bad record must not cost the whole library', () => {
  const full = () => ({
    ...emptyAppData(),
    tasks: { t1: makeTask('t1', { created: 1 }) },
    ideas: { i1: makeIdea('i1', { title: '想法' }) },
  });

  test('one idea with an unknown status is quarantined, the rest loads', async () => {
    // IdeaStatusSchema deliberately throws on a status this build does not
    // know, so that a closed idea from a newer build is never silently
    // downgraded to open. A strict parse would reject the whole document and
    // cost the user every task; the quarantine keeps the blast radius at one
    // record.
    const fs = new MemoryFs({
      [dataPath()]: JSON.stringify({
        ...full(),
        ideas: {
          ...full().ideas,
          i2: { id: 'i2', title: '未来状态', notes: '', createdAt: 1, status: 'archived' },
        },
      }),
    });

    const data = await (await openStore(fs)).load();

    expect(Object.keys(data.tasks)).toEqual(['t1']);
    expect(Object.keys(data.ideas)).toEqual(['i1']);
  });

  test('a quarantined idea does not block saving the rest', async () => {
    const fs = new MemoryFs({
      [dataPath()]: JSON.stringify({
        ...full(),
        ideas: { i2: { id: 'i2', title: 'x', notes: '', createdAt: 1, status: 'archived' } },
      }),
    });
    const store = await openStore(fs);
    await store.load();

    const result = await store.update((d) => ({
      ...d,
      settings: { ...d.settings, userName: 'me' },
    }));

    // Assert the value reached the disk, not merely that update() did not
    // throw: a store that latched on the quarantine would refuse every write
    // and pass a not.toThrow() check here.
    expect(result.persisted).toBe(true);
    expect((await reload(fs)).settings.userName).toBe('me');
  });

  test('a repaired data.json unblocks saving without a restart', async () => {
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    // The user repairs the file by hand while the app is still running.
    await seedFile(fs, dataPath(), full());

    const result = await store.update((d) => ({
      ...d,
      settings: { ...d.settings, userName: 'fixed' },
    }));
    expect(result.persisted).toBe(true);

    const after = await reload(fs);
    expect(after.settings.userName).toBe('fixed');
    // The repaired *content* has to survive too. Asserting only the settings
    // field is what let the destruction through twice: the stale fallback
    // cache preserved nothing, and the write it produced passed that check
    // while wiping the tasks and ideas the user had just repaired.
    expect(Object.keys(after.tasks)).toEqual(['t1']);
    expect(Object.keys(after.ideas)).toEqual(['i1']);
  });

  test('an unreadable file refuses every write and leaves the disk untouched', async () => {
    const corrupt = '{ not json';
    const fs = new MemoryFs({ [dataPath()]: corrupt });
    const store = await openStore(fs);
    await store.load();

    for (const userName of ['a', 'b']) {
      await store.update((d) => ({ ...d, settings: { ...d.settings, userName } }));
    }

    expect(await fs.readText(dataPath())).toBe(corrupt);
    expect(backupFiles(fs)).toEqual([]);
  });

  test('a refused store still tells the operator exactly once', async () => {
    // The refusal log lived only in save(), and update() returns before
    // reaching it — so the dominant write path dropped every user write with
    // no signal at all. One line per incident, not one per heartbeat.
    const lines: Record<string, unknown>[] = [];
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs, recordingLogger(lines));
    await store.load();
    lines.length = 0;

    for (let i = 0; i < 5; i += 1) {
      await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'x' } }));
    }

    const refused = lines.filter((l) => l.action === 'dataStore:save:refused');
    expect(refused).toHaveLength(1);
    expect(String(refused[0]?.reason)).toContain('invalid json');
  });

  test('deleting the unreadable file keeps the backup as the base', async () => {
    // Handing back emptyAppData() here looked like a resolution and was its
    // own destruction: the next write persisted that empty set to data.json,
    // and the one after that rotated it over the still-intact backup. Deleting
    // one corrupt file must not lose every task.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    await store.update((d) => ({
      ...d,
      tasks: { t1: makeTask('t1') },
      ideas: { i1: makeIdea('i1') },
    }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'b' } }));
    // data.json and the backup both hold t1/i1; corrupt then delete the primary.
    await seedFile(fs, dataPath(), '{ not json');

    const reloaded = await openStore(fs);
    await reloaded.load();
    expect(Object.keys((await reloaded.get()).tasks)).toEqual(['t1']);

    await fs.remove(dataPath());
    await reloaded.update((d) => ({ ...d, settings: { ...d.settings, userName: 'w1' } }));
    await reloaded.update((d) => ({ ...d, settings: { ...d.settings, userName: 'w2' } }));

    const after = await reload(fs);
    expect(Object.keys(after.tasks)).toEqual(['t1']);
    expect(Object.keys(after.ideas)).toEqual(['i1']);
    expect(after.settings.userName).toBe('w2');
    expect(await generationTaskIds(fs, 1)).toEqual(['t1']);
  });

  test('deleting the unreadable file unblocks writing instead of latching forever', async () => {
    // readValidated reports nothing for a missing file, so a deleted one was
    // indistinguishable from a still-broken one: every write was then refused
    // for the life of the process, with the stored reason still quoting a parse
    // error for a file that no longer existed.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    expect(store.isWritable).toBe(false);

    await fs.remove(dataPath());
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'fresh' } }));

    expect(store.isWritable).toBe(true);
    expect((await reload(fs)).settings.userName).toBe('fresh');
  });

  test('repeated writes on a still-unreadable file terminate and never write', async () => {
    const corrupt = '{ still not json';
    const fs = new MemoryFs({ [dataPath()]: corrupt });
    const store = await openStore(fs);
    await store.load();

    for (let i = 0; i < 200; i += 1) {
      await store.update((d) => ({ ...d, settings: { ...d.settings, userName: `x${i}` } }));
    }

    expect(await fs.readText(dataPath())).toBe(corrupt);
    expect(backupFiles(fs)).toEqual([]);
  });

  test('a direct save() cannot persist a value derived from the fallback', async () => {
    // save() takes an absolute dataset, so unlike update() it has no way to
    // re-base one against a recovered file. The latch stays armed until
    // something re-reads, so a direct save of the stale fallback is refused
    // rather than quietly overwriting the user's repair.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    const stale = await store.get();
    // The user repairs the file by hand after the app started.
    await seedFile(fs, dataPath(), {
      ...emptyAppData(),
      tasks: { t1: makeTask('t1') },
      ideas: { i1: makeIdea('i1') },
    });

    expect(await store.save(stale)).toBe(false);

    const after = await reload(fs);
    expect(Object.keys(after.tasks)).toEqual(['t1']);
    expect(Object.keys(after.ideas)).toEqual(['i1']);
  });

  test('a genuinely unreadable data.json is never overwritten by a fallback load', async () => {
    // The destruction chain: a strict parse fails, the cache is a fallback,
    // and the first ordinary write replaces the only good copy.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'again' } }));

    // Both files still hold exactly what the user left there.
    expect(await fs.readText(dataPath())).toBe('{ not json');
    expect(backupFiles(fs)).toEqual([]);
  });

  test('a readable data.json still saves normally', async () => {
    const fs = new MemoryFs({
      [dataPath()]: JSON.stringify({ ...emptyAppData(), tasks: { t1: makeTask('t1') } }),
    });
    const store = await openStore(fs);
    await store.load();

    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } }));

    expect((await reload(fs)).settings.userName).toBe('me');
  });
});

describe('DataStore — a write must be able to report that it did not happen', () => {
  test('update reports persisted:false when the store refuses', async () => {
    // The refusal used to be invisible to the caller: update() handed back the
    // degraded fallback and every write-path reported success for a change
    // that was in memory only. stopTiming returned ok:true on this path, so
    // the user saw their hours recorded and lost them on restart.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();

    const result = await store.update((d) => ({
      ...d,
      settings: { ...d.settings, userName: 'me' },
    }));

    expect(result.persisted).toBe(false);
    // And the dataset it hands back is the fallback, not the requested change —
    // which is exactly why callers must not read it as "what I just wrote".
    expect(result.data.settings.userName).toBe('');
  });

  test('update reports persisted:true on a normal write', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();

    const result = await store.update((d) => ({
      ...d,
      settings: { ...d.settings, userName: 'me' },
    }));

    expect(result.persisted).toBe(true);
  });

  test('a mutation that changes nothing skips the write entirely', async () => {
    // The renderer's 30s heartbeat re-sends the timer it already has. Each of
    // those writes cost a full schema validation, a backup rotation and a
    // tmp+rename — ~120 an hour for a dataset that did not change.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    await store.update((d) => ({ ...d, tasks: { t1: makeTask('t1') } }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } }));
    const before = await fs.readText(dataPath());
    const backupBefore = await fs.readText(backupPath(1));

    // Returning the same reference is how "nothing to write" is expressed.
    const result = await store.update((d) => d);

    expect(result.persisted).toBe(true);
    expect(await fs.readText(dataPath())).toBe(before);
    // The backup is the tell: a rotation would have replaced it.
    expect(await fs.readText(backupPath(1))).toBe(backupBefore);
  });
});

describe('DataStore — backup rotation', () => {
  /** Seeds two tasks and rotates, so the backup holds both. */
  async function withTasks(fs: MemoryFs): Promise<DataStore> {
    const store = await openStore(fs);
    await store.load();
    await store.update((d) => ({
      ...d,
      tasks: { t1: makeTask('t1'), t2: makeTask('t2') },
    }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'rotate' } }));
    return store;
  }

  test('a poorer dataset does not replace a richer backup', async () => {
    // The count guard has to be a generation rule, not a one-write reprieve.
    // The first attempt at it only checked "is the outgoing dataset empty",
    // which bought exactly one write: the user cleared their tasks, the backup
    // was spared, and then the first new task rotated the emptiness over that
    // backup anyway — losing both copies, which is the outcome the guard
    // claims to prevent.
    const fs = new MemoryFs();
    const store = await withTasks(fs);

    await store.update((d) => ({ ...d, tasks: {} }));
    expect((await reload(fs)).tasks).toEqual({});
    expect(await generationTaskIds(fs, 1)).toEqual(['t1', 't2']);

    // Rebuilding to fewer records than the backup holds must not demote it.
    await store.update((d) => ({ ...d, tasks: { t3: makeTask('t3') } }));
    expect(await generationTaskIds(fs, 1)).toEqual(['t1', 't2']);
    expect(Object.keys((await reload(fs)).tasks)).toEqual(['t3']);
  });

  test('rotation resumes once the dataset on disk is itself as rich as the backup', async () => {
    // The other half of the property: without it the guard would freeze the
    // backup forever, which was the objection that killed the original.
    // Rotation promotes the file currently on disk, so the dataset has to reach
    // the backup's size *and then be written once more* before it can be
    // promoted in turn.
    const fs = new MemoryFs();
    const store = await withTasks(fs);

    await store.update((d) => ({ ...d, tasks: {} }));
    await store.update((d) => ({ ...d, tasks: { t3: makeTask('t3'), t4: makeTask('t4') } }));
    // Still blocked: what is on disk is the empty dataset.
    expect(await generationTaskIds(fs, 1)).toEqual(['t1', 't2']);

    // One more write, with the on-disk dataset now holding two records.
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'again' } }));
    expect(await generationTaskIds(fs, 1)).toEqual(['t3', 't4']);
  });

  test('an emptied library with no readable backup still rotates', async () => {
    // Nothing is lost by rotating here, and refusing to would strand a stale
    // backup as the only recovery point forever.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'first' } }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'second' } }));
    await fs.remove(backupPath(1));

    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'third' } }));

    expect(fs.has(backupPath(1))).toBe(true);
    expect(((await readJson(fs, backupPath(1))).settings as Record<string, unknown>).userName).toBe(
      'second',
    );
  });

  test('a rotation refreshes what the guard believes about the backup', async () => {
    // The guard's answer is cached, and a stale cache would decide against the
    // previous generation. Sequence: the backup holds two tasks, the dataset is
    // emptied (rotation suppressed), then rebuilt large enough to rotate — and
    // the rotation leaves that rebuilt dataset in the backup, which the *next*
    // shrinking write must be measured against, not the old two-task figure.
    const fs = new MemoryFs();
    const store = await withTasks(fs);

    await store.update((d) => ({ ...d, tasks: {} }));
    await store.update((d) => ({ ...d, tasks: { t3: makeTask('t3'), t4: makeTask('t4') } }));
    // The rotation above left a two-record backup on disk. A write that shrinks
    // to one record must now be measured against *that*. A cache still holding
    // a pre-rotation figure of 0 would have allowed it.
    await store.update((d) => ({ ...d, tasks: { t9: makeTask('t9') } }));

    expect(await generationTaskIds(fs, 1)).toEqual(['t3', 't4']);
  });

  test('the guard measures the dataset the backup will hold, not the one replacing it', async () => {
    // rotateBackup copies data.json, so the dataset that becomes the backup is
    // the one *currently on disk*. Comparing the incoming dataset instead let
    // an import pass the check — 200 tasks beats a 10-task backup — and then
    // demote the 2-task file that was actually on disk over that backup. The
    // generation the guard exists to protect, gone.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    const many = (prefix: string, n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [prefix + i, makeTask(prefix + i)]));

    await store.update((d) => ({ ...d, tasks: many('t', 10) }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'rotate' } }));
    expect(await generationTaskIds(fs, 1)).toHaveLength(10);

    // Shrink to 2: blocked, backup keeps 10.
    await store.update((d) => ({ ...d, tasks: many('s', 2) }));
    expect(await generationTaskIds(fs, 1)).toHaveLength(10);

    // Import 200. The incoming dataset dwarfs the backup and passes the check —
    // but the file being rotated is the 2-task one, which is far poorer.
    await store.update((d) => ({ ...d, tasks: many('i', 200) }));
    expect(await generationTaskIds(fs, 1)).toHaveLength(10);
    expect((await reload(fs)).tasks.i0).toBeDefined();
  });

  test('a rotation updates the cached count instead of discarding it', async () => {
    // Nulling the cache on every rotation meant the common path filled and
    // cleared it on the same save, so the cache only ever helped when rotation
    // was suppressed — the case it was not written for.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    await store.update((d) => ({ ...d, tasks: { t1: makeTask('t1'), t2: makeTask('t2') } }));
    await store.update((d) => ({ ...d, tasks: { t1: makeTask('t1') } }));

    const cache = (store as unknown as { cachedBackupRecords: number | null }).cachedBackupRecords;
    expect(cache).toBe(2);
  });

  test('no generation is ever left behind half-written', async () => {
    // A plain copy straight into a backup had the asymmetry PR #7's review
    // flagged: the primary write is tmp+rename, so a crash cannot truncate it,
    // while a crash during the copy left a half-written backup — turning one
    // damaged file into two. Every generation has to keep that property, not
    // just the newest one, so this walks the whole chain rather than the first
    // rotation.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    for (const userName of ['first', 'second', 'third', 'fourth']) {
      await store.update((d) => ({ ...d, settings: { ...d.settings, userName } }));
    }

    expect(fs.has(`${backupPath(1)}.tmp`)).toBe(false);
    expect(fs.has(`${dataPath()}.tmp`)).toBe(false);
    expect((await generation(fs, 1))?.settings.userName).toBe('third');
  });
});

describe('DataStore — backups are kept as generations, not as one content-checked copy', () => {
  test('generations rotate in write order and the one past the last is dropped', async () => {
    // Retention is by write order, not by what each copy holds. Four writes
    // therefore leave exactly the two preceding ones and discard the third —
    // no question asked of the contents, and nothing that has to be re-decided
    // on the next save.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();

    for (const userName of ['w1', 'w2', 'w3', 'w4']) {
      await store.update((d) => ({ ...d, settings: { ...d.settings, userName } }));
    }

    expect(backupFiles(fs)).toEqual(['data.backup.1.json', 'data.backup.2.json']);
    expect((await generation(fs, 1))?.settings.userName).toBe('w3');
    expect((await generation(fs, 2))?.settings.userName).toBe('w2');
    expect((await reload(fs)).settings.userName).toBe('w4');
  });

  test('an emptied library is still recoverable after any number of later writes', async () => {
    // The case the content guard alone cannot hold. Clearing the library does
    // not stay a reprieve: the user then creates other records, the count
    // catches up, and the emptiness is rotated in like any other write. Under
    // the single-backup scheme that was the last copy of the tasks. Here
    // generation 2 still holds them, which is the entire point of keeping two.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    await store.update((d) => ({ ...d, tasks: { t1: makeTask('t1'), t2: makeTask('t2') } }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'rotate' } }));

    // The user clears the library and keeps working.
    await store.update((d) => ({ ...d, tasks: {} }));
    await store.update((d) => ({ ...d, ideas: { i1: makeIdea('i1'), i2: makeIdea('i2') } }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'after' } }));

    // Generation 1 has rotated on, exactly as it would have before.
    expect((await generation(fs, 1))?.tasks).toEqual({});
    // The tasks are not gone. They are one generation back.
    expect(await generationTaskIds(fs, 2)).toEqual(['t1', 't2']);
  });

  test('an existing data.backup.json becomes generation 1 without being lost', async () => {
    // The migration is lazy because the file is the user's data: it is folded
    // in on load, before anything can read or overwrite a backup, so there is
    // no launch sequence in which it is skipped or destroyed.
    const legacy = {
      ...emptyAppData(),
      settings: { ...emptyAppData().settings, userName: 'legacy' },
    };
    const fs = new MemoryFs({ [legacyBackupPath()]: JSON.stringify(legacy) });

    await (await openStore(fs)).load();
    expect(fs.has(legacyBackupPath())).toBe(false);
    expect((await generation(fs, 1))?.settings.userName).toBe('legacy');

    // And it is the copy a later load falls back to, which is the point of
    // keeping it: a corrupt primary still lands on the user's data.
    await seedFile(fs, dataPath(), '{ not json');
    expect((await reload(fs)).settings.userName).toBe('legacy');
  });

  test('adoption demotes the generation it would have replaced', async () => {
    // Only a run of an older build in between can produce this: it writes the
    // old name again while the generations are already there. Overwriting
    // generation 1 would drop whichever copy was newer, so the loser moves down
    // a slot instead — the same slot it would have held after any other write.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'generation' } }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'current' } }));
    await seedFile(fs, legacyBackupPath(), {
      ...emptyAppData(),
      settings: { ...emptyAppData().settings, userName: 'legacy' },
    });

    await (await openStore(fs)).load();

    expect((await generation(fs, 1))?.settings.userName).toBe('legacy');
    expect((await generation(fs, 2))?.settings.userName).toBe('generation');
    expect(fs.has(legacyBackupPath())).toBe(false);
  });

  test('the count sees chat sessions, so losing only those does not demote the backup', async () => {
    // countRecords skipped misc.chatSessions because it is not a keyed record
    // map — so it contributed 0 on both sides of the guard. A user whose chat
    // history was wiped then scored exactly like one who still had it, and the
    // rotation the guard let through destroyed the only other copy.
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    const sessions = [{ id: 'c1' }, { id: 'c2' }];

    await store.update((d) => ({
      ...d,
      tasks: { t1: makeTask('t1'), t2: makeTask('t2') },
      misc: { ...d.misc, chatSessions: sessions },
    }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'rotate' } }));
    expect((await generation(fs, 1))?.misc.chatSessions).toHaveLength(2);

    // Two tasks either way, and the sessions are the only thing that changes.
    // This write puts the loss on disk; the next one is the one that would
    // rotate it over the backup — the guard measures what is *on disk*, so a
    // single write cannot show the difference.
    await store.update((d) => ({ ...d, misc: {} }));
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'after' } }));

    expect((await reload(fs)).misc.chatSessions).toBeUndefined();
    expect((await generation(fs, 1))?.misc.chatSessions).toHaveLength(2);
    // And one generation further back, the loss was never the only copy.
    expect((await generation(fs, 2))?.misc.chatSessions).toHaveLength(2);
  });
});

describe('DataStore — a recovery must leave a record of what it discarded', () => {
  test('a re-read that quarantined records reports them', async () => {
    // tryRecover used to pass an empty callback into readValidated, so a
    // re-read that succeeded *only* after dropping records logged a plain
    // "recovered" — telling the operator nothing had been lost.
    const lines: Record<string, unknown>[] = [];
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs, recordingLogger(lines));
    await store.load();
    lines.length = 0;

    // The user repairs the file, but one idea in it is still unparseable.
    await seedFile(fs, dataPath(), {
      ...emptyAppData(),
      tasks: { t1: makeTask('t1') },
      ideas: { i2: { id: 'i2', title: 'x', notes: '', createdAt: 1, status: 'archived' } },
    });
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'fixed' } }));

    const recovered = lines.find((l) => l.action === 'dataStore:save:recovered');
    expect(recovered).toBeDefined();
    expect(JSON.stringify(recovered?.quarantined)).toContain('quarantined idea i2');
  });

  test('the file-removed log names the backup state', async () => {
    // `previousReason` describes the *deleted* file, so it says nothing about
    // the backup — and `adopted: 'empty'` cannot tell "no backup existed" from
    // "the backup was there and unreadable". Those are different incidents for
    // whoever restores by hand.
    const lines: Record<string, unknown>[] = [];
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs, recordingLogger(lines));
    await store.load();

    await fs.remove(dataPath());
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'x' } }));

    const removed = lines.find((l) => l.action === 'dataStore:save:file-removed');
    expect(removed?.adopted).toBe('empty');
    expect(removed?.backupState).toBe('missing');
  });

  test('a listener runs before the write that triggered recovery', async () => {
    // bootstrap defers the startup migrations through this hook. A listener
    // that migrated the recovered dataset and was then overwritten by update()'s
    // own save meant the feature did nothing on the first recovery — the only
    // case it exists for. This asserts the write that recovered the store is
    // what lands, with the listener's contribution already in it.
    //
    // Awaited, unlike the original: a listener here writes through this store,
    // so its promise has to settle before the pending mutation is enqueued or
    // the ordering this test pins is not guaranteed by anything.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    const seen: string[] = [];
    store.onRecovered(async () => {
      seen.push((await store.get()).settings.userName);
      // Stand in for the migration: mutate the recovered dataset.
      await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'migrated' } }));
    });
    await seedFile(fs, dataPath(), emptyAppData());

    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'user-write' } }));

    expect(seen).toEqual(['']);
    // The user's write is what survives — the listener ran before it, not
    // after, and not in a state the save then clobbered.
    expect((await reload(fs)).settings.userName).toBe('user-write');
  });

  test('the recovery write is applied on top of what the listener left', async () => {
    // The listener's job is to migrate the recovered base; the pending user
    // write must then apply to that migrated dataset rather than to the
    // pre-migration object update() originally re-read.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    store.onRecovered(async () => {
      await store.update((d) => ({ ...d, misc: { ...d.misc, migrated: true } }));
    });
    await seedFile(fs, dataPath(), { ...emptyAppData(), tasks: { t1: makeTask('t1') } });

    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'after' } }));

    const after = await reload(fs);
    expect(after.misc.migrated).toBe(true);
    expect(after.settings.userName).toBe('after');
    expect(Object.keys(after.tasks)).toEqual(['t1']);
  });

  test('a recovery that cannot be written notifies nobody', async () => {
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    let fired = 0;
    store.onRecovered(() => {
      fired += 1;
    });

    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'x' } }));

    expect(fired).toBe(0);
  });
});

describe('DataStore — the read-only mode is observable state, not a per-write verdict', () => {
  test('a subscriber is told the current state immediately', async () => {
    // A store that latched before the renderer mounted would otherwise look
    // writable until something else happened to trigger a re-render.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    const seen: [boolean, string | null][] = [];

    store.onModeChanged((writable, reason) => seen.push([writable, reason]));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(false);
    expect(seen[0]?.[1]).toContain('invalid json');
  });

  test('a healthy store reports writable on subscribe', async () => {
    const fs = new MemoryFs();
    const store = await openStore(fs);
    await store.load();
    const seen: boolean[] = [];

    store.onModeChanged((writable) => seen.push(writable));

    expect(seen).toEqual([true]);
  });

  test('an unsubscribed listener stops hearing about transitions', async () => {
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    const seen: boolean[] = [];
    const stop = store.onModeChanged((writable) => seen.push(writable));
    stop();

    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'x' } }));

    // Only the immediate report on subscribe.
    expect(seen).toEqual([false]);
  });

  test('a healthy store and recovery flips it back', async () => {
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    const seen: boolean[] = [];
    store.onModeChanged((writable) => seen.push(writable));

    await seedFile(fs, dataPath(), emptyAppData());
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'fixed' } }));

    expect(seen).toEqual([false, true]);
  });

  test('deleting the unreadable file flips it back too', async () => {
    // The other recovery path. Missing it leaves a banner up for a store that
    // has been writable for hours.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    const seen: boolean[] = [];
    store.onModeChanged((writable) => seen.push(writable));

    await fs.remove(dataPath());
    await store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'fresh' } }));

    expect(seen).toEqual([false, true]);
  });

  test('a refused write reports read-only even when the file never changed', async () => {
    // Nothing about the file changes while it stays broken, so "did this write
    // land" can only be answered by the mode — which is why every debounced
    // edit that nobody checks depends on it.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();
    const seen: boolean[] = [];
    store.onModeChanged((writable) => seen.push(writable));

    // The first entry is the immediate report on subscribe; the second is the
    // first refusal. Three refused writes add nothing after that — the banner
    // is not a toast, and the latch that stopped the log doing the same is the
    // same one.
    for (let i = 0; i < 3; i += 1) {
      await store.update((d) => ({ ...d, settings: { ...d.settings, userName: `x${i}` } }));
    }

    expect(seen).toEqual([false, false]);
  });

  test('the unreadable reason is readable without attempting a write', async () => {
    // The pull handler reports { writable:false, reason } and the banner
    // renders it. Hardcoding reason:null there left the banner invisible on
    // exactly the case it exists for — a store that latched at startup, before
    // anything was pushed and before any write was attempted.
    const fs = new MemoryFs({ [dataPath()]: '{ not json' });
    const store = await openStore(fs);
    await store.load();

    expect(store.isWritable).toBe(false);
    expect(store.unreadableReason).toContain('invalid json');
  });

  test('a healthy store reports no reason', async () => {
    const store = await openStore(new MemoryFs());
    await store.load();

    expect(store.unreadableReason).toBeNull();
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

    override async remove(path: string) {
      await this.tick();
      return super.remove(path);
    }

    override async readText(path: string) {
      await this.tick();
      return super.readText(path);
    }
  }

  async function onDisk(fs: MemoryFs): Promise<AppData> {
    return JSON.parse(await fs.readText(dataPath())) as AppData;
  }

  test('two overlapping updates both land instead of one erasing the other', async () => {
    // The concrete race this guards: `settingsUpdate`'s callback awaits WebCrypto
    // before returning, while the 30s heartbeat fires `timerSync` against the
    // same dataset. Both read the same snapshot, both persist it, and the
    // second write silently reverts the first — the user sees their own
    // settings change disappear.
    const fs = new SlowFs();
    const store = await DataStore.open(DIR, fs, silentLogger);
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
    const store = await DataStore.open(DIR, fs, silentLogger);
    await store.save(seedData());

    const results = await Promise.all(
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
    expect(results.every((r) => r.persisted)).toBe(true);
  });

  test('a failed update does not poison the ones queued behind it', async () => {
    // The chain's own rejection is swallowed so the queue keeps draining; the
    // failing call still rejects for its own caller. Without this, one bad
    // settings write would wedge every later write for the rest of the session.
    const fs = new SlowFs(1);
    const store = await DataStore.open(DIR, fs, silentLogger);
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
    const store = await DataStore.open(DIR, fs, silentLogger);
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

  test('concurrent updates into a broken store recover exactly once', async () => {
    // Two updates racing into a latched store: without serialising the probe,
    // both would fire the recovery listeners and the deferred migrations would
    // run twice over the same dataset.
    const fs = new SlowFs(1);
    const store = await DataStore.open(DIR, fs, silentLogger);
    await fs.writeText(dataPath(), '{ not json');
    await store.load();
    let recoveries = 0;
    store.onRecovered(async () => {
      recoveries += 1;
    });

    // The user repairs the file while two writes are already in flight.
    await seedFile(fs, dataPath(), emptyAppData());
    await Promise.all([
      store.update(async (d) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ...d, settings: { ...d.settings, userName: 'a' } };
      }),
      store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'b' } })),
    ]);

    expect(recoveries).toBe(1);
    expect(store.isWritable).toBe(true);
    expect((await onDisk(fs)).settings.userName).toBe('b');
  });
});
