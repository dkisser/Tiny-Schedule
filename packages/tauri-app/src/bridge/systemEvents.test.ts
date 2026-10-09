import { describe, expect, test } from 'bun:test';
import {
  type ActiveTimer,
  autoPauseTimer,
  computeElapsed,
  settleTimer,
} from '@tiny-schedule/shared';
import {
  type IdleSettings,
  isSuspendGap,
  SLEEP_POLL_MS,
  shouldAutoPauseForIdle,
  suspendBackdateMs,
} from './systemEventsLogic';

/**
 * Unit tests for the two judgements the system-event bridge makes.
 *
 * They live in `systemEventsLogic` precisely so this file can import them
 * without dragging in `@tauri-apps/*`, which only resolves inside a real
 * Tauri webview. The wiring around them (CoreGraphics readings, the event
 * channel, the data store) is exercised by running the app; what is worth
 * pinning here is that "does an idle reading mean pause" and "does a clock gap
 * mean sleep" are the rules that would be silently wrong, and a mistake in
 * them is caught in milliseconds here rather than by a user whose timer
 * vanished overnight.
 */

const NOW = 1_760_000_000_000;

function runningTimer(overrides: Partial<ActiveTimer> = {}): ActiveTimer {
  return {
    taskId: 'task-1',
    startedAt: NOW - 60_000,
    accumulatedMs: 0,
    isPaused: false,
    ...overrides,
  };
}

const settings = (overrides: Partial<IdleSettings> = {}): IdleSettings => ({
  idlePauseEnabled: true,
  idlePauseMinutes: 5,
  ...overrides,
});

describe('shouldAutoPauseForIdle', () => {
  test('pauses once idle time passes the configured threshold', () => {
    expect(shouldAutoPauseForIdle(runningTimer(), settings(), 5 * 60)).toBe(true);
  });

  test('does not pause below the threshold', () => {
    expect(shouldAutoPauseForIdle(runningTimer(), settings(), 4 * 60 + 59)).toBe(false);
  });

  test('respects the exact boundary as reaching the threshold', () => {
    // `idleThresholdReached` is `>=`, so 5:00.000 pauses and 4:59.999 does
    // not. A user who set "5 minutes" means five minutes, not "more than".
    expect(shouldAutoPauseForIdle(runningTimer(), settings(), 300)).toBe(true);
    expect(shouldAutoPauseForIdle(runningTimer(), settings(), 299.999)).toBe(false);
  });

  test('never pauses when the setting is off, however long the idle time', () => {
    // The disabled case must be checked before the reading is interpreted:
    // a stale huge reading must not pause a timer the user opted to keep
    // running through idleness.
    expect(
      shouldAutoPauseForIdle(runningTimer(), settings({ idlePauseEnabled: false }), 99_999),
    ).toBe(false);
  });

  test('does nothing without a running timer', () => {
    expect(shouldAutoPauseForIdle(null, settings(), 99_999)).toBe(false);
  });

  test('leaves an already-paused timer alone', () => {
    // Auto-pausing a paused timer would backdate it a second time and move
    // the pause point, so the session would lose time it had already been
    // credited with.
    expect(shouldAutoPauseForIdle(runningTimer({ isPaused: true }), settings(), 99_999)).toBe(
      false,
    );
  });

  test('ignores a non-finite reading', () => {
    // CoreGraphics can return NaN/inf around wake; treating that as "idle
    // forever" would pause a timer the user never let lapse.
    expect(shouldAutoPauseForIdle(runningTimer(), settings(), Number.NaN)).toBe(false);
    expect(shouldAutoPauseForIdle(runningTimer(), settings(), Number.POSITIVE_INFINITY)).toBe(
      false,
    );
  });

  test('ignores a negative reading', () => {
    expect(shouldAutoPauseForIdle(runningTimer(), settings(), -1)).toBe(false);
  });

  test('honours a longer configured threshold', () => {
    expect(
      shouldAutoPauseForIdle(runningTimer(), settings({ idlePauseMinutes: 30 }), 10 * 60),
    ).toBe(false);
    expect(
      shouldAutoPauseForIdle(runningTimer(), settings({ idlePauseMinutes: 30 }), 31 * 60),
    ).toBe(true);
  });

  test('converts seconds to milliseconds before comparing', () => {
    // A units mix-up is invisible at one magnitude and fatal at the other:
    // reading the input as milliseconds would make 60s look like 60ms and
    // never pause, while multiplying it again would make 1s look like an hour
    // and always pause. Both directions are pinned here.
    const oneMinute = settings({ idlePauseMinutes: 1 });
    expect(shouldAutoPauseForIdle(runningTimer(), oneMinute, 0.5)).toBe(false);
    expect(shouldAutoPauseForIdle(runningTimer(), oneMinute, 59)).toBe(false);
    expect(shouldAutoPauseForIdle(runningTimer(), oneMinute, 60)).toBe(true);
  });
});

describe('isSuspendGap', () => {
  const POLL = 5_000;

  test('a nap of a minute reads as a suspend', () => {
    expect(isSuspendGap(60_000, POLL)).toBe(true);
  });

  test('an on-time tick is not a suspend', () => {
    expect(isSuspendGap(POLL, POLL)).toBe(false);
  });

  test('a slightly late tick is not a suspend', () => {
    // Under load an interval can drift by a second or two. Treating drift as
    // sleep would pause the timer of anyone running a build.
    expect(isSuspendGap(POLL + 1_000, POLL)).toBe(false);
  });

  test('the threshold is applied to the excess, not the raw gap', () => {
    // This is the distinction that matters: a 32s gap at a 5s poll is 27s of
    // excess and is *not* a suspend, while a 36s gap is 31s of excess and is.
    expect(isSuspendGap(32_000, POLL)).toBe(false);
    expect(isSuspendGap(36_000, POLL)).toBe(true);
  });

  test('a longer poll interval does not change the verdict', () => {
    // Comparing the raw gap against a fixed threshold would make a 60s poll
    // report a suspend on every ordinary tick.
    expect(isSuspendGap(60_000, 60_000)).toBe(false);
    expect(isSuspendGap(95_000, 60_000)).toBe(true);
  });

  test('a zero gap is not a suspend', () => {
    expect(isSuspendGap(0, POLL)).toBe(false);
  });

  test('ignores non-finite and negative values', () => {
    expect(isSuspendGap(Number.NaN, POLL)).toBe(false);
    expect(isSuspendGap(-1_000, POLL)).toBe(false);
    expect(isSuspendGap(60_000, Number.NaN)).toBe(false);
  });
});

describe('suspendBackdateMs', () => {
  const POLL = SLEEP_POLL_MS;

  /** A timer that has been running since T0 — the shape the watcher sees. */
  const startRunningTimer = (t0: number): ActiveTimer => ({
    taskId: 'task-1',
    startedAt: t0,
    accumulatedMs: 0,
    isPaused: false,
    sessionStartedAt: t0,
  });

  test('hands back the whole observed gap, not just the excess over the poll', () => {
    // The gap is only ever *seen* at wake. The pause point therefore has to be
    // pinned to the last sample before it — which means backdating the entire
    // elapsed, including the poll interval that would otherwise have been
    // credited as a final few seconds of work while the lid was shut.
    expect(suspendBackdateMs(8 * 3_600_000, POLL)).toBe(8 * 3_600_000);
    expect(suspendBackdateMs(POLL + 31_000, POLL)).toBe(36_000);
    // Not `31_000`: the whole elapsed is backdated, so the poll interval that
    // was nominally in flight across the jump is attributed to sleep too.
  });

  test('is only ever called on a gap that already passed isSuspendGap', () => {
    // The function itself is a plain mapping — the "is this a suspend?"
    // judgement stays in `isSuspendGap`, so the call site is where the two are
    // composed. This pins that composition: an ordinary late tick passes no
    // backdate at all, so a loaded machine does not lose the seconds it was
    // actually working.
    for (const gap of [POLL, POLL + 1_000, POLL + 29_000]) {
      const isSuspend = isSuspendGap(gap, POLL);
      const backdate = isSuspend ? suspendBackdateMs(gap, POLL) : 0;
      expect(backdate).toBe(0);
    }
    expect(suspendBackdateMs(POLL + 36_000, POLL)).toBe(POLL + 36_000);
  });

  test('ignores non-finite and negative values', () => {
    expect(suspendBackdateMs(Number.NaN, POLL)).toBe(0);
    expect(suspendBackdateMs(-1_000, POLL)).toBe(0);
    expect(suspendBackdateMs(60_000, Number.NaN)).toBe(0);
    expect(suspendBackdateMs(60_000, -1)).toBe(0);
  });

  test('end to end: an overnight gap bills the seconds before the lid shut', () => {
    // The regression this exists for. The watcher samples every 5s while the
    // user works, so the last sample before the suspend lands at `lastSample`.
    // The machine then sleeps and the next tick — 8 hours later — is the first
    // anyone hears about it. Backdating that gap pins the pause point to
    // `lastSample`, so the 90 seconds actually worked are billed and the eight
    // hours are not.
    const T0 = NOW;
    const workedMs = 90_000;
    const lastSample = T0 + workedMs;
    const wakeAt = lastSample + 8 * 3_600_000;

    const gap = wakeAt - lastSample;
    expect(isSuspendGap(gap, POLL)).toBe(true);

    const paused = autoPauseTimer(
      startRunningTimer(T0),
      wakeAt,
      'sleep',
      suspendBackdateMs(gap, POLL),
    );

    expect(paused.isPaused).toBe(true);
    expect(paused.autoPausedBy).toBe('sleep');
    expect(paused.pausedAt).toBe(lastSample);
    expect(computeElapsed(paused, wakeAt)).toBe(workedMs);
    expect(settleTimer(paused, wakeAt).ms).toBe(workedMs);
  });

  test('without the backdate the same gap bills the whole eight hours', () => {
    // The control for the test above: the numbers only mean something because
    // the pre-fix zero-backdate call produced a different one.
    const T0 = NOW;
    const lastSample = T0 + 90_000;
    const wakeAt = lastSample + 8 * 3_600_000;

    const unfixed = autoPauseTimer(startRunningTimer(T0), wakeAt, 'sleep', 0);

    expect(unfixed.pausedAt).toBe(wakeAt);
    expect(settleTimer(unfixed, wakeAt).ms).toBe(8 * 3_600_000 + 90_000);
  });

  test('a sleep shorter than the session bills only the time before it', () => {
    // 20 minutes worked (sampled every 5s), then a 10-minute nap.
    const T0 = NOW;
    const lastSample = T0 + 20 * 60_000;
    const wakeAt = lastSample + 10 * 60_000;

    const paused = autoPauseTimer(
      startRunningTimer(T0),
      wakeAt,
      'sleep',
      suspendBackdateMs(wakeAt - lastSample, POLL),
    );

    expect(paused.pausedAt).toBe(lastSample);
    expect(computeElapsed(paused, wakeAt)).toBe(20 * 60_000);
  });

  test('an absurd gap clamps to the session start instead of going negative', () => {
    // `mode` is 0600: the pause point cannot precede `startedAt`. A machine
    // that suspends before the first sample after the timer started must not
    // produce a session with negative elapsed time.
    const T0 = NOW;
    const wakeAt = T0 + 7 * 24 * 3_600_000;

    const paused = autoPauseTimer(
      startRunningTimer(T0),
      wakeAt,
      'sleep',
      suspendBackdateMs(wakeAt - T0, POLL),
    );

    expect(paused.pausedAt).toBe(T0);
    expect(computeElapsed(paused, wakeAt)).toBe(0);
    expect(settleTimer(paused, wakeAt).ms).toBe(0);
  });

  test('idle still backdates by its own measured amount, unaffected', () => {
    // The idle path always passed a backdate, so this pins that the sleep fix
    // did not change the other caller's behaviour.
    const T0 = NOW;
    const paused = autoPauseTimer(startRunningTimer(T0), T0 + 600_000, 'idle', 480_000);

    expect(paused.pausedAt).toBe(T0 + 120_000);
    expect(computeElapsed(paused, T0 + 600_000)).toBe(120_000);
  });
});
