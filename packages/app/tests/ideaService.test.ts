import { describe, expect, test } from 'bun:test';
import {
  type AppData,
  appendIdeaEntry,
  emptyAppData,
  type Idea,
  IdeaEditSchema,
  type IdeaStatus,
  type Task,
} from '@tiny-schedule/shared';
import type { DataStore } from '../src/main/infra/dataStore';
import { createIdeaService } from '../src/main/services/ideaService';

const logger = { info: () => {}, error: () => {}, warn: () => {} } as never;

function idea(over: Partial<Idea> = {}): Idea {
  return { id: 'i1', title: '写点东西', notes: '', createdAt: 1, status: 'open', ...over };
}

function setup(ideas: Record<string, Idea> = { i1: idea() }) {
  const data: AppData = { ...emptyAppData(), ideas };
  const store = {
    get: () => data,
    update: (fn: (c: AppData) => AppData) => {
      Object.assign(data, fn(data));
      return data;
    },
  } as unknown as DataStore;
  return { data, service: createIdeaService({ store, logger }) };
}

/** 记录每次 store.update 的次数：原子性断言靠它，而不是靠实现细节。 */
function countingSetup(ideas: Record<string, Idea>) {
  const data: AppData = { ...emptyAppData(), ideas };
  let writes = 0;
  const store = {
    get: () => data,
    update: (fn: (c: AppData) => AppData) => {
      writes += 1;
      Object.assign(data, fn(data));
      return data;
    },
  } as unknown as DataStore;
  return { data, service: createIdeaService({ store, logger }), writes: () => writes };
}

const status = (data: AppData, id = 'i1'): IdeaStatus | undefined => data.ideas[id]?.status;

describe('ideaService.complete', () => {
  test('open → done and stamps resolvedAt', () => {
    const { data, service } = setup();
    const r = service.complete('i1');
    expect(r.ok).toBe(true);
    expect(status(data)).toBe('done');
    expect(data.ideas.i1?.resolvedAt).toBeGreaterThan(0);
  });

  test('rejects a non-open idea and leaves it untouched', () => {
    const { data, service } = setup({ i1: idea({ status: 'converted' }) });
    const r = service.complete('i1');
    expect(r).toEqual({ ok: false, error: 'IDEA_NOT_IN_OPEN' });
    expect(status(data)).toBe('converted');
  });

  test('unknown id is a domain rejection, not a throw', () => {
    const { service } = setup({});
    expect(service.complete('nope')).toEqual({ ok: false, error: 'IDEA_NOT_FOUND' });
  });
});

describe('ideaService.discard', () => {
  test('open → discarded', () => {
    const { data, service } = setup();
    expect(service.discard('i1').ok).toBe(true);
    expect(status(data)).toBe('discarded');
  });

  test('incubating cannot be discarded (it is a committed experiment)', () => {
    const { data, service } = setup({ i1: idea({ status: 'incubating' }) });
    expect(service.discard('i1').ok).toBe(false);
    expect(status(data)).toBe('incubating');
  });
});

describe('ideaService.reopen — terminal-state guard', () => {
  test('done → open, cleared resolvedAt', () => {
    const { data, service } = setup({ i1: idea({ status: 'done', resolvedAt: 5 }) });
    expect(service.reopen('i1').ok).toBe(true);
    expect(status(data)).toBe('open');
    expect(data.ideas.i1?.resolvedAt).toBeUndefined();
  });

  test('discarded → open', () => {
    const { data, service } = setup({ i1: idea({ status: 'discarded' }) });
    expect(service.reopen('i1').ok).toBe(true);
    expect(status(data)).toBe('open');
  });

  test('converted is terminal and cannot be reopened', () => {
    const { data, service } = setup({ i1: idea({ status: 'converted' }) });
    expect(service.reopen('i1')).toEqual({ ok: false, error: 'IDEA_NOT_REOPENABLE' });
    expect(status(data)).toBe('converted');
  });

  test('closed is terminal and cannot be reopened', () => {
    const { data, service } = setup({ i1: idea({ status: 'closed' }) });
    expect(service.reopen('i1')).toEqual({ ok: false, error: 'IDEA_NOT_REOPENABLE' });
    expect(status(data)).toBe('closed');
  });
});

describe('ideaService.convertToTask', () => {
  test('creates an Inbox task and marks the idea converted in one write', () => {
    const { data, service, writes } = countingSetup({ i1: idea({ notes: '背景说明' }) });
    const r = service.convertToTask('i1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(writes()).toBe(1);
    expect(status(data)).toBe('converted');
    const task = data.tasks[r.taskId];
    expect(task?.projectId).toBe('INBOX_PROJECT');
    expect(task?.title).toBe('写点东西');
    expect(task?.notes).toBe('背景说明');
    expect(data.ideas.i1?.convertedTaskId).toBe(r.taskId);
  });

  test('an explicit title overrides the idea title but keeps the notes', () => {
    const { data, service } = setup({ i1: idea({ notes: '背景说明' }) });
    const r = service.convertToTask('i1', '新标题');
    if (!r.ok) throw new Error('expected ok');
    expect(data.tasks[r.taskId]?.title).toBe('新标题');
    expect(data.tasks[r.taskId]?.notes).toBe('背景说明');
  });

  test('the task write goes through the stale-timing sweep, in the same write', () => {
    // Splicing d.tasks directly skipped upsertTaskWithTiming, and with it the
    // dropStaleTiming sweep that ends every task write. A done task holding an
    // activeTimer then survived the conversion, and the eventual settle billed
    // time onto an already-finished task (ADR-0002's enforcement point).
    const doneTask = {
      id: 'tdone',
      title: '已完成',
      projectId: 'INBOX_PROJECT',
      tagIds: [],
      subTaskIds: [],
      isDone: true,
      timeEstimate: 0,
      timeSpent: 999,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 0,
    } satisfies Task;
    const data: AppData = {
      ...emptyAppData(),
      ideas: { i1: idea() },
      tasks: { tdone: doneTask },
      activeTimer: { taskId: 'tdone', startedAt: 0, accumulatedMs: 0, isPaused: false },
    };
    const store = {
      get: () => data,
      update: (fn: (c: AppData) => AppData) => {
        Object.assign(data, fn(data));
        return data;
      },
    } as unknown as DataStore;
    const service = createIdeaService({ store, logger });
    const r = service.convertToTask('i1');
    expect(r.ok).toBe(true);
    // The invariant, not the mechanism: no write may leave a done task timed.
    expect(data.activeTimer).toBeNull();
  });

  test('a converted idea cannot be converted again', () => {
    const { data, service } = setup({ i1: idea({ status: 'converted' }) });
    expect(service.convertToTask('i1').ok).toBe(false);
    expect(Object.keys(data.tasks)).toEqual([]);
  });
});

describe('ideaService.upgradeToProject — atomicity', () => {
  test('creates the project and flips the idea in a single store.update', () => {
    const { data, service, writes } = countingSetup({ i1: idea() });
    const r = service.upgradeToProject('i1', { title: '验证一下', validationGoal: '有人用' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // One write means a crash can never leave a project with no matching idea
    // transition (the failure mode the old two-IPC renderer orchestration had).
    expect(writes()).toBe(1);
    expect(status(data)).toBe('incubating');
    expect(data.projects[r.projectId]?.title).toBe('验证一下');
    expect(data.ideas.i1?.projectId).toBe(r.projectId);
    expect(data.ideas.i1?.validationGoal).toBe('有人用');
  });

  test('a non-open idea is rejected and no orphan project is created', () => {
    const { data, service, writes } = countingSetup({ i1: idea({ status: 'closed' }) });
    const before = Object.keys(data.projects).length;
    expect(service.upgradeToProject('i1', { title: 'x' }).ok).toBe(false);
    expect(Object.keys(data.projects).length).toBe(before);
    expect(writes()).toBe(0);
  });

  test('the project title is clamped to the shared max length', () => {
    const { data, service } = setup({ i1: idea() });
    const r = service.upgradeToProject('i1', { title: 'x'.repeat(100) });
    if (!r.ok) throw new Error('expected ok');
    expect(data.projects[r.projectId]?.title.length).toBe(32);
  });
});

describe('ideaService.closeWithVerdict', () => {
  test('incubating → closed with a verdict', () => {
    const { data, service } = setup({ i1: idea({ status: 'incubating' }) });
    expect(service.closeWithVerdict('i1', 'validated', '成了').ok).toBe(true);
    expect(status(data)).toBe('closed');
    expect(data.ideas.i1?.verdict?.result).toBe('validated');
    expect(data.ideas.i1?.verdict?.text).toBe('成了');
  });

  test('a closed idea can have its verdict revised without changing status', () => {
    const { data, service } = setup({
      i1: idea({ status: 'closed', resolvedAt: 9 }),
    });
    expect(service.closeWithVerdict('i1', 'partial').ok).toBe(true);
    expect(status(data)).toBe('closed');
    expect(data.ideas.i1?.verdict?.result).toBe('partial');
  });

  test('an open idea cannot be closed — the verdict must follow an experiment', () => {
    const { data, service } = setup({ i1: idea() });
    expect(service.closeWithVerdict('i1', 'validated')).toEqual({
      ok: false,
      error: 'IDEA_NOT_CLOSABLE',
    });
    expect(status(data)).toBe('open');
  });

  test('a converted idea cannot be closed', () => {
    const { service } = setup({ i1: idea({ status: 'converted' }) });
    expect(service.closeWithVerdict('i1', 'invalidated').ok).toBe(false);
  });
});

describe('ideaService.edit — the narrowed write contract', () => {
  test('merges non-status fields and leaves the status alone', () => {
    // The request carries no status, so an overwrite would silently reset a
    // closed idea back to open. Merge is what makes the narrowing safe.
    const { data, service } = setup({
      i1: idea({ status: 'closed', verdict: { result: 'validated', closedAt: 1 } }),
    });
    service.edit({ id: 'i1', title: '改个名', notes: 'n', createdAt: 1 });
    expect(data.ideas.i1?.title).toBe('改个名');
    expect(data.ideas.i1?.status).toBe('closed');
    expect(data.ideas.i1?.verdict?.result).toBe('validated');
  });

  test('a new idea lands in the open inbox', () => {
    const { data, service } = setup({});
    service.edit({ id: 'i9', title: '新想法', notes: '', createdAt: 5 });
    expect(data.ideas.i9?.status).toBe('open');
  });

  test('the stored status survives an edit that omits timeline', () => {
    const { data, service } = setup({ i1: idea({ status: 'incubating' }) });
    service.edit({ id: 'i1', title: 't', notes: '', createdAt: 1 });
    expect(data.ideas.i1?.status).toBe('incubating');
  });

  test('a converted idea keeps its task link across a title edit', () => {
    const { data, service } = setup({
      i1: idea({ status: 'converted', convertedAt: 1, convertedTaskId: 't9' }),
    });
    service.edit({ id: 'i1', title: '改名', notes: '', createdAt: 1 });
    expect(data.ideas.i1?.convertedTaskId).toBe('t9');
  });

  test('a present-but-undefined optional key does not erase the stored value', () => {
    // The wire path is what makes this bite: the renderer builds the payload
    // literally (`validationGoal: idea.validationGoal, timeline: ...`), so the
    // keys are always present, and zod hands back undefined for the unset
    // ones. A plain `{ ...stored, ...patch }` therefore wiped the timeline on
    // every unrelated title edit — and the service-level tests missed it
    // because they call edit() directly, past the zod boundary.
    const stored = idea({ timeline: [{ id: 'e1', createdAt: 1, text: '记一笔' }] });
    const { data, service } = setup({ i1: stored });
    const patch = IdeaEditSchema.parse({
      id: 'i1',
      title: '只改标题',
      notes: '',
      createdAt: 1,
      timeline: undefined,
      validationGoal: undefined,
    });
    // Prove the fixture reproduces what zod actually hands the service.
    expect('timeline' in patch).toBe(true);
    service.edit(patch);
    expect(data.ideas.i1?.timeline).toHaveLength(1);
    expect(data.ideas.i1?.title).toBe('只改标题');
  });

  test('an omitted optional field is left alone', () => {
    const { data, service } = setup({
      i1: idea({ validationGoal: '验证一下' }),
    });
    service.edit({ id: 'i1', title: 't', notes: '', createdAt: 1 });
    expect(data.ideas.i1?.validationGoal).toBe('验证一下');
  });

  test('an explicit null clears the field', () => {
    // Clearing has to stay expressible. Encoding it as `undefined` would have
    // collided with "leave it alone" and made the field unclearable — and
    // emptying the 验证目标 input in the UI is exactly that call.
    const { data, service } = setup({
      i1: idea({ validationGoal: '验证一下' }),
    });
    const patch = IdeaEditSchema.parse({
      id: 'i1',
      title: 't',
      notes: '',
      createdAt: 1,
      validationGoal: null,
    });
    service.edit(patch);
    expect(data.ideas.i1?.validationGoal).toBeUndefined();
    // The key is gone, not set to undefined, so the idea really has no goal.
    expect('validationGoal' in (data.ideas.i1 as object)).toBe(false);
  });

  test('clearing one optional field leaves the other stored fields intact', () => {
    const { data, service } = setup({
      i1: idea({ validationGoal: '验证一下', timeline: [{ id: 'e1', createdAt: 1, text: '记' }] }),
    });
    service.edit({ id: 'i1', title: 't', notes: '', createdAt: 1, validationGoal: null });
    expect(data.ideas.i1?.validationGoal).toBeUndefined();
    expect(data.ideas.i1?.timeline).toHaveLength(1);
  });

  test('editing the timeline leaves the status untouched', () => {
    const { data, service } = setup({ i1: idea({ status: 'incubating' }) });
    const appended = appendIdeaEntry(data.ideas.i1 as Idea, '中途想了想');
    service.edit({
      id: 'i1',
      title: 'x',
      notes: '',
      createdAt: 1,
      timeline: appended.timeline,
    });
    expect(data.ideas.i1?.timeline).toHaveLength(1);
    expect(data.ideas.i1?.status).toBe('incubating');
  });
});

describe('ideaService timeline commands — the list is edited on the main side', () => {
  // A field edit used to carry the renderer's whole snapshot of the timeline,
  // so a debounced title commit landing after an entry was added silently
  // rolled the list back. The commands apply append/update/delete to the
  // *stored* idea, which makes list edits and scalar edits independent.
  const entry = (id: string, text: string) => ({ id, createdAt: 1, text });

  test('addEntry appends to the stored timeline', () => {
    const { data, service } = setup({ i1: idea({ timeline: [entry('e1', '第一条')] }) });
    const r = service.addEntry('i1', '第二条');
    expect(r.ok).toBe(true);
    expect(data.ideas.i1?.timeline?.map((e) => e.text)).toEqual(['第一条', '第二条']);
  });

  test('updateEntry rewrites one entry and leaves the others alone', () => {
    const { data, service } = setup({
      i1: idea({ timeline: [entry('e1', '一'), entry('e2', '二')] }),
    });
    service.updateEntry('i1', 'e2', '改过的二');
    expect(data.ideas.i1?.timeline?.map((e) => e.text)).toEqual(['一', '改过的二']);
  });

  test('deleteEntry removes just the named entry', () => {
    const { data, service } = setup({
      i1: idea({ timeline: [entry('e1', '一'), entry('e2', '二')] }),
    });
    service.deleteEntry('i1', 'e1');
    expect(data.ideas.i1?.timeline?.map((e) => e.id)).toEqual(['e2']);
  });

  test('a missing idea is a rejection, not a throw', () => {
    const { service } = setup({});
    expect(service.addEntry('nope', 'x')).toEqual({ ok: false, error: 'IDEA_NOT_FOUND' });
    expect(service.deleteEntry('nope', 'e1')).toEqual({ ok: false, error: 'IDEA_NOT_FOUND' });
  });

  test('a scalar edit does not roll back a concurrently added entry', () => {
    // The regression, end to end: the stored timeline gains an entry, then a
    // title edit arrives carrying the renderer's older snapshot.
    const { data, service } = setup({ i1: idea({ timeline: [entry('e1', '一')] }) });
    service.addEntry('i1', '第二条');
    const staleSnapshot = { id: 'i1', title: '改标题', notes: '', createdAt: 1 };
    const patch = IdeaEditSchema.parse({ ...staleSnapshot, timeline: undefined });
    service.edit(patch);
    expect(data.ideas.i1?.timeline?.map((e) => e.text)).toEqual(['一', '第二条']);
    expect(data.ideas.i1?.title).toBe('改标题');
  });
});
