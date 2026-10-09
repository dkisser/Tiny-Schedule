import { describe, expect, test } from 'bun:test';
import { emptyAppData, type Idea, type Project, type Task } from '@tiny-schedule/shared';
import {
  appendIdeaEntry,
  closeIdeaWithVerdict,
  completeIdea,
  deleteIdeaEntry,
  discardIdea,
  ideaByProjectId,
  ideaPendingVerdict,
  ideaProjectOpenTaskCount,
  incubatingIdeas,
  openIdeas,
  reopenIdea,
  resolvedIdeas,
  updateIdeaEntry,
  upgradeIdeaToProject,
} from './ideas';

function idea(partial: Partial<Idea> & { id: string }): Idea {
  return { title: partial.id, notes: '', createdAt: 0, status: 'open', ...partial };
}

function project(partial: Partial<Project> & { id: string }): Project {
  return { title: partial.id, isArchived: false, ...partial };
}

function dataOf(list: Idea[], projects: Project[] = [], tasks: Task[] = []) {
  return {
    ...emptyAppData(),
    ideas: Object.fromEntries(list.map((i) => [i.id, i])),
    projects: {
      ...emptyAppData().projects,
      ...Object.fromEntries(projects.map((p) => [p.id, p])),
    },
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  };
}

describe('openIdeas', () => {
  test('returns only open ideas, newest first', () => {
    const data = dataOf([
      idea({ id: 'old', createdAt: 100 }),
      idea({ id: 'new', createdAt: 200 }),
      idea({ id: 'done', status: 'done', resolvedAt: 1 }),
      idea({ id: 'incubating', status: 'incubating', projectId: 'p1' }),
    ]);
    expect(openIdeas(data).map((i) => i.id)).toEqual(['new', 'old']);
  });
});

describe('ideaPendingVerdict', () => {
  const archived = project({ id: 'p1', isArchived: true });
  test('true when incubating, no verdict and project archived', () => {
    const data = dataOf([], [archived]);
    expect(ideaPendingVerdict(idea({ id: 'a', status: 'incubating', projectId: 'p1' }), data)).toBe(
      true,
    );
  });
  test('false when project not archived, verdict given, or not incubating', () => {
    const active = dataOf([], [project({ id: 'p1' })]);
    const incubating = idea({ id: 'a', status: 'incubating', projectId: 'p1' });
    expect(ideaPendingVerdict(incubating, active)).toBe(false);
    const withVerdict = dataOf([], [archived]);
    expect(
      ideaPendingVerdict(
        idea({
          id: 'b',
          status: 'incubating',
          projectId: 'p1',
          verdict: { result: 'validated', closedAt: 1 },
        }),
        withVerdict,
      ),
    ).toBe(false);
    expect(ideaPendingVerdict(idea({ id: 'c', projectId: 'p1' }), dataOf([], [archived]))).toBe(
      false,
    );
  });
});

describe('incubatingIdeas', () => {
  test('pending-verdict first, then by latest activity descending', () => {
    const archived = project({ id: 'pa', isArchived: true });
    const data = dataOf(
      [
        idea({ id: 'stale', status: 'incubating', projectId: 'p1', incubatedAt: 100 }),
        idea({
          id: 'active',
          status: 'incubating',
          projectId: 'p2',
          incubatedAt: 100,
          timeline: [{ id: 'e1', createdAt: 500, text: 'x' }],
        }),
        idea({ id: 'pending', status: 'incubating', projectId: 'pa', incubatedAt: 50 }),
        idea({ id: 'open' }),
      ],
      [archived, project({ id: 'p1' }), project({ id: 'p2' })],
    );
    expect(incubatingIdeas(data).map((i) => i.id)).toEqual(['pending', 'active', 'stale']);
  });
});

describe('resolvedIdeas', () => {
  test('returns done/discarded/converted/closed, resolvedAt (or convertedAt) descending', () => {
    const data = dataOf([
      idea({ id: 'open' }),
      idea({ id: 'incubating', status: 'incubating', projectId: 'p1' }),
      idea({ id: 'done', status: 'done', resolvedAt: 100 }),
      idea({ id: 'discarded', status: 'discarded', resolvedAt: 300 }),
      idea({ id: 'legacy-converted', status: 'converted', convertedAt: 200 }),
      idea({ id: 'closed', status: 'closed', resolvedAt: 400 }),
    ]);
    expect(resolvedIdeas(data).map((i) => i.id)).toEqual([
      'closed',
      'discarded',
      'legacy-converted',
      'done',
    ]);
  });
});

describe('ideaByProjectId', () => {
  test('finds the idea linked to a project', () => {
    const data = dataOf([idea({ id: 'a', status: 'incubating', projectId: 'p1' })]);
    expect(ideaByProjectId(data, 'p1')?.id).toBe('a');
    expect(ideaByProjectId(data, 'p2')).toBeUndefined();
  });
});

describe('ideaProjectOpenTaskCount', () => {
  test('counts only top-level open tasks of the project', () => {
    const t = (id: string, projectId: string, extra: Partial<Task> = {}): Task => ({
      id,
      title: id,
      projectId,
      tagIds: [],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 0,
      ...extra,
    });
    const data = dataOf(
      [],
      [],
      [
        t('t1', 'p1'),
        t('t2', 'p1', { isDone: true }),
        t('t3', 'p1', { parentTaskId: 't1' }),
        t('t4', 'p2'),
      ],
    );
    expect(ideaProjectOpenTaskCount(data, 'p1')).toBe(1);
  });
});

describe('completeIdea / discardIdea / reopenIdea', () => {
  test('complete and discard set status and resolvedAt', () => {
    const done = completeIdea(idea({ id: 'a' }));
    expect(done.status).toBe('done');
    expect(done.resolvedAt).toBeGreaterThan(0);
    const discarded = discardIdea(idea({ id: 'b' }));
    expect(discarded.status).toBe('discarded');
    expect(discarded.resolvedAt).toBeGreaterThan(0);
  });

  test('reopen returns done/discarded to open and clears resolvedAt', () => {
    const done = completeIdea(idea({ id: 'a' }));
    const reopened = reopenIdea(done);
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedAt).toBeUndefined();
  });

  test('reopen is a no-op for terminal or incubating statuses', () => {
    const converted = idea({ id: 'a', status: 'converted', convertedAt: 1 });
    expect(reopenIdea(converted)).toBe(converted);
    const closed = idea({ id: 'b', status: 'closed', resolvedAt: 1 });
    expect(reopenIdea(closed)).toBe(closed);
    const incubating = idea({ id: 'c', status: 'incubating', projectId: 'p1' });
    expect(reopenIdea(incubating)).toBe(incubating);
  });
});

describe('upgradeIdeaToProject', () => {
  test('links the project and enters incubating', () => {
    const upgraded = upgradeIdeaToProject(idea({ id: 'a' }), 'p1', '三个月内 100 个用户');
    expect(upgraded.status).toBe('incubating');
    expect(upgraded.projectId).toBe('p1');
    expect(upgraded.validationGoal).toBe('三个月内 100 个用户');
    expect(upgraded.incubatedAt).toBeGreaterThan(0);
  });

  test('empty validation goal is dropped', () => {
    const upgraded = upgradeIdeaToProject(idea({ id: 'a' }), 'p1', '');
    expect(upgraded.validationGoal).toBeUndefined();
  });
});

describe('timeline entries', () => {
  test('append adds entries in order', () => {
    const withOne = appendIdeaEntry(idea({ id: 'a' }), '第一条');
    expect(withOne.timeline).toHaveLength(1);
    expect(withOne.timeline?.[0]?.text).toBe('第一条');
    const withTwo = appendIdeaEntry(withOne, '第二条');
    expect(withTwo.timeline).toHaveLength(2);
    expect(withOne.timeline).toHaveLength(1); // immutable
  });

  test('update edits the matching entry only', () => {
    const base = appendIdeaEntry(appendIdeaEntry(idea({ id: 'a' }), '一'), '二');
    const target = base.timeline?.[0];
    if (!target) throw new Error('missing entry');
    const updated = updateIdeaEntry(base, target.id, '一改');
    expect(updated.timeline?.[0]?.text).toBe('一改');
    expect(updated.timeline?.[1]?.text).toBe('二');
  });

  test('delete removes the matching entry', () => {
    const base = appendIdeaEntry(appendIdeaEntry(idea({ id: 'a' }), '一'), '二');
    const target = base.timeline?.[0];
    if (!target) throw new Error('missing entry');
    const updated = deleteIdeaEntry(base, target.id);
    expect(updated.timeline).toHaveLength(1);
    expect(updated.timeline?.[0]?.text).toBe('二');
  });
});

describe('closeIdeaWithVerdict', () => {
  test('incubating → closed with verdict and resolvedAt', () => {
    const closed = closeIdeaWithVerdict(
      idea({ id: 'a', status: 'incubating', projectId: 'p1' }),
      'partial',
      '部分跑通',
    );
    expect(closed.status).toBe('closed');
    expect(closed.verdict?.result).toBe('partial');
    expect(closed.verdict?.text).toBe('部分跑通');
    expect(closed.resolvedAt).toBeGreaterThan(0);
  });

  test('on an already closed idea only the verdict is updated', () => {
    const first = closeIdeaWithVerdict(
      idea({ id: 'a', status: 'incubating', projectId: 'p1' }),
      'invalidated',
    );
    const resolvedAt = first.resolvedAt;
    const second = closeIdeaWithVerdict(first, 'validated', '其实验证成功了');
    expect(second.status).toBe('closed');
    expect(second.verdict?.result).toBe('validated');
    expect(second.verdict?.text).toBe('其实验证成功了');
    expect(second.resolvedAt).toBe(resolvedAt);
  });
});
