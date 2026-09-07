import { describe, expect, test } from 'bun:test';
import { emptyAppData, type FollowUp } from '@tiny-schedule/shared';
import {
  dueFollowUps,
  isFollowUpDue,
  openFollowUps,
  resolvedFollowUps,
  waitingDays,
} from './followUps';

// 2026-09-07 12:00 local time; localDate(now) === '2026-09-07'
const NOW = new Date(2026, 8, 7, 12, 0, 0).getTime();

function fu(partial: Partial<FollowUp> & { id: string }): FollowUp {
  return { title: partial.id, notes: '', entries: [], createdAt: 0, isResolved: false, ...partial };
}

function dataOf(...list: FollowUp[]) {
  return {
    ...emptyAppData(),
    followUps: Object.fromEntries(list.map((f) => [f.id, f])),
  };
}

describe('isFollowUpDue', () => {
  test('due when nextFollowUpDay is today or earlier', () => {
    expect(isFollowUpDue(fu({ id: 'a', nextFollowUpDay: '2026-09-07' }), NOW)).toBe(true);
    expect(isFollowUpDue(fu({ id: 'b', nextFollowUpDay: '2026-09-01' }), NOW)).toBe(true);
    expect(isFollowUpDue(fu({ id: 'c', nextFollowUpDay: '2026-09-08' }), NOW)).toBe(false);
    expect(isFollowUpDue(fu({ id: 'd' }), NOW)).toBe(false);
    expect(
      isFollowUpDue(fu({ id: 'e', nextFollowUpDay: '2026-09-01', isResolved: true }), NOW),
    ).toBe(false);
  });
});

describe('dueFollowUps', () => {
  test('returns only unresolved due/overdue items, sorted by day ascending', () => {
    const data = dataOf(
      fu({ id: 'today', nextFollowUpDay: '2026-09-07' }),
      fu({ id: 'overdue', nextFollowUpDay: '2026-09-01' }),
      fu({ id: 'future', nextFollowUpDay: '2026-09-20' }),
      fu({ id: 'undated' }),
      fu({ id: 'resolved', nextFollowUpDay: '2026-09-01', isResolved: true }),
    );
    expect(dueFollowUps(data, NOW).map((f) => f.id)).toEqual(['overdue', 'today']);
  });
});

describe('openFollowUps', () => {
  test('due items first by date ascending, then the rest by createdAt ascending', () => {
    const data = dataOf(
      fu({ id: 'old-undated', createdAt: 100 }),
      fu({ id: 'due-later', nextFollowUpDay: '2026-09-07', createdAt: 300 }),
      fu({ id: 'new-undated', createdAt: 200 }),
      fu({ id: 'due-earlier', nextFollowUpDay: '2026-09-01', createdAt: 400 }),
      fu({ id: 'resolved', isResolved: true, nextFollowUpDay: '2026-09-01' }),
    );
    expect(openFollowUps(data, NOW).map((f) => f.id)).toEqual([
      'due-earlier',
      'due-later',
      'old-undated',
      'new-undated',
    ]);
  });
});

describe('resolvedFollowUps', () => {
  test('returns resolved items sorted by resolvedAt descending', () => {
    const data = dataOf(
      fu({ id: 'open' }),
      fu({ id: 'r1', isResolved: true, resolvedAt: 100 }),
      fu({ id: 'r2', isResolved: true, resolvedAt: 300 }),
      fu({ id: 'r3', isResolved: true, resolvedAt: 200 }),
    );
    expect(resolvedFollowUps(data).map((f) => f.id)).toEqual(['r2', 'r3', 'r1']);
  });
});

describe('waitingDays', () => {
  test('floors elapsed days since createdAt', () => {
    expect(waitingDays(fu({ id: 'a', createdAt: NOW }), NOW)).toBe(0);
    expect(waitingDays(fu({ id: 'b', createdAt: NOW - 2.5 * 86_400_000 }), NOW)).toBe(2);
    expect(waitingDays(fu({ id: 'c', createdAt: NOW + 86_400_000 }), NOW)).toBe(0);
  });
});
