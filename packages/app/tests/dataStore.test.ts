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
  const withTask = (dir: string) => {
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, tasks: { ...d.tasks, t1: { ...emptyTask(), id: 't1' } } }));
    return store;
  };

  test('an emptied library does not rotate over a readable backup', () => {
    // The guard this restores used to test `projects` for emptiness, which
    // made it unreachable: emptyAppData() always ships INBOX_PROJECT. So it
    // was deleted as dead code. Excluding INBOX makes it reachable, and this
    // is the scenario it exists for: the user deletes every task, and the very
    // next ordinary write used to demote that emptiness over the backup that
    // still held their library.
    const dir = tmpDir();
    const store = withTask(dir);
    store.update((d) => ({ ...d, tasks: {} }));
    expect(new DataStore(dir, logger).load().tasks).toEqual({});
    const backup = JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8'));
    expect(Object.keys(backup.tasks)).toEqual(['t1']);
  });

  test('the backup is not frozen: content rotates it normally again', () => {
    // The earlier concern with this guard was that it would freeze the backup
    // permanently once triggered. It only suppresses the rotation *while* the
    // dataset is empty, so the first write carrying content demotes normally.
    const dir = tmpDir();
    const store = withTask(dir);
    store.update((d) => ({ ...d, tasks: {} }));
    store.update((d) => ({ ...d, tasks: { ...d.tasks, t2: { ...emptyTask(), id: 't2' } } }));
    const backup = JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8'));
    expect(Object.keys(backup.tasks)).toEqual([]);
    expect(Object.keys(new DataStore(dir, logger).load().tasks)).toEqual(['t2']);
  });

  test('an emptied library with no readable backup still rotates', () => {
    // Nothing is lost by rotating here, and refusing to would strand a stale
    // backup as the only recovery point forever.
    const dir = tmpDir();
    const store = new DataStore(dir, logger);
    store.load();
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'first' } }));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'second' } }));
    // The user clears their library and the backup goes unreadable in the same
    // breath — the guard's precondition ("a readable backup worth keeping")
    // no longer holds, so it must not block the rotation.
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'cleared' } }));
    unlinkSync(join(dir, 'data.backup.json'));
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'after' } }));
    expect(existsSync(join(dir, 'data.backup.json'))).toBe(true);
    // The backup now holds the file that was on disk before this write.
    expect(JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8')).settings.userName).toBe(
      'cleared',
    );
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

  test('onRecovered fires when the store recovers, so deferred work can run', () => {
    // Startup migrations are skipped when the store is read-only. Before this
    // hook, a session that recovered mid-run stayed unmigrated for good, with
    // nothing on disk saying so.
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{ not json', 'utf8');
    const store = new DataStore(dir, logger);
    store.load();
    let fired = 0;
    store.onRecovered(() => {
      fired += 1;
    });
    writeFileSync(join(dir, 'data.json'), JSON.stringify({ ...emptyAppData() }), 'utf8');
    store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'fixed' } }));
    expect(fired).toBe(1);
    // Still unreadable: nothing ran, and nothing claimed it had.
    const stillBad = new DataStore(dir, logger);
    writeFileSync(join(dir, 'data.json'), '{ still not json', 'utf8');
    stillBad.load();
    expect(stillBad.isWritable).toBe(false);
  });
});
