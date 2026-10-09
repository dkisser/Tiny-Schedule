import { type ActiveTimer, type AppSettings, idleThresholdReached } from '@tiny-schedule/shared';

/**
 * The judgement half of the system-event bridge, with no Tauri, no store, and
 * no clock of its own.
 *
 * These are the rules that decide whether a running timer is paused behind the
 * user's back. They live apart from the wiring in `systemEvents.ts` for two
 * reasons: they are the part that would be silently wrong, and keeping them
 * free of `@tauri-apps/*` imports is what lets `bun test` exercise them
 * without an IPC layer — the plugin modules only resolve inside a real Tauri
 * webview.
 */

/** How often the sleep detector samples the clock. */
export const SLEEP_POLL_MS = 5_000;

/**
 * A clock jump this much larger than the poll interval is treated as the
 * machine having been suspended rather than as scheduling jitter.
 *
 * The detector samples every {@link SLEEP_POLL_MS}, so a 30s gap is roughly
 * six missed samples. A busy main thread can miss a few; the shortest nap
 * worth reacting to misses far more, and a machine that is merely loaded must
 * not have its timer paused.
 */
export const SUSPEND_THRESHOLD_MS = 30_000;

/** The settings fields the idle decision reads. */
export type IdleSettings = Pick<AppSettings, 'idlePauseEnabled' | 'idlePauseMinutes'>;

/**
 * Whether an idle reading should auto-pause the running timer.
 *
 * A non-finite or negative reading is treated as "no evidence" rather than
 * clamped to zero. CoreGraphics can report a nonsense value around wake, and
 * clamping would turn that into a real-looking idle time that pauses a timer
 * the user never let lapse.
 */
export function shouldAutoPauseForIdle(
  timer: ActiveTimer | null,
  settings: IdleSettings,
  idleSeconds: number,
): boolean {
  if (!timer || timer.isPaused) return false;
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return false;
  return idleThresholdReached(settings, idleSeconds * 1000);
}

/**
 * Whether the gap between two clock samples means the machine slept.
 *
 * `elapsedMs` is measured wall-clock time, `expectedMs` the nominal poll
 * interval. The threshold applies to the *excess* over the expected gap, and
 * that is the whole point: an interval arriving six seconds late under load is
 * not a suspend, while one arriving thirty-one seconds late is. Comparing the
 * raw gap against a fixed threshold would conflate the two.
 */
export function isSuspendGap(elapsedMs: number, expectedMs: number): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  if (!Number.isFinite(expectedMs) || expectedMs < 0) return false;
  return elapsedMs - expectedMs > SUSPEND_THRESHOLD_MS;
}

/**
 * How far back the pause point has to move for a detected suspend.
 *
 * A suspend gap is only observed *after* the machine woke — the webview does
 * not run while it sleeps, so the interval simply stops and resumes. That makes
 * the wake instant the wrong pause point: `autoPauseTimer` with a zero backdate
 * would credit the whole offline stretch (a laptop closed overnight bills eight
 * hours). The Electron original never had this problem because
 * `powerMonitor.on('suspend')` fired *at* the suspend, with `Date.now()` still
 * on the pre-suspend side of the jump.
 *
 * So the pause point is pinned to the last sample taken before the gap. The
 * whole excess is attributed to sleep — the machine was, by definition, not
 * running the app — rather than to work. An over-large value is harmless:
 * `autoPauseTimer` clamps the pause point to `startedAt`, so a gap longer than
 * the session already credited settles at zero elapsed rather than going
 * negative.
 */
export function suspendBackdateMs(elapsedMs: number, expectedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  if (!Number.isFinite(expectedMs) || expectedMs < 0) return 0;
  return elapsedMs;
}

/**
 * Whether a timer restored at launch was still running when the app last
 * exited, long enough ago that the gap is downtime rather than scheduling.
 *
 * The bug this exists for: `on_exit_requested` only fires for a quit the
 * process is asked to intercept. Quitting from the Dock icon skips it —
 * `tao` implements no `applicationShouldTerminate:` delegate, so the app goes
 * straight to `RunEvent::Exit` — and nothing settles the session on the way
 * out. What lands on disk is `isPaused: false, startedAt: <quit instant>`,
 * and `computeElapsed` adds `now - startedAt`, so the entire time the machine
 * was off was billed as work. Eight hours away, eight hours recorded.
 *
 * The decision is deliberately conservative about what to do with it: mark
 * the pause point at `startedAt` and record nothing. Billing the gap would
 * guess that the user worked while the machine was shut, and ADR 0002 already
 * settled that the recovery path clears rather than guesses — a state that can
 * be read two ways must not be turned into money on a coin flip. The user
 * resumes explicitly, and if the session really was live they resume it.
 *
 * A timer already paused, or one whose gap is within
 * {@link SUSPEND_THRESHOLD_MS}, is left alone: a quick restart is downtime the
 * user would not think of as downtime, and the same threshold the live sleep
 * detector uses keeps the two decisions from disagreeing.
 */
export function isOfflineResume(timer: ActiveTimer, now: number): boolean {
  if (timer.isPaused) return false;
  if (!Number.isFinite(timer.startedAt) || !Number.isFinite(now)) return false;
  return now - timer.startedAt > SUSPEND_THRESHOLD_MS;
}
