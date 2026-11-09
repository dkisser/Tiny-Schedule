import { describe, expect, test } from 'bun:test';
import { TaskTrackerService } from '../src/service/service.ts';
import { createFakeDomain } from './helpers/fakeDomain.ts';

function service(): TaskTrackerService {
  return new TaskTrackerService(createFakeDomain().domain);
}

describe('tasks', () => {
  test('a new task lands in the inbox and reads back', async () => {
    const tracker = service();
    const task = await tracker.upsertTask({ title: '写插件' });
    expect(task.projectId).toBe('INBOX_PROJECT');
    expect(tracker.listTasks().map((t) => t.id)).toEqual([task.id]);
  });

  test('time is recorded once and derived on read', async () => {
    const tracker = service();
    const task = await tracker.upsertTask({ title: '写插件' });
    await tracker.logTime({ taskId: task.id, minutes: 30 });
    await tracker.logTime({ taskId: task.id, minutes: 15 });
    const [view] = tracker.listTasks();
    expect(view?.timeSpent).toBe(45 * 60_000);
    expect(Object.values(view?.timeSpentOnDay ?? {})).toEqual([45 * 60_000]);
  });

  test('completing a task settles its running timer first', async () => {
    const tracker = service();
    const task = await tracker.upsertTask({ title: '写插件' });
    await tracker.startTimer(task.id);
    await tracker.setTaskDone(task.id, true);
    expect(tracker.activeTimer).toBeNull();
    expect(tracker.listTimeEntries()).toHaveLength(1);
    expect(tracker.listTasks()[0]?.isDone).toBe(true);
  });

  test('deleting a task removes its time records', async () => {
    const tracker = service();
    const task = await tracker.upsertTask({ title: '写插件' });
    await tracker.logTime({ taskId: task.id, minutes: 10 });
    await tracker.deleteTask(task.id);
    expect(tracker.listTasks()).toHaveLength(0);
    expect(tracker.listTimeEntries()).toHaveLength(0);
  });

  test('finishing the day rolls unfinished work over to tomorrow', async () => {
    const tracker = service();
    const today = new Date();
    const day = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;
    const due = await tracker.upsertTask({ title: '今天的活', dueDay: day });
    const later = await tracker.upsertTask({ title: '以后的事', dueDay: '2099-01-01' });
    const rolled = await tracker.finishDay();
    expect(rolled.map((t) => t.id)).toEqual([due.id]);
    expect(tracker.listTasks().find((t) => t.id === due.id)?.dueDay).not.toBe(day);
    expect(tracker.listTasks().find((t) => t.id === later.id)?.dueDay).toBe('2099-01-01');
  });

  test('only one timer runs at a time', async () => {
    const tracker = service();
    const first = await tracker.upsertTask({ title: '一' });
    const second = await tracker.upsertTask({ title: '二' });
    await tracker.startTimer(first.id);
    await expect(tracker.startTimer(second.id)).rejects.toThrow(/already running/);
  });

  test('stopping the timer stores the measured interval', async () => {
    const tracker = service();
    const task = await tracker.upsertTask({ title: '写插件' });
    await tracker.startTimer(task.id);
    const { entry } = await tracker.stopTimer();
    expect(entry.taskId).toBe(task.id);
    expect(entry.ms).toBeGreaterThanOrEqual(0);
    expect(tracker.activeTimer).toBeNull();
  });

  test('a task carries its own time entries on read', async () => {
    const tracker = service();
    const task = await tracker.upsertTask({ title: '写插件' });
    await tracker.logTime({ taskId: task.id, minutes: 20 });
    const [view] = tracker.listTasks();
    expect(view?.timeEntries).toHaveLength(1);
    expect(view?.timeEntries[0]?.ms).toBe(20 * 60_000);
  });

  test('deleting a time entry shrinks the totals', async () => {
    const tracker = service();
    const task = await tracker.upsertTask({ title: '写插件' });
    await tracker.logTime({ taskId: task.id, minutes: 20 });
    const [entry] = tracker.listTasks()[0]?.timeEntries ?? [];
    await tracker.deleteTimeEntry(String(entry?.id));
    expect(tracker.listTasks()[0]?.timeSpent).toBe(0);
    expect(tracker.listTimeEntries()).toHaveLength(0);
  });

  test('a patch changes only the fields it carries', async () => {
    const tracker = service();
    const task = await tracker.upsertTask({ title: '写插件', dueDay: '2026-01-05' });
    const patched = await tracker.updateTask(task.id, { title: '改过的标题' });
    expect(patched.title).toBe('改过的标题');
    expect(patched.dueDay).toBe('2026-01-05');
    const cleared = await tracker.updateTask(task.id, { dueDay: null });
    expect(cleared.dueDay).toBeUndefined();
  });

  test('a subtask is linked to its parent', async () => {
    const tracker = service();
    const parent = await tracker.upsertTask({ title: '父任务' });
    const child = await tracker.upsertTask({ title: '子任务', parentTaskId: parent.id });
    const updated = tracker.listTasks().find((t) => t.id === parent.id);
    expect(updated?.subTaskIds).toEqual([child.id]);
  });
});

describe('ideas', () => {
  test('an idea travels through its lifecycle', async () => {
    const tracker = service();
    const idea = await tracker.upsertIdea({ title: '一个想法' });
    expect(idea.status).toBe('open');
    const completed = await tracker.completeIdea(idea.id);
    expect(completed.status).toBe('done');
    const reopened = await tracker.reopenIdea(idea.id);
    expect(reopened.status).toBe('open');
    const discarded = await tracker.discardIdea(idea.id);
    expect(discarded.status).toBe('discarded');
  });

  test('a verdict closes an incubating idea', async () => {
    const tracker = service();
    const project = await tracker.createProject({ title: '验证项目' });
    const idea = await tracker.upsertIdea({ title: '一个想法' });
    await tracker.upgradeIdeaToProject(idea.id, project.id, 'ship it');
    const closed = await tracker.closeIdea(idea.id, 'validated', '证据');
    expect(closed.status).toBe('closed');
    expect(closed.verdict?.result).toBe('validated');
  });

  test('upgrading to an unknown project fails loudly', async () => {
    const tracker = service();
    const idea = await tracker.upsertIdea({ title: '一个想法' });
    await expect(tracker.upgradeIdeaToProject(idea.id, 'nope')).rejects.toThrow(/does not exist/);
  });
});

describe('follow-ups', () => {
  test('a follow-up is created, resolved and reopened', async () => {
    const tracker = service();
    const row = await tracker.upsertFollowUp({
      title: '等 ICP 审核',
      nextFollowUpDay: '2026-01-01',
    });
    expect(tracker.dueFollowUps().map((f) => f.id)).toEqual([row.id]);
    await tracker.resolveFollowUp(row.id);
    expect(tracker.dueFollowUps()).toHaveLength(0);
    await tracker.reopenFollowUp(row.id);
    expect(tracker.dueFollowUps()).toHaveLength(1);
  });
});

describe('the snapshot', () => {
  test('it carries everything the browser renders', async () => {
    const tracker = service();
    await tracker.upsertTask({ title: '一' });
    await tracker.upsertIdea({ title: '二' });
    const snapshot = tracker.snapshot();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.ideas).toHaveLength(1);
    expect(snapshot.settings.urgencyThresholdDays).toBe(2);
    expect(snapshot.activeTimer).toBeNull();
  });
});
