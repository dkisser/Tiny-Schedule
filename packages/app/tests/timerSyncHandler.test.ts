import { describe, expect, test } from 'bun:test';
import {
  type ActiveTimer,
  type AppData,
  DROPPED_TIMER,
  emptyAppData,
  Ipc,
  REFUSED_TIMER,
} from '@tiny-schedule/shared';
import type { BrowserWindow } from 'electron';
import type { Logger } from 'pino';
import type { HandlerDeps } from '../src/main/handlers/deps';
import { taskHandlers } from '../src/main/handlers/task';

/**
 * timerSync's announcement: what the renderer's TimerBar is told, and how many
 * times.
 *
 * Both of the defects issue #20 names lived here. The two branches fired
 * independently, so a refused sync on a stale timer sent `timerChanged(null)`
 * twice; and both payloads were `null`, so the renderer could not tell the two
 * apart even once. The second one is now the protocol's job (TimerChangedPayload
 * is a discriminated union), which makes this handler the place where "refusal
 * first, then drop, never both" is enforced.
 */

const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

function timerAt(): ActiveTimer {
  return { taskId: 't1', startedAt: 1_000, accumulatedMs: 0, isPaused: false };
}

/** A taskService whose syncTimer answers exactly the outcome under test. */
function handlersFor(outcome: { dropped: boolean; persisted: boolean }) {
  const sent: [string, unknown][] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (ch: string, payload: unknown) => sent.push([ch, payload]) },
  } as unknown as BrowserWindow;
  const tasks = {
    syncTimer: () => ({
      data: emptyAppData() as AppData,
      dropped: outcome.dropped,
      persisted: outcome.persisted,
    }),
  };
  const deps = {
    logger,
    getWindow: () => win,
    tasks,
  } as unknown as HandlerDeps;
  return { handlers: taskHandlers(deps), sent };
}

const droppedOutcome = { dropped: true, persisted: true };
const refusedOutcome = { dropped: false, persisted: false };

describe('timerSync announces exactly one thing', () => {
  test('a drop clears the renderer clock, once', () => {
    const { handlers, sent } = handlersFor(droppedOutcome);
    handlers.timerSync({ timer: timerAt() });
    expect(sent).toEqual([[Ipc.timerChanged, DROPPED_TIMER]]);
  });

  test('a refused write is announced as refused, once', () => {
    // No `timer` in the payload on purpose: main's cache still holds the very
    // session the renderer is counting, so clearing the TimerBar here would
    // stop a clock that never stopped.
    const { handlers, sent } = handlersFor(refusedOutcome);
    handlers.timerSync({ timer: timerAt() });
    expect(sent).toEqual([[Ipc.timerChanged, REFUSED_TIMER]]);
  });

  test('a refused write on a stale timer is refused once, not a drop and not twice', () => {
    // `dropped` is computed off the dataset a refused write hands back, which
    // for an unwritable store is a degraded fallback that may carry no timer.
    // So dropped:true + persisted:false is reachable, and it means "nothing
    // happened" — not "the timer was discarded". The old handler sent
    // timerChanged(null) twice here: once for a drop that did not occur, and
    // once for a refusal the renderer could not identify.
    const { handlers, sent } = handlersFor({ dropped: true, persisted: false });
    handlers.timerSync({ timer: timerAt() });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([Ipc.timerChanged, REFUSED_TIMER]);
  });

  test('a plain heartbeat says nothing at all', () => {
    // Silence is the success path: the renderer already holds this timer, and
    // announcing it back would be a no-op with a payload to keep in step.
    const { handlers, sent } = handlersFor({ dropped: false, persisted: true });
    handlers.timerSync({ timer: timerAt() });
    expect(sent).toEqual([]);
  });

  test('the two outcomes are never the same wire value', () => {
    const drop = handlersFor(droppedOutcome);
    drop.handlers.timerSync({ timer: timerAt() });
    const refused = handlersFor(refusedOutcome);
    refused.handlers.timerSync({ timer: timerAt() });
    expect(drop.sent[0]?.[1]).not.toEqual(refused.sent[0]?.[1]);
  });
});
