import { autoPauseTimer, Ipc, idleThresholdReached } from '@tiny-schedule/shared';
import { type BrowserWindow, powerMonitor } from 'electron';
import type { Logger } from 'pino';
import type { DataStore } from './dataStore';

export interface PowerTimerDeps {
  store: DataStore;
  logger: Logger;
  getWindow: () => BrowserWindow | null;
}

// Poll faster than any sensible threshold so the pause point (backdated by
// the measured idle time) stays accurate without busy-checking.
const IDLE_POLL_MS = 20_000;

/**
 * Watches system sleep and input idleness, auto-pausing the running timer in
 * the main process — the renderer is frozen during sleep and cannot observe
 * either itself. Paused timers stay paused; resuming is always manual.
 */
export function startPowerTimerWatcher({ store, logger, getWindow }: PowerTimerDeps): void {
  const applyAutoPause = (reason: 'sleep' | 'idle', backdateMs = 0): void => {
    const timer = store.get().activeTimer;
    if (!timer || timer.isPaused) return;
    const paused = autoPauseTimer(timer, Date.now(), reason, backdateMs);
    store.update((d) => ({ ...d, activeTimer: paused }));
    const win = getWindow();
    // check-ipc: ok — Ipc.timerChanged constant
    if (win && !win.isDestroyed()) win.webContents.send(Ipc.timerChanged, paused);
    logger.info({ action: 'timer:autoPause', reason, taskId: paused.taskId });
  };

  powerMonitor.on('suspend', () => applyAutoPause('sleep'));

  const poll = setInterval(() => {
    const idleMs = powerMonitor.getSystemIdleTime() * 1000;
    if (idleThresholdReached(store.get().settings, idleMs)) applyAutoPause('idle', idleMs);
  }, IDLE_POLL_MS);
  poll.unref(); // never keep the process alive just for this check
}
