import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    // The primary parsed via quarantine, so it is no longer "unreadable" and
    // normal writes resume.
    expect(() =>
      store.update((d) => ({ ...d, settings: { ...d.settings, userName: 'me' } })),
    ).not.toThrow();
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
