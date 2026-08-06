import { describe, expect, test } from 'bun:test';
import { emptyAppData, localDate, SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { migrateRemoveTodayTag } from '../src/main/migrations';

describe('migrateRemoveTodayTag', () => {
  test('strips TODAY tag and backfills dueDay when missing', () => {
    const d = emptyAppData();
    d.tags[SYSTEM_TAG_IDS.today] = { id: SYSTEM_TAG_IDS.today, title: 'Today' };
    d.tasks.t1 = {
      id: 't1',
      title: 'T',
      projectId: 'INBOX_PROJECT',
      tagIds: [SYSTEM_TAG_IDS.today, 'custom1'],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 0,
    };
    const next = migrateRemoveTodayTag(d);
    expect(next.tasks.t1?.tagIds).toEqual(['custom1']);
    expect(next.tasks.t1?.dueDay).toBe(localDate(Date.now()));
    expect(next.tags[SYSTEM_TAG_IDS.today]).toBeUndefined();
  });

  test('keeps existing dueDay when present', () => {
    const d = emptyAppData();
    d.tasks.t1 = {
      id: 't1',
      title: 'T',
      projectId: 'INBOX_PROJECT',
      tagIds: [SYSTEM_TAG_IDS.today],
      subTaskIds: [],
      isDone: false,
      dueDay: '2026-01-02',
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 0,
    };
    const next = migrateRemoveTodayTag(d);
    expect(next.tasks.t1?.dueDay).toBe('2026-01-02');
  });

  test('returns same reference when nothing to migrate', () => {
    const d = emptyAppData();
    expect(migrateRemoveTodayTag(d)).toBe(d);
  });

  test('removes tag entity even without affected tasks', () => {
    const d = emptyAppData();
    d.tags[SYSTEM_TAG_IDS.today] = { id: SYSTEM_TAG_IDS.today, title: 'Today' };
    const next = migrateRemoveTodayTag(d);
    expect(next.tags[SYSTEM_TAG_IDS.today]).toBeUndefined();
  });
});
