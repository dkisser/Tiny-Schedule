import { describe, expect, test } from 'bun:test';
import {
  appendIdeaEntry,
  closeIdeaWithVerdict,
  completeIdea,
  deleteIdeaEntry,
  discardIdea,
  type Idea,
  reopenIdea,
  updateIdeaEntry,
  upgradeIdeaToProject,
} from '../src/domain/idea';

// 想法的转移规则测试跟着规则本身走：ADR-0003 把这些纯函数的所有权交给了
// shared 的 domain 层，所以它们的测试也属于这里，而不是渲染进程的 lib/ 下。

function idea(partial: Partial<Idea> & { id: string }): Idea {
  return { title: partial.id, notes: '', createdAt: 0, status: 'open', ...partial };
}

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
