import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyAppData } from '@tiny-schedule/shared';
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
    const d = store.update((cur) => ({
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
