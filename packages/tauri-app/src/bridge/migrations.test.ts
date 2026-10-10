import { describe, expect, test } from 'bun:test';
import { emptyAppData, SYSTEM_TAG_IDS, type Task } from '@tiny-schedule/shared';
import { migrateImportanceTagsToField, migrateRemoveTodayTag } from './migrations';

function legacyTask(patch: Partial<Task> & { id: string }): Task {
  return {
    title: patch.id,
    projectId: 'INBOX_PROJECT',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    isImportant: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
    ...patch,
  };
}

function legacyData() {
  const base = emptyAppData();
  base.tags = {
    [SYSTEM_TAG_IDS.important]: { id: SYSTEM_TAG_IDS.important, title: 'Important' },
    [SYSTEM_TAG_IDS.urgent]: { id: SYSTEM_TAG_IDS.urgent, title: 'Urgent' },
  };
  base.tasks = {
    t1: legacyTask({
      id: 't1',
      tagIds: [SYSTEM_TAG_IDS.important, SYSTEM_TAG_IDS.urgent, 'USER'],
      tagSnapshots: { [SYSTEM_TAG_IDS.urgent]: { title: 'Urgent' }, USER: { title: '工作' } },
    }),
    t2: legacyTask({ id: 't2', tagIds: [SYSTEM_TAG_IDS.urgent], isImportant: true }),
    t3: legacyTask({ id: 't3', tagIds: ['USER'] }),
  };
  return base;
}

describe('migrateImportanceTagsToField', () => {
  test('folds EM_IMPORTANT into isImportant and drops both tags', () => {
    const d = legacyData();
    const out = migrateImportanceTagsToField(d);

    expect(out.tasks.t1?.isImportant).toBe(true);
    expect(out.tasks.t1?.tagIds).toEqual(['USER']);
    // The urgent tag is not a field, so its snapshot label goes too.
    expect(out.tasks.t1?.tagSnapshots).toEqual({ USER: { title: '工作' } });

    expect(out.tasks.t2?.isImportant).toBe(true);
    expect(out.tasks.t2?.tagIds).toEqual([]);

    expect(out.tasks.t3?.isImportant).toBe(false);
    expect(out.tasks.t3?.tagIds).toEqual(['USER']);

    expect(out.tags[SYSTEM_TAG_IDS.important]).toBeUndefined();
    expect(out.tags[SYSTEM_TAG_IDS.urgent]).toBeUndefined();
    expect(Object.keys(out.tags)).toEqual([]);
  });

  test('never clears an isImportant that was already set', () => {
    const out = migrateImportanceTagsToField(legacyData());
    expect(out.tasks.t2?.isImportant).toBe(true);
  });

  test('returns the same reference when nothing carries the tags', () => {
    const d = emptyAppData();
    expect(migrateImportanceTagsToField(d)).toBe(d);
  });

  test('runs after the TODAY migration without undoing it', () => {
    const d = legacyData();
    d.tasks.t3 = legacyTask({ id: 't3', tagIds: [SYSTEM_TAG_IDS.today] });
    const out = migrateImportanceTagsToField(migrateRemoveTodayTag(d));
    expect(out.tasks.t3?.tagIds).toEqual([]);
    expect(out.tasks.t3?.dueDay).toBeDefined();
    expect(out.tags[SYSTEM_TAG_IDS.today]).toBeUndefined();
  });
});
