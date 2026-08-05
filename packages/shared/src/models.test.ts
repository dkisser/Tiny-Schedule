import { describe, expect, test } from 'bun:test';
import type { Task } from './models';
import { defaultSettings, emptyAppData, SYSTEM_TAG_IDS } from './models';

describe('emptyAppData', () => {
  test('has version 1 and empty collections', () => {
    const d = emptyAppData();
    expect(d.version).toBe(1);
    expect(d.tasks).toEqual({});
    expect(d.projects).toEqual({
      INBOX_PROJECT: { id: 'INBOX_PROJECT', title: 'Inbox', icon: 'inbox', isArchived: false },
    });
    expect(d.tags).toEqual({
      TODAY: { id: 'TODAY', title: 'Today' },
      EM_IMPORTANT: { id: 'EM_IMPORTANT', title: 'Important' },
      EM_URGENT: { id: 'EM_URGENT', title: 'Urgent' },
    });
    expect(d.activeTimer).toBeNull();
    expect(d.misc).toEqual({});
  });

  test('includes INBOX_PROJECT', () => {
    const d = emptyAppData();
    expect(d.projects.INBOX_PROJECT?.title).toBe('Inbox');
  });

  test('includes system tags', () => {
    const d = emptyAppData();
    expect(d.tags[SYSTEM_TAG_IDS.today]?.title).toBe('Today');
    expect(d.tags[SYSTEM_TAG_IDS.important]).toBeDefined();
    expect(d.tags[SYSTEM_TAG_IDS.urgent]).toBeDefined();
  });

  test('returns fresh objects each call', () => {
    const a = emptyAppData();
    const b = emptyAppData();
    a.tasks.mutated = { title: 'mutated' } as unknown as Task;
    expect(Object.keys(b.tasks)).toHaveLength(0);
    expect(Object.keys(a.tasks)).toHaveLength(1);
  });
});

describe('defaultSettings', () => {
  test('has sane defaults', () => {
    const s = defaultSettings();
    expect(s.userName).toBe('');
    expect(s.avatar).toBeNull();
    expect(s.theme).toBe('system');
    expect(s.aiProviders).toEqual([]);
    expect(s.aiPrompt).toBe('');
    expect(s.autoAiAnalyzeOnFinishDay).toBe(false);
  });
});
