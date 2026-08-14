import { type AppData, localDate, POMODORO_FOCUS_MS, SYSTEM_TAG_IDS } from '@tiny-schedule/shared';

/**
 * One-time migration away from the TODAY system tag: the Today view is now
 * purely dueDay-driven. Strips the TODAY tag from tasks (backfilling dueDay
 * with today when the task had none) and removes the tag entity itself.
 * Returns the same reference when nothing changed.
 */
export function migrateRemoveTodayTag(d: AppData): AppData {
  const todayId = SYSTEM_TAG_IDS.today;
  const affected = Object.values(d.tasks).filter((t) => t.tagIds.includes(todayId));
  if (affected.length === 0 && !d.tags[todayId]) return d;

  const today = localDate(Date.now());
  const tasks = { ...d.tasks };
  for (const t of affected) {
    tasks[t.id] = {
      ...t,
      tagIds: t.tagIds.filter((id) => id !== todayId),
      dueDay: t.dueDay ?? today,
    };
  }
  const tags = { ...d.tags };
  delete tags[todayId];
  return { ...d, tasks, tags };
}

/**
 * Backfill `focusAccumulatedMs` on pomodoro timers persisted before the
 * break-exclusion fix. For an in-flight focus phase we leave it undefined
 * (live `computeFocusElapsed` will pick up the rest on advance/settle); for
 * a break phase we estimate from completed cycles so the user doesn't lose
 * already-finished focus work when they stop. Returns the same reference
 * when nothing changed.
 */
export function migrateActiveTimerPomodoroFocus(d: AppData): AppData {
  const t = d.activeTimer;
  if (!t || t.mode !== 'pomodoro' || t.focusAccumulatedMs !== undefined) return d;
  const base = t.phase === 'break' ? (t.cyclesCompleted ?? 0) * POMODORO_FOCUS_MS : 0;
  return { ...d, activeTimer: { ...t, focusAccumulatedMs: base } };
}
