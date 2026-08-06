import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyAppData } from '@tiny-schedule/shared';
import { DataStore } from '../src/main/dataStore';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'tsdata-'));
}

describe('DataStore', () => {
  test('load returns empty data when no file exists', () => {
    const store = new DataStore(tmpDir());
    const d = store.load();
    expect(d.version).toBe(1);
    expect(Object.keys(d.tasks)).toHaveLength(0);
  });

  test('save persists to data.json and reload reads it back', () => {
    const dir = tmpDir();
    const store = new DataStore(dir);
    store.load();
    const d = store.update((cur) => ({
      ...cur,
      tasks: { ...cur.tasks, t1: { ...emptyTask(), id: 't1' } },
    }));
    expect(d.tasks.t1?.id).toBe('t1');
    const reloaded = new DataStore(dir).load();
    expect(reloaded.tasks.t1?.id).toBe('t1');
    // no temp files left behind
    const raw = readFileSync(join(dir, 'data.json'), 'utf8');
    expect(JSON.parse(raw).version).toBe(1);
  });

  test('save keeps previous file as data.backup.json', () => {
    const dir = tmpDir();
    const s1 = new DataStore(dir);
    s1.load();
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'first' } }));
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'second' } }));
    const backup = JSON.parse(readFileSync(join(dir, 'data.backup.json'), 'utf8'));
    expect(backup.settings.userName).toBe('first');
    expect(new DataStore(dir).load().settings.userName).toBe('second');
  });

  test('corrupt data.json falls back to backup', () => {
    const dir = tmpDir();
    const s1 = new DataStore(dir);
    s1.load();
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'good' } }));
    s1.update((cur) => ({ ...cur, settings: { ...cur.settings, userName: 'newer' } }));
    writeFileSync(join(dir, 'data.json'), '{{{ not json');
    const d = new DataStore(dir).load();
    expect(d.settings.userName).toBe('good');
  });

  test('corrupt data.json and no backup returns empty data', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), '{{{ not json');
    const d = new DataStore(dir).load();
    expect(d).toEqual(emptyAppData());
  });

  test('invalid schema falls back to empty data', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'data.json'), JSON.stringify({ version: 99 }));
    const d = new DataStore(dir).load();
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
