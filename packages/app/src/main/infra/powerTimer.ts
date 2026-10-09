import { type ActiveTimer, type AppData, autoPauseTimer, Ipc } from '@tiny-schedule/shared';
import { type BrowserWindow, powerMonitor } from 'electron';
import type { Logger } from 'pino';

/** Just enough of taskService to read and write a timer, and nothing more. */
export interface TimerPort {
  current(): ActiveTimer | null;
  /**
   * `persisted` matters here as much as `dropped`: a refused auto-pause is
   * neither a drop nor a success, and the watcher is the only place that can
   * tell the renderer before the session silently vanishes on restart.
   */
  sync(timer: ActiveTimer | null): { data: AppData; dropped: boolean; persisted: boolean };
}

export interface PowerTimerDeps {
  logger: Logger;
  getWindow: () => BrowserWindow | null;
  /**
   * The narrow port, so the "no timer on a done task" rule lives in one place.
   * This watcher used to reach past the services into the store and inline its
   * own dropStaleTiming, making it the fourth copy of a rule that
   * taskService.upsert, syncTimer and importService also enforce — and
   * taskService.remove already had to special-case the deleted-task variant,
   * which is what that duplication costs when the rule next changes.
   */
  timers: TimerPort;
  /** The idle threshold lives in settings; this watcher only applies it. */
  idleReached: (idleMs: number) => boolean;
}

// Poll faster than any sensible threshold so the pause point (backdated by
// the measured idle time) stays accurate without busy-checking.
const IDLE_POLL_MS = 20_000;

/** Everything applyAutoPause needs. A subset of PowerTimerDeps on purpose. */
export interface AutoPauseDeps {
  timers: TimerPort;
  logger: Logger;
  getWindow: () => BrowserWindow | null;
}

/**
 * The idle half of the watcher, as a plain function.
 *
 * It was a closure inside startPowerTimerWatcher, reachable only by waiting 20
 * seconds of wall clock — which is why the whole module had no tests. Same
 * body, now callable directly.
 */
export function checkIdle(
  deps: AutoPauseDeps,
  idleReached: (idleMs: number) => boolean,
  getIdleSeconds: () => number,
  now = Date.now(),
): void {
  const idleMs = getIdleSeconds() * 1000;
  if (!idleReached(idleMs)) return;
  applyAutoPause(deps, 'idle', idleMs, now);
}

/**
 * Pause the running timer because the machine slept or the user went idle.
 *
 * Split out of the watcher for the same reason as checkIdle: the rule that
 * matters here — an already-paused timer is left alone, and a port that
 * dropped the timer must be announced to the renderer — was otherwise only
 * reachable through a real suspend event.
 */
export function applyAutoPause(
  { timers, logger, getWindow }: AutoPauseDeps,
  reason: 'sleep' | 'idle',
  backdateMs = 0,
  now = Date.now(),
): void {
  const timer = timers.current();
  if (!timer || timer.isPaused) return;
  const paused: ActiveTimer = autoPauseTimer(timer, now, reason, backdateMs);
  const { data: next, persisted } = timers.sync(paused);
  const win = getWindow();
  if (!persisted) {
    // The pause never reached disk. Reading `!next.activeTimer` here would be
    // wrong in both directions: it reports a deliberate drop that did not
    // happen, or — when the degraded fallback happens to carry a timer —
    // announces a pause that will not survive a restart. Say what is true.
    if (win && !win.isDestroyed()) win.webContents.send(Ipc.timerChanged, null);
    logger.error({
      action: 'timer:autoPause:refused',
      taskId: paused.taskId,
      reason,
      note: 'the auto-pause was discarded; nothing was written to disk',
    });
    return;
  }
  if (!next.activeTimer) {
    // Tell the renderer the clock is gone. Without this its TimerBar keeps
    // counting a session the main process has discarded.
    if (win && !win.isDestroyed()) win.webContents.send(Ipc.timerChanged, null);
    logger.info({ action: 'timer:drop:autoPause', taskId: paused.taskId, reason });
    return;
  }
  // check-ipc: ok — Ipc.timerChanged constant
  if (win && !win.isDestroyed()) win.webContents.send(Ipc.timerChanged, paused);
  logger.info({ action: 'timer:autoPause', reason, taskId: paused.taskId });
}

/**
 * Watches system sleep and input idleness, auto-pausing the running timer in
 * the main process — the renderer is frozen during sleep and cannot observe
 * either itself. Paused timers stay paused; resuming is always manual.
 */
export function startPowerTimerWatcher({
  logger,
  getWindow,
  timers,
  idleReached,
}: PowerTimerDeps): void {
  const deps: AutoPauseDeps = { logger, getWindow, timers };
  powerMonitor.on('suspend', () => applyAutoPause(deps, 'sleep'));

  const poll = setInterval(
    () => checkIdle(deps, idleReached, () => powerMonitor.getSystemIdleTime()),
    IDLE_POLL_MS,
  );
  poll.unref(); // never keep the process alive just for this check
}
