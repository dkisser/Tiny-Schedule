import { type ActiveTimer, type AppData, autoPauseTimer, Ipc } from '@tiny-schedule/shared';
import { type BrowserWindow, powerMonitor } from 'electron';
import type { Logger } from 'pino';

/** Just enough of taskService to read and write a timer, and nothing more. */
export interface TimerPort {
  current(): ActiveTimer | null;
  sync(timer: ActiveTimer | null): { data: AppData; dropped: boolean };
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
  const applyAutoPause = (reason: 'sleep' | 'idle', backdateMs = 0): void => {
    const timer = timers.current();
    if (!timer || timer.isPaused) return;
    const paused: ActiveTimer = autoPauseTimer(timer, Date.now(), reason, backdateMs);
    const { data: next } = timers.sync(paused);
    const win = getWindow();
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
  };

  powerMonitor.on('suspend', () => applyAutoPause('sleep'));

  const poll = setInterval(() => {
    const idleMs = powerMonitor.getSystemIdleTime() * 1000;
    if (idleReached(idleMs)) applyAutoPause('idle', idleMs);
  }, IDLE_POLL_MS);
  poll.unref(); // never keep the process alive just for this check
}
