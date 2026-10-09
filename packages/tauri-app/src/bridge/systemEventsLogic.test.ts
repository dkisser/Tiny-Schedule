import { describe, expect, test } from 'bun:test';
import type { ActiveTimer } from '@tiny-schedule/shared';
import {
  isOfflineResume,
  isSuspendGap,
  SUSPEND_THRESHOLD_MS,
  suspendBackdateMs,
} from './systemEventsLogic';

const T0 = 1_785_700_000_000;

describe('isSuspendGap', () => {
  test('a clock jump past the threshold is a suspend', () => {
    expect(isSuspendGap(45_000, 5_000)).toBe(true);
  });

  test('ordinary sampling jitter is not', () => {
    expect(isSuspendGap(6_000, 5_000)).toBe(false);
  });

  test('non-finite readings are no evidence', () => {
    expect(isSuspendGap(Number.NaN, 5_000)).toBe(false);
    expect(isSuspendGap(5_000, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('suspendBackdateMs', () => {
  test('backdates by the whole gap, landing the pause at its start', () => {
    // The wake instant is the wrong pause point: everything between the last
    // sample before the suspend and the wake would be billed as work. The
    // caller subtracts this from `now`, so the full interval is what moves the
    // pause back to the moment before the machine slept.
    const elapsed = 9 * 3_600_000;
    expect(suspendBackdateMs(elapsed, 5_000)).toBe(elapsed);
  });

  test('no evidence backdates nothing', () => {
    expect(suspendBackdateMs(Number.NaN, 5_000)).toBe(0);
    expect(suspendBackdateMs(-1, 5_000)).toBe(0);
  });
});

describe('isOfflineResume', () => {
  const running = (startedAt: number): ActiveTimer => ({
    taskId: 't1',
    startedAt,
    accumulatedMs: 0,
    isPaused: false,
  });

  test('a timer running since before an overnight gap is offline, not working', () => {
    // The Dock-quit defect: nothing settles the session on the way out, so the
    // dataset arrives with `isPaused: false` and a quit-time `startedAt`. If
    // this returned false the elapsed hours would be billed as work.
    expect(isOfflineResume(running(T0), T0 + 8 * 3_600_000)).toBe(true);
  });

  test('a short gap is downtime the user would not think of as downtime', () => {
    // Restarting the app quickly must not turn the session into a paused one.
    expect(isOfflineResume(running(T0), T0 + 10_000)).toBe(false);
  });

  test('the boundary follows the same threshold the live detector uses', () => {
    // One rule, two call sites: if these diverged, a machine that suspended
    // and one that was simply quit could end up paused on different grounds.
    expect(isOfflineResume(running(T0), T0 + SUSPEND_THRESHOLD_MS)).toBe(false);
    expect(isOfflineResume(running(T0), T0 + SUSPEND_THRESHOLD_MS + 1)).toBe(true);
  });

  test('an already-paused timer is left alone', () => {
    // It was paused deliberately before the app exited; isPaused already
    // excludes its gap from the elapsed time.
    expect(isOfflineResume({ ...running(T0), isPaused: true }, T0 + 8 * 3_600_000)).toBe(false);
  });

  test('non-finite timestamps are treated as no evidence', () => {
    expect(isOfflineResume(running(Number.NaN), T0)).toBe(false);
    expect(isOfflineResume(running(T0), Number.POSITIVE_INFINITY)).toBe(false);
  });
});
