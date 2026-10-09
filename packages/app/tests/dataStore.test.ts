import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDataSchema, emptyAppData } from '@tiny-schedule/shared';
import type { Logger } from 'pino';
import { DataStore } from '../src/main/infra/dataStore';

/** Records what the store reported, so the fallback path can be asserted. */
const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'tsdata-'));
}

describe('DataStore', () => {
  test('load returns empty data when no file exists', () => {
    const store = new DataStore(tmpDir(), logger);
    const d = store.load();
    expect(d.version).toBe(1);
    expect(Object.keys(d.tasks)).toHaveLength(0);
  });

  test('save persists to data.json and reload reads it back', () => {
    const dir = tmpDir();
    const store = new DataStore(dir, logger);
    store.load();
    const { data: d } = store.update((cur) => ({
      ...cur,
      tasks: { ...cur.tasks, t1: { ...emptyTask(), id: 't1' } },
    }));
    expect(d.tasks.t1?.id).toBe('t1');
    const reloaded = new DataStore(dir, logger).load();
    expect(reloaded.tasks.t1?.id).toBe('t1');
    // no temp files left behind
    const raw = readFileSync(join(dir, 'data.json'), 'utf8');
    expect(JSON.parse(raw).version).toBe(1);
  });

  test('save keeps previous file as data.backup.json', () => {
    const dir = tmpDir();
    const s1 = new DataStore(dir, logger);
    s1.load();
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'first' } }));
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'second' } }));
    const backup = JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8'));
    expect(backup.settings.userName).toBe('first');
    expect(new DataStore(dir, logger).load().settings.userName).toBe('second');
  });

  test('corrupt data.json falls back to backup', () => {
    const dir = tmpDir();
    const s1 = new DataStore(dir, logger);
    s1.load();
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'good' } }));
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'newer' } }));
    writeFileSync(join(dir, 'data.json'), '{{{ not json');
    const d = new DataStore(dir, logger).load();
    expect(d.settings.userName).toBe('good');
  });

  test('corrupt data.json and no backup returns empty data', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{{{ not json');
    const d = new DataStore(dir, logger).load();
    expect(d).toEqual(emptyAppData());
  });

  test('invalid schema falls back to empty data', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), JSON.stringify({ version: 99 }));
    const d = new DataStore(dir, logger).load();
    expect(d.version).toBe(1);
  });
});

function emptyTask() {
  return {
    id: '',
    title: 'x',
    projectId: 'INBOX_PROJECT',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
  };
}

describe('DataStore — a bad record must not cost the whole library', () => {
  function seed(dir: string, data: unknown) {
    writeFileSync(join(dir, 'data.json'), JSON.stringify(data), 'utf8');
  }
  const full = () => ({
    ...emptyAppData(),
    version: emptyAppData().version,
    tasks: {
      t1: {
        id: 't1',
        title: 'x',
        projectId: 'p1',
        tagIds: [],
        subTaskIds: [],
        isDone: false,
        timeEstimate: 0,
        timeSpent: 0,
        timeSpentOnDay: {},
        timeEntries: [],
        notes: '',
        created: 1,
      },
    },
    ideas: { i1: { id: 'i1', title: '想法', notes: '', createdAt: 1, status: 'open' } },
  });

  test('one idea with an unknown status is quarantined, the rest loads', () => {
    // IdeaStatusSchema deliberately throws on a status this build does not
    // know, so that a closed idea from a newer build is never silently
    // downgraded to open. A strict parse would reject the whole document and
    // cost the user every task; the quarantine keeps the blast radius at one
    // record.
    const dir = tmpDir();
    seed(dir, {
      ...full(),
      ideas: {
        ...full().ideas,
        i2: { id: 'i2', title: '未来状态', notes: '', createdAt: 1, status: 'archived' },
      },
    });
    const store = new DataStore(dir, logger);
    const data = store.load();
    expect(Object.keys(data.tasks)).toEqual(['t1']);
    expect(Object.keys(data.ideas)).toEqual(['i1']);
  });

  test('a quarantined idea does not block saving the rest', () => {
    const dir = tmpDir();
    seed(dir, {
      ...full(),
      ideas: { i2: { id: 'i2', title: 'x', notes: '', createdAt: 1, status: 'archived' } },
    });
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } }));
    // Assert the value reached the disk, not merely that update() did not
    // throw: save() returns void when it refuses, so a not.toThrow() here
    // passed against the store being permanently read-only.
    expect(new DataStore(dir, logger).load().settings.userName).toBe('me');
  });

  test('a repaired data.json unblocks saving without a restart', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    // The user repairs the file by hand while the app is still running.
    seed(dir, full());
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'fixed' } }));
    const after = new DataStore(dir, logger).load();
    expect(after.settings.userName).toBe('fixed');
    // The repaired *content* has to survive too. Asserting only the settings
    // field is what let the destruction through twice: the stale fallback
    // cache preserved nothing, and the write it produced passed that check
    // while wiping the tasks and ideas the user had just repaired.
    expect(Object.keys(after.tasks)).toEqual(['t1']);
    expect(Object.keys(after.ideas)).toEqual(['i1']);
  });

  test('an unreadable file refuses every write and leaves the disk untouched', () => {
    const dir = tmpDir();
    const corrupt = '{ not json';
    writeFileSync(join(dir, 'data.json'), corrupt, 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'a' } }));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'b' } }));
    expect(readFileSync(join(dir, 'data.json'), 'utf8')).toBe(corrupt);
    expect(existsSync(join(dir, 'data.backup.json'))).toBe(false);
  });

  test('a refused store still tells the operator exactly once', () => {
    // The refusal log lived only in save(), and update() returns before
    // reaching it — so the dominant write path dropped every user write with
    // no signal at all. One line per incident, not one per heartbeat.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const lines: Record<string, unknown>[] = [];
    const store = new DataStore(dir, {
      info: () => {},
      warn: () => {},
      error: (o: Record<string, unknown>) => lines.push(o),
    } as unknown as Logger);
    store.load();
    lines.length = 0;
    for (let i = 0; i < 5; i += 1) {
      store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'x' } }));
    }
    const refused = lines.filter((l) => l.action === 'dataStore:save:refused');
    expect(refused).toHaveLength(1);
    expect(String(refused[0]?.reason)).toContain('invalid json');
  });

  test('deleting the unreadable file keeps the backup as the base', () => {
    // Handing back emptyAppData() here looked like a resolution and was its
    // own destruction: the next write persisted that empty set to data.json,
    // and the one after that rotated it over the still-intact backup. Deleting
    // one corrupt file must not lose every task.
    const dir = tmpDir();
    seed(dir, full());
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'a' } }));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'b' } }));
    // data.json and the backup both hold t1/i1; corrupt then delete the primary.
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const reloaded = new DataStore(dir, logger);
    reloaded.load();
    expect(Object.keys(reloaded.get().tasks)).toEqual(['t1']);
    unlinkSync(join(dir, 'data.json'));
    reloaded.update((d) => ({ ...d, settings: { ...d.settings, userName: 'w1' } }));
    reloaded.update((d) => ({ ...d, settings: { ...d.settings, userName: 'w2' } }));
    const after = new DataStore(dir, logger).load();
    expect(Object.keys(after.tasks)).toEqual(['t1']);
    expect(Object.keys(after.ideas)).toEqual(['i1']);
    expect(after.settings.userName).toBe('w2');
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).tasks),
    ).toEqual(['t1']);
  });

  test('deleting the unreadable file unblocks writing instead of latching forever', () => {
    // readValidated reports nothing for a missing file, so a deleted one was
    // indistinguishable from a still-broken one: every write was then refused
    // for the life of the process, with the stored reason still quoting a parse
    // error for a file that no longer existed.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    expect(store.isWritable).toBe(false);
    unlinkSync(join(dir, 'data.json'));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'fresh' } }));
    expect(store.isWritable).toBe(true);
    expect(new DataStore(dir, logger).load().settings.userName).toBe('fresh');
  });

  test('repeated writes on a still-unreadable file terminate and never write', () => {
    const dir = tmpDir();
    const corrupt = '{ still not json';
    writeFileSync(join(dir, 'data.json'), corrupt, 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    for (let i = 0; i < 200; i += 1) {
      store.update((d) => ({ ...d, settings: { ...d.settings, userName: `x${i}` } }));
    }
    expect(readFileSync(join(dir, 'data.json'), 'utf8')).toBe(corrupt);
    expect(existsSync(join(dir, 'data.backup.json'))).toBe(false);
  });

  test('a direct save() cannot persist a value derived from the fallback', () => {
    // save() takes an absolute dataset, so unlike update() it has no way to
    // re-base one against a recovered file. The latch stays armed until
    // something re-reads, so a direct save of the stale fallback is refused
    // rather than quietly overwriting the user's repair.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    const stale = store.get();
    // The user repairs the file by hand after the app started.
    seed(dir, full());
    store.save(stale);
    const after = new DataStore(dir, logger).load();
    expect(Object.keys(after.tasks)).toEqual(['t1']);
    expect(Object.keys(after.ideas)).toEqual(['i1']);
  });

  test('a genuinely unreadable data.json is never overwritten by a fallback load', () => {
    // The destruction chain: a strict parse fails, the cache is a fallback,
    // and the first ordinary write replaces the only good copy.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } }));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'again' } }));
    // Both files still hold exactly what the user left there.
    expect(readFileSync(join(dir, 'data.json'), 'utf8')).toBe('{ not json');
    expect(existsSync(join(dir, 'data.backup.json'))).toBe(false);
  });

  test('a readable data.json still saves normally', () => {
    const dir = tmpDir();
    seed(dir, full());
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } }));
    expect(new DataStore(dir, logger).load().settings.userName).toBe('me');
  });
});

describe('DataStore — a write must be able to report that it did not happen', () => {
  test('update reports persisted:false when the store refuses', () => {
    // The refusal used to be invisible to the caller: update() handed back the
    // degraded fallback and every write-path reported success for a change
    // that was in memory only. stopTiming returned ok:true on this path, so
    // the user saw their hours recorded and lost them on restart.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    const result = store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } }));
    expect(result.persisted).toBe(false);
    // And the dataset it hands back is the fallback, not the requested change —
    // which is exactly why callers must not read it as "what I just wrote".
    expect(result.data.settings.userName).toBe('');
  });

  test('update reports persisted:true on a normal write', () => {
    const dir = tmpDir();
    const store = new DataStore(dir, logger);
    store.load();
    expect(
      store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } })).persisted,
    ).toBe(true);
  });

  test('a mutation that changes nothing skips the write entirely', () => {
    // The renderer's 30s heartbeat re-sends the timer it already has. Each of
    // those writes cost a full schema validation, a backup copy and a
    // tmp+rename — ~120 an hour for a dataset that did not change.
    const dir = tmpDir();
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, tasks: { ...d.tasks, t1: { ...emptyTask(), id: 't1' } } }));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } }));
    const before = readFileSync(join(dir, 'data.json'), 'utf8');
    const backupBefore = readFileSync(join(dir, 'data.backup.json'), 'utf8');
    // Returning the same reference is how "nothing to write" is expressed.
    const result = store.update((d) => d);
    expect(result.persisted).toBe(true);
    expect(readFileSync(join(dir, 'data.json'), 'utf8')).toBe(before);
    // The backup is the tell: a rotation would have replaced it.
    expect(readFileSync(join(dir, 'data.backup.json'), 'utf8')).toBe(backupBefore);
  });
});

describe('DataStore — backup rotation', () => {
  /** Seeds two tasks and rotates, so the backup holds both. */
  const withTasks = (dir: string) => {
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({
      ...d,
      tasks: { ...d.tasks, t1: { ...emptyTask(), id: 't1' }, t2: { ...emptyTask(), id: 't2' } },
    }));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'rotate' } }));
    return store;
  };

  test('a poorer dataset does not replace a richer backup', () => {
    // The guard has to be a generation rule, not a one-write reprieve. The
    // first attempt at this only checked "is the outgoing dataset empty", which
    // bought exactly one write: the user cleared their tasks, the backup was
    // spared, and then the first new task rotated the emptiness over that
    // backup anyway — losing both generations, which is the outcome the guard
    // claims to prevent.
    const dir = tmpDir();
    const store = withTasks(dir);
    store.update((d) => ({ ...d, tasks: {} }));
    expect(new DataStore(dir, logger).load().tasks).toEqual({});
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).tasks),
    ).toEqual(['t1', 't2']);

    // Rebuilding to fewer records than the backup holds must not demote it.
    store.update((d) => ({ ...d, tasks: { ...d.tasks, t3: { ...emptyTask(), id: 't3' } } }));
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).tasks),
    ).toEqual(['t1', 't2']);
    expect(Object.keys(new DataStore(dir, logger).load().tasks)).toEqual(['t3']);
  });

  test('rotation resumes once the dataset on disk is itself as rich as the backup', () => {
    // The other half of the property: without it the guard would freeze the
    // backup forever, which was the objection that killed the original.
    // Rotation promotes the file currently on disk, so the dataset has to reach
    // the backup's size *and then be written once more* before it can be
    // promoted in turn.
    const dir = tmpDir();
    const store = withTasks(dir);
    store.update((d) => ({ ...d, tasks: {} }));
    store.update((d) => ({
      ...d,
      tasks: { ...d.tasks, t3: { ...emptyTask(), id: 't3' }, t4: { ...emptyTask(), id: 't4' } },
    }));
    // Still blocked: what is on disk is the empty dataset.
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).tasks),
    ).toEqual(['t1', 't2']);

    // One more write, with the on-disk dataset now holding two records.
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'again' } }));
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).tasks),
    ).toEqual(['t3', 't4']);
  });

  test('an emptied library with no readable backup still rotates', () => {
    // Nothing is lost by rotating here, and refusing to would strand a stale
    // backup as the only recovery point forever.
    const dir = tmpDir();
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'first' } }));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'second' } }));
    unlinkSync(join(dir, 'data.backup.json'));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'third' } }));
    expect(existsSync(join(dir, 'data.backup.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).settings.userName).toBe(
      'second',
    );
  });

  test('a rotation refreshes what the guard believes about the backup', () => {
    // The guard's answer is cached, and a stale cache would decide against the
    // previous generation. Sequence: the backup holds one task, the dataset is
    // emptied (rotation suppressed), then rebuilt large enough to rotate — and
    // the rotation leaves an empty backup that the *next* empty write must be
    // measured against, not the old one-task figure.
    const dir = tmpDir();
    const store = withTasks(dir);
    store.update((d) => ({ ...d, tasks: {} }));
    store.update((d) => ({
      ...d,
      tasks: { ...d.tasks, t3: { ...emptyTask(), id: 't3' }, t4: { ...emptyTask(), id: 't4' } },
    }));
    // The rotation above left a two-record backup on disk. A write that shrinks
    // to one record must now be measured against *that*. A cache still holding
    // the pre-rotation figure (2 as well, coincidentally) would allow it; the
    // discriminating case is the next step, where the refreshed figure (2) must
    // block a one-record write that a stale "0" would have allowed.
    store.update((d) => ({ ...d, tasks: { t9: { ...emptyTask(), id: 't9' } } }));
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).tasks),
    ).toEqual(['t3', 't4']);
  });

  test('the guard measures the dataset the backup will hold, not the one replacing it', () => {
    // rotateBackup copies data.json, so the dataset that becomes the backup is
    // the one *currently on disk*. Comparing the incoming dataset instead let
    // an import pass the check — 200 tasks beats a 10-task backup — and then
    // demote the 2-task file that was actually on disk over that backup. The
    // generation the guard exists to protect, gone.
    const dir = tmpDir();
    const store = new DataStore(dir, logger);
    store.load();
    const many = (prefix: string, n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `${prefix}${i}`,
          { ...emptyTask(), id: `${prefix}${i}` },
        ]),
      );
    store.update((d) => ({ ...d, tasks: many('t', 10) }));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'rotate' } }));
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).tasks),
    ).toHaveLength(10);

    // Shrink to 2: blocked, backup keeps 10.
    store.update((d) => ({ ...d, tasks: many('s', 2) }));
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).tasks),
    ).toHaveLength(10);

    // Import 200. The incoming dataset dwarfs the backup and passes the check —
    // but the file being rotated is the 2-task one, which is far poorer.
    store.update((d) => ({ ...d, tasks: many('i', 200) }));
    const backup = JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8'));
    expect(Object.keys(backup.tasks)).toHaveLength(10);
    expect(new DataStore(dir, logger).load().tasks.i0).toBeDefined();
  });

  test('a rotation updates the cached count instead of discarding it', () => {
    // Nulling the cache on every rotation meant the common path filled and
    // cleared it on the same save, so the cache only ever helped when rotation
    // was suppressed — the case it was not written for.
    const dir = tmpDir();
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({
      ...d,
      tasks: { t1: { ...emptyTask(), id: 't1' }, t2: { ...emptyTask(), id: 't2' } },
    }));
    store.update((d) => ({ ...d, tasks: { t1: { ...emptyTask(), id: 't1' } } }));
    const cache = (store as unknown as { cachedBackupRecords: number | null }).cachedBackupRecords;
    expect(cache).toBe(2);
  });

  test('the backup is rotated through a temp file, never in place', () => {
    // copyFileSync straight into data.backup.json had the asymmetry PR #7's
    // review flagged: the primary write is tmp+rename, so a crash cannot
    // truncate it, while a crash during the copy left a half-written backup —
    // turning one damaged file into two.
    const dir = tmpDir();
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'first' } }));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'second' } }));
    expect(existsSync(join(dir, 'data.backup.json.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'data.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).settings.userName).toBe(
      'first',
    );
  });
});

describe('DataStore — a recovery must leave a record of what it discarded', () => {
  test('a re-read that quarantined records reports them', () => {
    // tryRecover passed an empty callback into readValidated, so a re-read
    // that succeeded *only* after dropping records logged a plain "recovered"
    // — telling the operator nothing had been lost.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    const lines: Record<string, unknown>[] = [];
    const loud = {
      info: (o: Record<string, unknown>) => lines.push(o),
      warn: (o: Record<string, unknown>) => lines.push(o),
      error: (o: Record<string, unknown>) => lines.push(o),
    } as unknown as Logger;
    const s2 = new DataStore(dir, loud);
    s2.load();
    lines.length = 0;
    // The user repairs the file, but one idea in it is still unparseable.
    const repaired = {
      ...emptyAppData(),
      tasks: { t1: { ...emptyTask(), id: 't1' } },
      ideas: { i2: { id: 'i2', title: 'x', notes: '', createdAt: 1, status: 'archived' } },
    };
    writeFileSync(join(dir, 'data.json'), JSON.stringify(repaired), 'utf8');
    s2.update((d) => ({ ...d, settings: { ...d.settings, userName: 'fixed' } }));
    const recovered = lines.find((l) => l.action === 'dataStore:save:recovered');
    expect(recovered).toBeDefined();
    expect(JSON.stringify(recovered?.quarantined)).toContain('quarantined idea i2');
  });

  test('the file-removed log names the backup state', () => {
    // `previousReason` describes the *deleted* file, so it says nothing about
    // the backup — and `adopted: 'empty'` cannot tell "no backup existed" from
    // "the backup was there and unreadable". Those are different incidents for
    // whoever restores by hand.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const lines: Record<string, unknown>[] = [];
    const loud = {
      info: () => {},
      warn: (o: Record<string, unknown>) => lines.push(o),
      error: () => {},
    } as unknown as Logger;
    const store = new DataStore(dir, loud);
    store.load();
    unlinkSync(join(dir, 'data.json'));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'x' } }));
    const removed = lines.find((l) => l.action === 'dataStore:save:file-removed');
    expect(removed?.adopted).toBe('empty');
    expect(removed?.backupState).toBe('missing');
  });

  test('a listener runs before the write that triggered recovery', () => {
    // main.ts defers the startup migrations through this hook. A listener that
    // migrated the recovered dataset and was then overwritten by update()'s own
    // save meant the feature did nothing on the first recovery — the only case
    // it exists for. This asserts the write that recovered the store is what
    // lands, with the listener's contribution already in it.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    const seen: string[] = [];
    store.onRecovered(() => {
      seen.push(store.get().settings.userName);
      // Stand in for the migration: mutate the recovered dataset in place.
      store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'migrated' } }));
    });
    writeFileSync(join(dir, 'data.json'), JSON.stringify(emptyAppData()), 'utf8');
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'user-write' } }));

    expect(seen).toEqual(['']);
    // The user's write is what survives — the listener ran before it, not
    // after, and not in a state the save then clobbered.
    expect(new DataStore(dir, logger).load().settings.userName).toBe('user-write');
  });

  test('the recovery write is applied on top of what the listener left', () => {
    // The listener's job is to migrate the recovered base; the pending user
    // write must then apply to that migrated dataset rather than to the
    // pre-migration object update() originally re-read.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    store.onRecovered(() => {
      store.update((d) => ({ ...d, misc: { ...d.misc, migrated: true } }));
    });
    writeFileSync(
      join(dir, 'data.json'),
      JSON.stringify({ ...emptyAppData(), tasks: { t1: { ...emptyTask(), id: 't1' } } }),
      'utf8',
    );
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'after' } }));

    const after = new DataStore(dir, logger).load();
    expect(after.misc.migrated).toBe(true);
    expect(after.settings.userName).toBe('after');
    expect(Object.keys(after.tasks)).toEqual(['t1']);
  });

  test('a recovery that cannot be written notifies nobody', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    let fired = 0;
    store.onRecovered(() => {
      fired += 1;
    });
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'x' } }));
    expect(fired).toBe(0);
  });
});
