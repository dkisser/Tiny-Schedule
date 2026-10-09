import { describe, expect, mock, test } from 'bun:test';
import type { ActiveTimer, AppData } from '@tiny-schedule/shared';
import type { BrowserWindow } from 'electron';
import type { Logger } from 'pino';
import { electronMock } from './fixtures/electronMock';

// powerTimer imports powerMonitor at module load, so the module needs an
// electron to import. The shared mock supplies it; the two functions under
// test take their power source as a parameter, so nothing else here touches it.
mock.module('electron', () => electronMock);

import type { AutoPauseDeps, TimerPort } from '../src/main/infra/powerTimer';

const { applyAutoPause, checkIdle } = await import('../src/main/infra/powerTimer');

/**
 * powerTimer had no tests at all, even after PR #7 changed its dependency
 * shape (bare store → narrow TimerPort). The port is where the "no timer on a
 * done task" rule is supposed to live, so these tests assert the watcher goes
 * through the port and honours its `dropped` answer — not that it reaches into
 * some store directly.
 */

const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

function timerAt(): ActiveTimer {
  return { taskId: 't1', startedAt: 1_000, accumulatedMs: 0, isPaused: false };
}

/** A port that records what it was handed and reports the timer survived. */
function port(timer: ActiveTimer | null, dropped = false, persisted = true) {
  const synced: (ActiveTimer | null)[] = [];
  const timers: TimerPort = {
    current: () => timer,
    sync: (t) => {
      synced.push(t);
      return {
        data: { activeTimer: dropped ? null : t } as unknown as AppData,
        dropped,
        persisted,
      };
    },
  };
  return { timers, synced };
}

function deps(over: Partial<AutoPauseDeps> & { timers: TimerPort }): AutoPauseDeps {
  return { logger, getWindow: () => null, ...over };
}

function fakeWindow(): { win: BrowserWindow; sent: [string, unknown][] } {
  const sent: [string, unknown][] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (ch: string, payload: unknown) => sent.push([ch, payload]) },
  };
  return { win: win as unknown as BrowserWindow, sent };
}

describe('applyAutoPause', () => {
  test('pauses a running timer on sleep', () => {
    const { timers, synced } = port(timerAt());
    applyAutoPause(deps({ timers }), 'sleep', 0, 61_000);
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ taskId: 't1', isPaused: true, autoPausedBy: 'sleep' });
  });

  test('does nothing when there is no timer', () => {
    const { timers, synced } = port(null);
    applyAutoPause(deps({ timers }), 'sleep');
    expect(synced).toHaveLength(0);
  });

  test('leaves an already-paused timer alone', () => {
    // Pausing again would rewrite pausedAt and shift the elapsed time the user
    // already has banked for this session.
    const { timers, synced } = port({ ...timerAt(), isPaused: true });
    applyAutoPause(deps({ timers }), 'sleep');
    expect(synced).toHaveLength(0);
  });

  test('tells the renderer the clock is gone when the port drops the timer', async () => {
    // The port refuses timers on done tasks. Staying silent here leaves the
    // renderer's TimerBar counting a session main has already discarded.
    const { Ipc } = await import('@tiny-schedule/shared');
    const { timers } = port(timerAt(), true);
    const { win, sent } = fakeWindow();
    applyAutoPause(deps({ timers, getWindow: () => win }), 'sleep');
    expect(sent).toEqual([[Ipc.timerChanged, null]]);
  });

  test('announces the paused timer to the renderer when it survives', async () => {
    const { Ipc } = await import('@tiny-schedule/shared');
    const { timers } = port(timerAt());
    const { win, sent } = fakeWindow();
    applyAutoPause(deps({ timers, getWindow: () => win }), 'sleep');
    expect(sent).toEqual([[Ipc.timerChanged, expect.objectContaining({ isPaused: true })]]);
  });

  test('a refused auto-pause is announced as refused, not as a drop', async () => {
    // Reading `!next.activeTimer` alone would report a deliberate drop that
    // never happened, or — when the degraded fallback happens to carry a timer
    // — announce a pause that will not survive a restart. The renderer clears
    // its clock either way, so it has to be told the truth.
    const { Ipc } = await import('@tiny-schedule/shared');
    const { timers } = port(timerAt(), true, false);
    const { win, sent } = fakeWindow();
    applyAutoPause(deps({ timers, getWindow: () => win }), 'sleep');
    expect(sent).toEqual([[Ipc.timerChanged, null]]);
  });

  test('a refused auto-pause still syncs through the port', () => {
    const { timers, synced } = port(timerAt(), false, false);
    applyAutoPause(deps({ timers }), 'sleep');
    expect(synced).toHaveLength(1);
  });

  test('never sends to a destroyed window', () => {
    const { timers, synced } = port(timerAt());
    const win = { isDestroyed: () => true, webContents: { send: () => {} } };
    expect(() =>
      applyAutoPause(deps({ timers, getWindow: () => win as unknown as BrowserWindow }), 'sleep'),
    ).not.toThrow();
    expect(synced).toHaveLength(1);
  });
});

describe('checkIdle', () => {
  test('pauses and backdates by the measured idle time', () => {
    // The whole point of the poll: the pause point must land where the user
    // actually stopped typing, not at the moment the poll happened to fire.
    const { timers, synced } = port(timerAt());
    checkIdle(
      deps({ timers }),
      (ms) => ms >= 60_000,
      () => 90,
      200_000,
    );
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ isPaused: true, autoPausedBy: 'idle' });
    // Backdated 90s: the running segment ends 90s before the poll, not now.
    expect(synced[0]?.pausedAt).toBe(200_000 - 90_000);
  });

  test('does not pause below the configured threshold', () => {
    const { timers, synced } = port(timerAt());
    checkIdle(
      deps({ timers }),
      (ms) => ms >= 60_000,
      () => 5,
    );
    expect(synced).toHaveLength(0);
  });

  test('leaves an already-paused timer alone even when long idle', () => {
    const { timers, synced } = port({ ...timerAt(), isPaused: true });
    checkIdle(
      deps({ timers }),
      () => true,
      () => 600,
    );
    expect(synced).toHaveLength(0);
  });
});
