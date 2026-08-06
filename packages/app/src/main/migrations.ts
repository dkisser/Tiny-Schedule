import { type AppData, localDate, SYSTEM_TAG_IDS } from '@tiny-schedule/shared';

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
