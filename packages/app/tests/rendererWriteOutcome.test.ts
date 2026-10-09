import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AppData, WriteOutcome } from '@tiny-schedule/shared';

/**
 * ADR-0004's two rules, at the one place they live.
 *
 * Both were previously re-implemented per write path, and the failure mode is
 * silent by construction: a path that forgets to check `persisted` type-checks,
 * passes every test, and shows the user a save that never happened. So the
 * rules need a test here, not at the call sites that could stop doing it.
 */

const toasts: string[] = [];
mock.module('sonner', () => ({
  toast: { error: (m: string) => toasts.push(m), success: () => {} },
}));

/** Every write channel the store calls, and how each should be answered. */
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
          if (typeof r === 'function') return (r as (...a: unknown[]) => unknown)();
          if (r === undefined) throw new Error(`no stubbed response for ${channel}`);
          return r;
        },
    }),
}));

const { useDataStore } = await import('../src/renderer/src/stores/data');
const { emptyAppData, INBOX_PROJECT_ID } = await import('@tiny-schedule/shared');

function datasetWithATask(): AppData {
  const base = emptyAppData();
  return {
    ...base,
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
  useDataStore.setState({ data: datasetWithATask(), loading: false });
});

describe('a refused write is reported, not adopted (ADR-0004)', () => {
  test('the degraded dataset does not replace what is on screen', async () => {
    // The destructive half of the bug. data.json unreadable with no readable
    // backup means the main process is holding emptyAppData(); adopting it
    // makes every task, idea and follow-up vanish from the app, and the toast
    // says "save failed" — which does not lead anyone to "your library is
    // gone from the screen".
    responses.set('taskDelete', { data: emptyAppData(), persisted: false });
    await useDataStore.getState().deleteTask('t1');
    expect(Object.keys(useDataStore.getState().data?.tasks ?? {})).toEqual(['t1']);
    expect(toasts).toHaveLength(1);
  });

  test('a successful write is adopted and silent', async () => {
    const next = { ...emptyAppData() };
    responses.set('taskDelete', { data: next, persisted: true });
    await useDataStore.getState().deleteTask('t1');
    expect(useDataStore.getState().data).toEqual(next);
    expect(toasts).toHaveLength(0);
  });

  test('every write channel reports a refusal exactly once', async () => {
    // The convergence property: adding a channel cannot produce a path that
    // forgets, because there is nothing to forget — they all route through
    // the same adoption step.
    const channels: [string, () => Promise<unknown>][] = [
      ['taskDelete', () => useDataStore.getState().deleteTask('t1')],
      ['taskUpsert', () => useDataStore.getState().upsertTask(datasetWithATask().tasks.t1!)],
      ['followUpDelete', () => useDataStore.getState().deleteFollowUp('f1')],
      ['ideaDelete', () => useDataStore.getState().deleteIdea('i1')],
      ['projectDelete', () => useDataStore.getState().deleteProject('p1')],
      ['tagDelete', () => useDataStore.getState().deleteTag('g1')],
    ];
    for (const [channel, run] of channels) {
      toasts.length = 0;
      calls.length = 0;
      responses.set(channel, { data: emptyAppData(), persisted: false } as WriteOutcome);
      await run();
      expect(calls).toEqual([channel]);
      expect(toasts).toHaveLength(1);
    }
  });

  test('the task is still on screen after any of them refuses', async () => {
    responses.set('projectDelete', { data: emptyAppData(), persisted: false });
    await useDataStore.getState().deleteProject('p1');
    expect(Object.keys(useDataStore.getState().data?.tasks ?? {})).toEqual(['t1']);
  });

  test('an intent command refuses the same way', async () => {
    // adoptCommand is a separate entry point, so it needs its own cover: the
    // idea/follow-up commands carry taskId/projectId alongside the dataset and
    // are the ones most likely to grow a third path.
    responses.set('ideaComplete', { ok: false, error: 'IDEA_NOT_IN_OPEN' });
    const r = await useDataStore.getState().completeIdea('i1');
    expect(r.ok).toBe(false);
    expect(Object.keys(useDataStore.getState().data?.tasks ?? {})).toEqual(['t1']);
    expect(toasts).toHaveLength(0);
  });
});
