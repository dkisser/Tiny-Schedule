import { describe, expect, mock, test } from 'bun:test';
import type { TimerChangedPayload } from '@tiny-schedule/shared';
import { type AppData, emptyAppData } from '@tiny-schedule/shared';

/**
 * The renderer's side of the timerChanged union: a refusal must not do what a
 * drop does.
 *
 * Under `ActiveTimer | null` these two events were the same `null`, so the store
 * could only ever clear the TimerBar — which is correct for a drop and wrong
 * for a refusal, where main's cache still holds the running session. The
 * contract's discriminated union is what makes the branch below expressible;
 * this test is what keeps it from collapsing back.
 */

const toasts: string[] = [];
mock.module('sonner', () => ({
  toast: {
    error: (m: string) => toasts.push(m),
    success: () => {},
  },
}));

const pushed: ((payload: TimerChangedPayload) => void)[] = [];
mock.module('../src/renderer/src/api', () => ({
  api: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, key: string | symbol) => {
        if (key === 'onTimerChanged') {
          return (cb: (payload: TimerChangedPayload) => void) => {
            pushed.push(cb);
            return () => {
              const i = pushed.indexOf(cb);
              if (i >= 0) pushed.splice(i, 1);
            };
          };
        }
        // Every other channel the timer store touches is a no-op here; the 30s
        // heartbeat and the restore-time sweep are not what these tests are about.
        return async () => undefined;
      },
    }),
}));

const { useDataStore } = await import('../src/renderer/src/stores/data');
const { useTimerStore } = await import('../src/renderer/src/stores/timer');

const runningTimer = {
  taskId: 't1',
  startedAt: 1_000,
  accumulatedMs: 0,
  isPaused: false,
};

/** Mount the store the way App does, with a timer already on the clock. */
async function mountWithRunningTimer(): Promise<(p: TimerChangedPayload) => void> {
  toasts.length = 0;
  pushed.length = 0;
  useDataStore.setState({ storeWritable: true, storeUnreadableReason: null });
  // The task has to exist: restore() runs the stale-timing sweep, and a timer
  // on a task that is not in the dataset is dropped on sight.
  const data: AppData = {
    ...emptyAppData(),
    tasks: {
      t1: {
        id: 't1',
        title: '还在跑的任务',
        notes: '',
        createdAt: 1,
        updatedAt: 1,
        isDone: false,
        order: 0,
        estimatedMinutes: null,
        dueDay: null,
        projectId: null,
        tags: [],
        focusTotalMs: 0,
        timeSpent: 0,
      } as unknown as AppData['tasks'][string],
    },
    activeTimer: runningTimer,
  };
  useTimerStore.getState().restore(data);
  const deliver = pushed[0];
  if (!deliver) throw new Error('the store never subscribed to timerChanged');
  return deliver;
}

describe('the renderer on a timerChanged payload', () => {
  test('a drop clears the TimerBar', async () => {
    const deliver = await mountWithRunningTimer();
    expect(useTimerStore.getState().timer).not.toBeNull();
    deliver({ kind: 'timer', timer: null });
    expect(useTimerStore.getState().timer).toBeNull();
  });

  test('a main-process auto-pause is adopted', async () => {
    const deliver = await mountWithRunningTimer();
    const paused = { ...runningTimer, isPaused: true, pausedAt: 5_000 };
    deliver({ kind: 'timer', timer: paused });
    expect(useTimerStore.getState().timer).toMatchObject({ isPaused: true });
  });

  test('a refusal leaves the TimerBar running and says the change was not saved', async () => {
    // The opposite action, on the same channel: nothing was written, main is
    // still counting the session it holds, so stopping the clock here would
    // throw away time that is still on record.
    const deliver = await mountWithRunningTimer();
    deliver({ kind: 'refused', reason: 'store-unwritable' });
    expect(useTimerStore.getState().timer).toMatchObject({ taskId: 't1', isPaused: false });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('未能保存');
  });

  test('the banner already says it, so the refusal does not toast again', async () => {
    // The 30s heartbeat re-syncs the same timer, so an unwritable store
    // refuses every 30 seconds for as long as the file is broken. ADR-0004
    // killed the per-write toast for exactly this; the banner is the standing
    // signal, and repeating it once a heartbeat would bury it.
    const deliver = await mountWithRunningTimer();
    useDataStore.setState({ storeWritable: false });
    deliver({ kind: 'refused', reason: 'store-unwritable' });
    deliver({ kind: 'refused', reason: 'store-unwritable' });
    expect(toasts).toEqual([]);
    // Still running, and still on record: the refusal never touched it.
    expect(useTimerStore.getState().timer).not.toBeNull();
  });
});
