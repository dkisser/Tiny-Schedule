/**
 * Follow-up rules.
 *
 * A follow-up is work that is waiting on somebody else (an ICP review, a
 * reply, a signature). It never becomes a task and never enters the today
 * view; it only becomes due on its own follow-up day.
 */
import type { FollowUpRecord } from './schema.ts';
import { localDate } from './time.ts';

export function newFollowUpId(now = Date.now()): string {
  return `f_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankFollowUp(title: string, now = Date.now()): FollowUpRecord {
  return {
    id: newFollowUpId(now),
    title,
    notes: '',
    entries: [],
    createdAt: now,
    isResolved: false,
  };
}

/** Due when unresolved and its follow-up day has arrived. */
export function isFollowUpDue(f: FollowUpRecord, now = Date.now()): boolean {
  const day = localDate(now);
  return !f.isResolved && !!f.nextFollowUpDay && f.nextFollowUpDay <= day;
}

/** Closed: the resolution time is recorded and the row leaves the due list. */
export function resolveFollowUp(f: FollowUpRecord, now = Date.now()): FollowUpRecord {
  return { ...f, isResolved: true, resolvedAt: now };
}

/** Reopened: the resolution time is cleared and the follow-up day applies again. */
export function reopenFollowUp(f: FollowUpRecord): FollowUpRecord {
  return { ...f, isResolved: false, resolvedAt: undefined };
}

/** Append a note to the follow-up timeline. */
export function appendFollowUpEntry(
  f: FollowUpRecord,
  text: string,
  now = Date.now(),
): FollowUpRecord {
  return {
    ...f,
    entries: [...f.entries, { id: newFollowUpId(now), at: now, text }],
  };
}
