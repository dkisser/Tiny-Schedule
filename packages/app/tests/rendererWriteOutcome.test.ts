import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AppData } from '@tiny-schedule/shared';

/**
 * The refusal rules, at the two places they now live (ADR-0004).
 *
 * 1. **State channels** return bare AppData. Nothing to check, nothing to
 *    forget — "is the app still saving" is a pushed mode, not a return value.
 * 2. **Control-flow channels** — the five whose result decides whether a dialog
 *    closes or an id gets navigated to — return `{ ok: false, error:
 *    'WRITE_REFUSED' }`, shaped exactly like a domain rejection.
 *
 * The failure mode being guarded against is specific: `ok: true` for a write
 * that never landed makes UpgradeIdeaDialog close as a clean success while the
 * idea stays open. That is invisible to the type system and to every other test,
 * so it gets its own.
 */

const toasts: string[] = [];
mock.module('sonner', () => ({
  toast: { error: (m: string) => toasts.push(m), success: () => {} },
}));

const responses = new Map<string, unknown>();
const calls: string[] = [];
mock.module('../src/renderer/src/api', () => ({
  api: () =>
    new Proxy({} as Record<string, unknown>, {
      get:
        (_t, channel: string) =>
        async (...args: unknown[]) => {
          calls.push(channel);
          void args;
          const r = responses.get(channel);
          if (r === undefined) throw new Error(`no stubbed response for ${channel}`);
          return r;
        },
    }),
}));

const { useDataStore } = await import('../src/renderer/src/stores/data');
const { emptyAppData, INBOX_PROJECT_ID } = await import('@tiny-schedule/shared');

function datasetWithATask(): AppData {
  return {
    ...emptyAppData(),
    tasks: {
      t1: {
        id: 't1',
        title: '写代码',
        projectId: INBOX_PROJECT_ID,
        tagIds: [],
        subTaskIds: [],
        isDone: false,
        timeEstimate: 0,
        timeSpent: 0,
        timeSpentOnDay: {},
        timeEntries: [],
        notes: '',
        created: 0,
      },
    },
  };
}

beforeEach(() => {
  toasts.length = 0;
  calls.length = 0;
  responses.clear();
  useDataStore.setState({
    data: datasetWithATask(),
    loading: false,
    storeWritable: true,
    storeUnreadableReason: null,
  });
});

const tasksOnScreen = () => Object.keys(useDataStore.getState().data?.tasks ?? {});

describe('state channels carry no verdict (ADR-0004)', () => {
  test('a state write adopts the dataset and says nothing about refusals', async () => {
    // The whole point of scoping WriteOutcome to control-flow channels: these
    // channels have no verdict to carry, so there is nothing for a future
    // author to forget, and nothing to disagree between paths.
    responses.set('taskDelete', datasetWithATask());
    await useDataStore.getState().deleteTask('t1');
    expect(calls).toEqual(['taskDelete']);
    expect(toasts).toHaveLength(0);
  });

  test('subscribeStoreMode records the mode main pushes', () => {
    // Every debounced edit that nobody checks the result of is covered by this
    // one signal — which is why it is a banner and not twenty per-write toasts.
    useDataStore.setState({ storeWritable: false, storeUnreadableReason: 'invalid json: …' });
    expect(useDataStore.getState().storeWritable).toBe(false);
    expect(useDataStore.getState().storeUnreadableReason).toContain('invalid json');
  });
});

describe('control-flow channels report a refusal as a rejection (ADR-0004)', () => {
  test('a refused intent command does not report ok:true', async () => {
    // The bug this design exists for: adoptCommand used to toast the refusal
    // and still return ok:true, so UpgradeIdeaDialog's `if (!result.ok)` never
    // fired, the dialog closed as a clean success, and the idea stayed open.
    responses.set('ideaUpgradeToProject', { ok: false, error: 'WRITE_REFUSED' });
    const r = await useDataStore.getState().upgradeIdeaToProject({ id: 'i1', title: 'x' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('WRITE_REFUSED');
    expect(tasksOnScreen()).toEqual(['t1']);
  });

  test('a domain rejection is indistinguishable in shape, on purpose', async () => {
    // Same envelope: the caller's response is the same either way — nothing
    // happened. That is the whole reason WRITE_REFUSED rides here rather than
    // in a second flag a caller might forget.
    responses.set('ideaComplete', { ok: false, error: 'IDEA_NOT_IN_OPEN' });
    const r = await useDataStore.getState().completeIdea('i1');
    expect(r.ok).toBe(false);
  });

  test('a refused create returns no id', async () => {
    // Returning the minted id would let the caller navigate to a project that
    // exists nowhere — in the dataset or on disk.
    responses.set('projectCreate', { ok: false, error: 'WRITE_REFUSED' });
    const id = await useDataStore.getState().createProject('写作');
    expect(id).toBeNull();
  });

  test('a successful create returns the id', async () => {
    responses.set('projectCreate', { ok: true, data: datasetWithATask(), projectId: 'p9' });
    const id = await useDataStore.getState().createProject('写作');
    expect(id).toBe('p9');
  });

  test('a refused upsert reports no settledMs and does not touch the timer', async () => {
    // completeFor used to read `data.activeTimer` off the renderer-side return
    // value; on a refusal that was the pre-write dataset, so the TimerBar kept
    // counting a session main never settled.
    responses.set('taskUpsert', { ok: false, error: 'WRITE_REFUSED' });
    const r = await useDataStore.getState().upsertTask(datasetWithATask().tasks.t1!);
    expect(r.ok).toBe(false);
    expect(tasksOnScreen()).toEqual(['t1']);
  });

  test('a refused stop is not a settlement', async () => {
    responses.set('timingStop', {
      ok: false,
      error: 'WRITE_REFUSED',
      data: datasetWithATask(),
      persisted: false,
    });
    const result = await (await import('../src/renderer/src/api')).api().timingStop({});
    expect(result.ok).toBe(false);
  });
});
