import { describe, expect, test } from 'bun:test';
import { type AppData, emptyAppData, type FollowUp, INBOX_PROJECT_ID } from '@tiny-schedule/shared';
import type { DataStore } from '../src/main/infra/dataStore';
import { createFollowUpService } from '../src/main/services/followUpService';
import { createProjectService } from '../src/main/services/projectService';

const logger = { info: () => {}, error: () => {}, warn: () => {} } as never;

function followUp(over: Partial<FollowUp> = {}): FollowUp {
  return {
    id: 'f1',
    title: '等 ICP 审核',
    notes: '',
    entries: [],
    createdAt: 1,
    isResolved: false,
    ...over,
  };
}

function setup(data: Partial<AppData> = {}) {
  const state: AppData = { ...emptyAppData(), ...data };
  const store = {
    get: () => state,
    update: (fn: (c: AppData) => AppData) => {
      Object.assign(state, fn(state));
      return state;
    },
  } as unknown as DataStore;
  return { data: state, deps: { store, logger } };
}

describe('projectService — Inbox guards live here, not in the handler', () => {
  test('update refuses to touch the Inbox project', () => {
    const { data, deps } = setup();
    const s = createProjectService(deps);
    s.update({ id: INBOX_PROJECT_ID, title: '被篡改' });
    expect(data.projects[INBOX_PROJECT_ID]?.title).toBe('Inbox');
  });

  test('update refuses an unknown project instead of creating one', () => {
    const { data, deps } = setup();
    const s = createProjectService(deps);
    s.update({ id: 'nope', title: 'x' });
    expect(data.projects.nope).toBeUndefined();
  });

  test('update applies only the fields present in the patch', () => {
    const { deps } = setup();
    const s = createProjectService(deps);
    const { projectId } = s.create({ title: '写作' });
    s.update({ id: projectId, isArchived: true });
    const after = s.listMeta().projects.find((p) => p.id === projectId);
    expect(after).toEqual({ id: projectId, title: '写作', isArchived: true });
  });

  test('an explicit null clears the color; omitted leaves it intact', () => {
    const { data, deps } = setup();
    const s = createProjectService(deps);
    const { projectId } = s.create({ title: '写作', primaryColor: 'red' });
    // A patch that omits primaryColor must not disturb it.
    s.update({ id: projectId, isArchived: false });
    expect(data.projects[projectId]?.primaryColor).toBe('red');
    // An explicit null is a real value: it clears the color.
    s.update({ id: projectId, primaryColor: null });
    expect(data.projects[projectId]?.primaryColor).toBeNull();
  });

  test('remove moves the project’s tasks to Inbox and keeps their title snapshot', () => {
    const { data, deps } = setup();
    const s = createProjectService(deps);
    const { projectId } = s.create({ title: '写作' });
    data.tasks.t1 = {
      id: 't1',
      title: '写一篇',
      projectId,
      projectTitle: '写作',
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
    s.remove(projectId);
    expect(data.projects[projectId]).toBeUndefined();
    expect(data.tasks.t1?.projectId).toBe(INBOX_PROJECT_ID);
    expect(data.tasks.t1?.projectTitle).toBe('写作');
  });

  test('remove refuses to delete Inbox', () => {
    const { data, deps } = setup();
    const s = createProjectService(deps);
    s.remove(INBOX_PROJECT_ID);
    expect(data.projects[INBOX_PROJECT_ID]).toBeDefined();
  });

  test('setOrder stores per-view order in misc.taskOrder', () => {
    const { data, deps } = setup();
    const s = createProjectService(deps);
    s.setOrder('today', ['b', 'a']);
    s.setOrder('week', ['c']);
    expect((data.misc.taskOrder as Record<string, string[]>).today).toEqual(['b', 'a']);
    expect((data.misc.taskOrder as Record<string, string[]>).week).toEqual(['c']);
  });
});

describe('followUpService', () => {
  test('resolve stamps resolvedAt and clears the due state', () => {
    const { data, deps } = setup({
      followUps: { f1: followUp({ nextFollowUpDay: '2026-01-01' }) },
    });
    const s = createFollowUpService(deps);
    s.resolve('f1', 12345);
    expect(data.followUps.f1?.isResolved).toBe(true);
    expect(data.followUps.f1?.resolvedAt).toBe(12345);
  });

  test('reopen clears resolvedAt so the follow-up is due again', () => {
    const { data, deps } = setup({
      followUps: { f1: followUp({ isResolved: true, resolvedAt: 5 }) },
    });
    const s = createFollowUpService(deps);
    s.reopen('f1');
    expect(data.followUps.f1?.isResolved).toBe(false);
    expect(data.followUps.f1?.resolvedAt).toBeUndefined();
  });

  test('an unknown id is a rejection envelope, not a null', () => {
    // A bare null used to travel to the renderer, which adopts this value as
    // its entire dataset — so a follow-up deleted between render and click
    // blanked the app with no way to tell "gone" from "not loaded yet".
    const { deps } = setup();
    const s = createFollowUpService(deps);
    expect(s.resolve('nope')).toEqual({ ok: false, error: 'FOLLOW_UP_NOT_FOUND' });
    expect(s.reopen('nope')).toEqual({ ok: false, error: 'FOLLOW_UP_NOT_FOUND' });
  });

  test('upsert stays unconditional this phase (renderer switches in phase 3)', () => {
    const { data, deps } = setup();
    const s = createFollowUpService(deps);
    s.upsert(followUp({ id: 'f9', title: '新跟进' }));
    expect(data.followUps.f9?.title).toBe('新跟进');
  });
});
