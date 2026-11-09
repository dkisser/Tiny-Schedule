import { describe, expect, test } from 'bun:test';
import { isFollowUpDue, reopenFollowUp, resolveFollowUp } from '../src/domain/followups.ts';
import {
  appendIdeaEntry,
  blankIdea,
  closeIdeaWithVerdict,
  completeIdea,
  discardIdea,
  ideaPendingVerdict,
  incubatingIdeas,
  openIdeas,
  reopenIdea,
  resolvedIdeas,
  upgradeIdeaToProject,
} from '../src/domain/ideas.ts';
import type { IdeaRecord } from '../src/domain/schema.ts';
import { pauseTimer, resumeTimer, settleTimer, startTimer } from '../src/domain/timer.ts';

const NOW = new Date('2026-01-05T12:00:00').getTime();

function idea(over: Partial<IdeaRecord> = {}): IdeaRecord {
  return { ...blankIdea('idea', NOW), ...over };
}

describe('idea groups', () => {
  test('the inbox holds untouched ideas, newest first', () => {
    const ideas = [
      idea({ id: 'old', createdAt: 1 }),
      idea({ id: 'new', createdAt: 2 }),
      idea({ id: 'incubating', status: 'incubating' }),
    ];
    expect(openIdeas(ideas).map((i) => i.id)).toEqual(['new', 'old']);
  });

  test('an incubating idea waits for a verdict once its project is archived', () => {
    const incubating = idea({ status: 'incubating', projectId: 'p1' });
    const projects = { p1: { isArchived: true } };
    expect(ideaPendingVerdict(incubating, projects)).toBe(true);
    expect(ideaPendingVerdict(incubating, { p1: { isArchived: false } })).toBe(false);
    expect(ideaPendingVerdict(incubating, {})).toBe(false);
  });

  test('an incubating idea awaiting a verdict sorts first', () => {
    const ideas = [
      idea({ id: 'active', status: 'incubating', projectId: 'p1', incubatedAt: 10 }),
      idea({ id: 'waiting', status: 'incubating', projectId: 'p2', incubatedAt: 5 }),
    ];
    const projects = { p1: { isArchived: false }, p2: { isArchived: true } };
    expect(incubatingIdeas(ideas, projects).map((i) => i.id)).toEqual(['waiting', 'active']);
  });

  test('resolved ideas sort by resolution time', () => {
    const ideas = [
      idea({ id: 'a', status: 'done', resolvedAt: 1 }),
      idea({
        id: 'b',
        status: 'closed',
        resolvedAt: 5,
        verdict: { result: 'validated', closedAt: 5 },
      }),
      idea({ id: 'c', status: 'open' }),
    ];
    expect(resolvedIdeas(ideas).map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('idea transitions', () => {
  test('complete and discard are reopenable', () => {
    const done = completeIdea(idea(), NOW);
    expect(done.status).toBe('done');
    expect(reopenIdea(done).status).toBe('open');
    const discarded = discardIdea(idea(), NOW);
    expect(discarded.status).toBe('discarded');
    expect(reopenIdea(discarded).status).toBe('open');
  });

  test('an incubating idea cannot be reopened', () => {
    const incubating = upgradeIdeaToProject(idea(), 'p1', 'ship it', NOW);
    expect(incubating.status).toBe('incubating');
    expect(reopenIdea(incubating).status).toBe('incubating');
  });

  test('a verdict closes the idea; a second verdict only rewrites it', () => {
    const closed = closeIdeaWithVerdict(
      idea({ status: 'incubating' }),
      'validated',
      'because',
      NOW,
    );
    expect(closed.status).toBe('closed');
    expect(closed.verdict?.result).toBe('validated');
    const rewritten = closeIdeaWithVerdict(closed, 'partial', 'hmm', NOW + 1);
    expect(rewritten.status).toBe('closed');
    expect(rewritten.verdict?.result).toBe('partial');
  });

  test('the evolution log grows by appending', () => {
    const withEntry = appendIdeaEntry(idea(), 'first', NOW);
    expect(withEntry.timeline).toHaveLength(1);
    expect(withEntry.timeline?.[0]?.text).toBe('first');
  });
});

describe('follow-ups', () => {
  const followUp = {
    id: 'f1',
    title: 'waiting',
    notes: '',
    entries: [],
    createdAt: NOW,
    nextFollowUpDay: '2026-01-05',
    isResolved: false,
  };

  test('a follow-up is due once its day arrives', () => {
    expect(isFollowUpDue(followUp, NOW)).toBe(true);
    expect(isFollowUpDue({ ...followUp, nextFollowUpDay: '2026-01-06' }, NOW)).toBe(false);
  });

  test('resolving clears the due state, reopening restores it', () => {
    const resolved = resolveFollowUp(followUp, NOW);
    expect(resolved.isResolved).toBe(true);
    expect(isFollowUpDue(resolved, NOW)).toBe(false);
    const reopened = reopenFollowUp(resolved);
    expect(reopened.isResolved).toBe(false);
    expect(isFollowUpDue(reopened, NOW)).toBe(true);
  });
});

describe('timer', () => {
  test('a running timer counts until it is paused', () => {
    const timer = startTimer('t1', NOW);
    const paused = pauseTimer(timer, NOW + 60_000);
    expect(paused.accumulatedMs).toBe(60_000);
    expect(paused.isPaused).toBe(true);
  });

  test('settling a paused timer stops at the pause moment', () => {
    const timer = startTimer('t1', NOW);
    const paused = pauseTimer(timer, NOW + 60_000);
    const settlement = settleTimer(paused, NOW + 600_000);
    expect(settlement.ms).toBe(60_000);
    expect(settlement.entry.date).toBe('2026-01-05');
  });

  test('resuming adds the new session on top of what was already counted', () => {
    const timer = startTimer('t1', NOW);
    const paused = pauseTimer(timer, NOW + 60_000);
    const resumed = resumeTimer(paused, NOW + 120_000);
    const settlement = settleTimer(resumed, NOW + 180_000);
    // 60s before the pause + 60s after the resume.
    expect(settlement.ms).toBe(120_000);
  });
});
