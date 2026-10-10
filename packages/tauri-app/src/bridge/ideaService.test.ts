import { describe, expect, test } from 'bun:test';
import {
  type AppData,
  AppDataSchema,
  emptyAppData,
  type Idea,
  IdeaEditSchema,
  type IdeaStatus,
  type Task,
} from '@tiny-schedule/shared';
import { silentLogger } from '../ai/logger';
import { DataStore } from './dataStore';
import { joinPath, MemoryFs } from './fsAdapter';
import { createIdeaService } from './ideaService';

/**
 * Port of packages/app/tests/ideaService.test.ts onto the Tauri host.
 *
 * The one thing that is *not* a mechanical swap is the store double. The
 * Electron tests passed a hand-written object with a synchronous `update`, and
 * a double is blind in a specific way: it never parses, so a write that
 * AppDataSchema would reject passed green here and only corrupted data.json in
 * production. Here the tests run against the real DataStore over MemoryFs, so
 * every write is validated, backed up and renamed exactly as it is in the app —
 * and the async store means every service call is awaited, including the
 * atomicity assertions, which are what make the conversion and the upgrade
 * trustworthy.
 */

const DIR = '/data';

function dataPath(): string {
  return joinPath(DIR, 'data.json');
}

function idea(over: Partial<Idea> = {}): Idea {
  return {
    id: 'i1',
    title: '写点东西',
    notes: '',
    createdAt: 1,
    status: 'open',
    ...over,
  };
}

function seedData(over: Partial<AppData> = {}): AppData {
  return { ...emptyAppData(), ...over } as AppData;
}

/**
 * A service over a store seeded with `data`, plus the filesystem behind it.
 *
 * The seed goes through AppDataSchema before it is written, so a fixture that
 * could not have come off disk fails here instead of turning into a confusing
 * load-time refusal later in the test.
 */
async function setup(data: AppData = seedData({ ideas: { i1: idea() } })) {
  const fs = new MemoryFs();
  await fs.writeText(dataPath(), JSON.stringify(AppDataSchema.parse(data)));
  const store = await DataStore.open(DIR, fs, silentLogger);
  return {
    fs,
    store,
    service: createIdeaService({ store, logger: silentLogger }),
    /** The dataset now in effect, read back from the store rather than a closure. */
    data: async (): Promise<AppData> => store.get(),
  };
}

/** The dataset as it was last written, straight off disk — "written", not "cached". */
async function onDisk(fs: MemoryFs): Promise<AppData> {
  return JSON.parse(await fs.readText(dataPath())) as AppData;
}

/**
 * How many times data.json was written, counted from the adapter's call log.
 *
 * One persisted write is what "atomic" means here: the store's persist() is a
 * tmp+rename, so every mutation that reaches disk is one crash-safe step. The
 * old store double counted calls instead, which is a proxy for the same thing
 * on a store that could not refuse a write at all.
 */
function writes(fs: MemoryFs): number {
  return fs.calls.filter((call) => call === `writeText:${dataPath()}.tmp`).length;
}

/** Forget the calls made while seeding, so a test measures only its own writes. */
function quiet(fs: MemoryFs): void {
  fs.calls.length = 0;
}

const status = (data: AppData, id = 'i1'): IdeaStatus | undefined => data.ideas[id]?.status;

describe('ideaService.complete', () => {
  test('open → done and stamps resolvedAt', async () => {
    const { service, data } = await setup();
    const r = await service.complete('i1');
    expect(r.ok).toBe(true);
    const d = await data();
    expect(status(d)).toBe('done');
    expect(d.ideas.i1?.resolvedAt).toBeGreaterThan(0);
  });

  test('rejects a non-open idea and leaves it untouched', async () => {
    const { service, data, fs } = await setup(
      seedData({ ideas: { i1: idea({ status: 'converted' }) } }),
    );
    const r = await service.complete('i1');
    expect(r).toEqual({ ok: false, error: 'IDEA_NOT_IN_OPEN' });
    expect(status(await data())).toBe('converted');
    // A domain rejection must not reach the disk at all.
    expect(writes(fs)).toBe(0);
  });

  test('unknown id is a domain rejection, not a throw', async () => {
    const { service } = await setup(seedData());
    expect(await service.complete('nope')).toEqual({
      ok: false,
      error: 'IDEA_NOT_FOUND',
    });
  });
});

describe('ideaService.discard', () => {
  test('open → discarded', async () => {
    const { service, data } = await setup();
    expect((await service.discard('i1')).ok).toBe(true);
    expect(status(await data())).toBe('discarded');
  });

  test('incubating cannot be discarded (it is a committed experiment)', async () => {
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ status: 'incubating' }) } }),
    );
    expect((await service.discard('i1')).ok).toBe(false);
    expect(status(await data())).toBe('incubating');
  });
});

describe('ideaService.reopen — terminal-state guard', () => {
  test('done → open, cleared resolvedAt', async () => {
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ status: 'done', resolvedAt: 5 }) } }),
    );
    await service.reopen('i1');
    const d = await data();
    expect(status(d)).toBe('open');
    expect(d.ideas.i1?.resolvedAt).toBeUndefined();
  });

  test('discarded → open', async () => {
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ status: 'discarded' }) } }),
    );
    expect((await service.reopen('i1')).ok).toBe(true);
    expect(status(await data())).toBe('open');
  });

  test('converted is terminal and cannot be reopened', async () => {
    const { service, data, fs } = await setup(
      seedData({ ideas: { i1: idea({ status: 'converted' }) } }),
    );
    expect(await service.reopen('i1')).toEqual({
      ok: false,
      error: 'IDEA_NOT_REOPENABLE',
    });
    expect(status(await data())).toBe('converted');
    expect(writes(fs)).toBe(0);
  });

  test('closed is terminal and cannot be reopened', async () => {
    const { service, data, fs } = await setup(
      seedData({ ideas: { i1: idea({ status: 'closed' }) } }),
    );
    expect(await service.reopen('i1')).toEqual({
      ok: false,
      error: 'IDEA_NOT_REOPENABLE',
    });
    expect(status(await data())).toBe('closed');
    expect(writes(fs)).toBe(0);
  });
});

describe('ideaService.convertToTask', () => {
  test('creates an Inbox task and marks the idea converted in one write', async () => {
    const { service, data, fs } = await setup(
      seedData({ ideas: { i1: idea({ notes: '背景说明' }) } }),
    );
    quiet(fs);
    const r = await service.convertToTask('i1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // One write means the task and the idea's terminal state can never be
    // half-persisted: a crash cannot leave a task with an idea still sitting
    // in the inbox.
    expect(writes(fs)).toBe(1);
    const d = await data();
    expect(status(d)).toBe('converted');
    const task = d.tasks[r.taskId];
    expect(task?.projectId).toBe('INBOX_PROJECT');
    expect(task?.title).toBe('写点东西');
    expect(task?.notes).toBe('背景说明');
    expect(d.ideas.i1?.convertedTaskId).toBe(r.taskId);
    // And it is on disk, not only in the cache: the async store's whole point
    // is that a returned dataset has to be the one that was written.
    expect((await onDisk(fs)).tasks[r.taskId]?.title).toBe('写点东西');
  });

  test('an explicit title overrides the idea title but keeps the notes', async () => {
    const { service, data } = await setup(seedData({ ideas: { i1: idea({ notes: '背景说明' }) } }));
    const r = await service.convertToTask('i1', '新标题');
    if (!r.ok) throw new Error('expected ok');
    const d = await data();
    expect(d.tasks[r.taskId]?.title).toBe('新标题');
    expect(d.tasks[r.taskId]?.notes).toBe('背景说明');
  });

  test('the task write goes through the stale-timing sweep, in the same write', async () => {
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
      isImportant: false,
      timeEstimate: 0,
      timeSpent: 999,
      timeSpentOnDay: {},
      timeEntries: [],
      notes: '',
      created: 0,
    } satisfies Task;
    const { service, data } = await setup(
      seedData({
        ideas: { i1: idea() },
        tasks: { tdone: doneTask } as AppData['tasks'],
        activeTimer: {
          taskId: 'tdone',
          startedAt: 0,
          accumulatedMs: 0,
          isPaused: false,
        },
      }),
    );
    const r = await service.convertToTask('i1');
    expect(r.ok).toBe(true);
    // The invariant, not the mechanism: no write may leave a done task timed.
    expect((await data()).activeTimer).toBeNull();
  });

  test('a converted idea cannot be converted again', async () => {
    const { service, data, fs } = await setup(
      seedData({ ideas: { i1: idea({ status: 'converted' }) } }),
    );
    quiet(fs);
    expect((await service.convertToTask('i1')).ok).toBe(false);
    expect(Object.keys((await data()).tasks)).toEqual([]);
    expect(writes(fs)).toBe(0);
  });
});

describe('ideaService.upgradeToProject — atomicity', () => {
  test('creates the project and flips the idea in a single store.update', async () => {
    const { service, data, fs } = await setup();
    quiet(fs);
    const r = await service.upgradeToProject('i1', {
      title: '验证一下',
      validationGoal: '有人用',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // One write means a crash can never leave a project with no matching idea
    // transition (the failure mode the old two-IPC renderer orchestration had).
    expect(writes(fs)).toBe(1);
    const d = await data();
    expect(status(d)).toBe('incubating');
    expect(d.projects[r.projectId]?.title).toBe('验证一下');
    expect(d.ideas.i1?.projectId).toBe(r.projectId);
    expect(d.ideas.i1?.validationGoal).toBe('有人用');
    const disk = await onDisk(fs);
    expect(disk.projects[r.projectId]?.title).toBe('验证一下');
    expect(disk.ideas.i1?.status).toBe('incubating');
  });

  test('a non-open idea is rejected and no orphan project is created', async () => {
    const { service, data, fs } = await setup(
      seedData({ ideas: { i1: idea({ status: 'closed' }) } }),
    );
    const before = Object.keys((await data()).projects).length;
    expect((await service.upgradeToProject('i1', { title: 'x' })).ok).toBe(false);
    expect(Object.keys((await data()).projects).length).toBe(before);
    expect(writes(fs)).toBe(0);
  });

  test('the project title is clamped to the shared max length', async () => {
    const { service, data } = await setup();
    const r = await service.upgradeToProject('i1', { title: 'x'.repeat(100) });
    if (!r.ok) throw new Error('expected ok');
    expect((await data()).projects[r.projectId]?.title.length).toBe(32);
  });
});

describe('ideaService.closeWithVerdict', () => {
  test('incubating → closed with a verdict', async () => {
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ status: 'incubating' }) } }),
    );
    expect((await service.closeWithVerdict('i1', 'validated', '成了')).ok).toBe(true);
    const d = await data();
    expect(status(d)).toBe('closed');
    expect(d.ideas.i1?.verdict?.result).toBe('validated');
    expect(d.ideas.i1?.verdict?.text).toBe('成了');
  });

  test('a closed idea can have its verdict revised without changing status', async () => {
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ status: 'closed', resolvedAt: 9 }) } }),
    );
    expect((await service.closeWithVerdict('i1', 'partial')).ok).toBe(true);
    const d = await data();
    expect(status(d)).toBe('closed');
    expect(d.ideas.i1?.verdict?.result).toBe('partial');
  });

  test('an open idea cannot be closed — the verdict must follow an experiment', async () => {
    const { service, data } = await setup();
    expect(await service.closeWithVerdict('i1', 'validated')).toEqual({
      ok: false,
      error: 'IDEA_NOT_CLOSABLE',
    });
    expect(status(await data())).toBe('open');
  });

  test('a converted idea cannot be closed', async () => {
    const { service } = await setup(seedData({ ideas: { i1: idea({ status: 'converted' }) } }));
    expect((await service.closeWithVerdict('i1', 'invalidated')).ok).toBe(false);
  });
});

describe('ideaService.edit — the narrowed write contract', () => {
  test('merges non-status fields and leaves the status alone', async () => {
    // The request carries no status, so an overwrite would silently reset a
    // closed idea back to open. Merge is what makes the narrowing safe.
    const { service, data } = await setup(
      seedData({
        ideas: {
          i1: idea({
            status: 'closed',
            verdict: { result: 'validated', closedAt: 1 },
          }),
        },
      }),
    );
    await service.edit({ id: 'i1', title: '改个名', notes: 'n', createdAt: 1 });
    const d = await data();
    expect(d.ideas.i1?.title).toBe('改个名');
    expect(d.ideas.i1?.status).toBe('closed');
    expect(d.ideas.i1?.verdict?.result).toBe('validated');
  });

  test('a new idea lands in the open inbox', async () => {
    const { service, data } = await setup(seedData());
    await service.edit({ id: 'i9', title: '新想法', notes: '', createdAt: 5 });
    expect((await data()).ideas.i9?.status).toBe('open');
  });

  test('the stored status survives an edit that omits timeline', async () => {
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ status: 'incubating' }) } }),
    );
    await service.edit({ id: 'i1', title: 't', notes: '', createdAt: 1 });
    expect((await data()).ideas.i1?.status).toBe('incubating');
  });

  test('a converted idea keeps its task link across a title edit', async () => {
    const { service, data } = await setup(
      seedData({
        ideas: {
          i1: idea({
            status: 'converted',
            convertedAt: 1,
            convertedTaskId: 't9',
          }),
        },
      }),
    );
    await service.edit({ id: 'i1', title: '改名', notes: '', createdAt: 1 });
    expect((await data()).ideas.i1?.convertedTaskId).toBe('t9');
  });

  test('a present-but-undefined optional key does not erase the stored value', async () => {
    // The wire path is what makes this bite: the renderer builds the payload
    // literally (`validationGoal: idea.validationGoal`), so the key is always
    // present, and zod hands back undefined for it when unset. A plain
    // `{ ...stored, ...patch }` therefore wiped the stored value on every
    // unrelated title edit — and the service-level tests missed it because
    // they call edit() directly, past the zod boundary.
    const { service, data } = await setup(
      seedData({
        ideas: {
          i1: idea({
            validationGoal: '验证一下',
            timeline: [{ id: 'e1', createdAt: 1, text: '记' }],
          }),
        },
      }),
    );
    const patch = IdeaEditSchema.parse({
      id: 'i1',
      title: '只改标题',
      notes: '',
      createdAt: 1,
      validationGoal: undefined,
    });
    // Prove the fixture reproduces what zod actually hands the service.
    expect('validationGoal' in patch).toBe(true);
    expect(patch.validationGoal).toBeUndefined();
    await service.edit(patch);
    const d = await data();
    expect(d.ideas.i1?.validationGoal).toBe('验证一下');
    expect(d.ideas.i1?.title).toBe('只改标题');
  });

  test('a timeline smuggled into a field edit is stripped by the schema', async () => {
    // The wire no longer accepts the field at all, so the whole-list rollback
    // is not merely discouraged by convention — it cannot be expressed.
    const parsed = IdeaEditSchema.parse({
      id: 'i1',
      title: 't',
      notes: '',
      createdAt: 1,
      timeline: [{ id: 'e9', createdAt: 1, text: '偷带' }],
    });
    expect(Object.keys(parsed)).toEqual(['id', 'title', 'notes', 'createdAt']);
  });

  test('an omitted optional field is left alone', async () => {
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ validationGoal: '验证一下' }) } }),
    );
    await service.edit({ id: 'i1', title: 't', notes: '', createdAt: 1 });
    expect((await data()).ideas.i1?.validationGoal).toBe('验证一下');
  });

  test('an explicit null clears the field', async () => {
    // Clearing has to stay expressible. Encoding it as `undefined` would have
    // collided with "leave it alone" and made the field unclearable — and
    // emptying the 验证目标 input in the UI is exactly that call.
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ validationGoal: '验证一下' }) } }),
    );
    const patch = IdeaEditSchema.parse({
      id: 'i1',
      title: 't',
      notes: '',
      createdAt: 1,
      validationGoal: null,
    });
    await service.edit(patch);
    const d = await data();
    expect(d.ideas.i1?.validationGoal).toBeUndefined();
    // The key is gone, not set to undefined, so the idea really has no goal.
    expect('validationGoal' in (d.ideas.i1 as object)).toBe(false);
  });

  test('clearing one optional field leaves the other stored fields intact', async () => {
    const { service, data } = await setup(
      seedData({
        ideas: {
          i1: idea({
            validationGoal: '验证一下',
            timeline: [{ id: 'e1', createdAt: 1, text: '记' }],
          }),
        },
      }),
    );
    await service.edit({
      id: 'i1',
      title: 't',
      notes: '',
      createdAt: 1,
      validationGoal: null,
    });
    const d = await data();
    expect(d.ideas.i1?.validationGoal).toBeUndefined();
    expect(d.ideas.i1?.timeline).toHaveLength(1);
  });

  test('a scalar edit leaves the timeline and the status untouched', async () => {
    const { service, data } = await setup(
      seedData({
        ideas: {
          i1: idea({
            status: 'incubating',
            timeline: [{ id: 'e1', createdAt: 1, text: '记一笔' }],
          }),
        },
      }),
    );
    await service.edit({ id: 'i1', title: 'x', notes: '', createdAt: 1 });
    const d = await data();
    expect(d.ideas.i1?.timeline).toHaveLength(1);
    expect(d.ideas.i1?.status).toBe('incubating');
  });
});

describe('ideaService timeline commands — the list is edited on the host side', () => {
  // A field edit used to carry the renderer's whole snapshot of the timeline,
  // so a debounced title commit landing after an entry was added silently
  // rolled the list back. The commands apply append/update/delete to the
  // *stored* idea, which makes list edits and scalar edits independent.
  const entry = (id: string, text: string) => ({ id, createdAt: 1, text });

  test('addEntry appends to the stored timeline', async () => {
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ timeline: [entry('e1', '第一条')] }) } }),
    );
    const r = await service.addEntry('i1', '第二条');
    expect(r.ok).toBe(true);
    expect((await data()).ideas.i1?.timeline?.map((e) => e.text)).toEqual(['第一条', '第二条']);
  });

  test('updateEntry rewrites one entry and leaves the others alone', async () => {
    const { service, data } = await setup(
      seedData({
        ideas: {
          i1: idea({ timeline: [entry('e1', '一'), entry('e2', '二')] }),
        },
      }),
    );
    await service.updateEntry('i1', 'e2', '改过的二');
    expect((await data()).ideas.i1?.timeline?.map((e) => e.text)).toEqual(['一', '改过的二']);
  });

  test('deleteEntry removes just the named entry', async () => {
    const { service, data } = await setup(
      seedData({
        ideas: {
          i1: idea({ timeline: [entry('e1', '一'), entry('e2', '二')] }),
        },
      }),
    );
    await service.deleteEntry('i1', 'e1');
    expect((await data()).ideas.i1?.timeline?.map((e) => e.id)).toEqual(['e2']);
  });

  test('a missing idea is a rejection, not a throw', async () => {
    const { service } = await setup(seedData());
    expect(await service.addEntry('nope', 'x')).toEqual({
      ok: false,
      error: 'IDEA_NOT_FOUND',
    });
    expect(await service.deleteEntry('nope', 'e1')).toEqual({
      ok: false,
      error: 'IDEA_NOT_FOUND',
    });
  });

  test('a scalar edit cannot roll back a concurrently added entry', async () => {
    // The regression, end to end: the stored timeline gains an entry, then a
    // title edit arrives. The wire no longer permits the edit to carry a
    // timeline at all, so there is nothing for it to roll back.
    const { service, data } = await setup(
      seedData({ ideas: { i1: idea({ timeline: [entry('e1', '一')] }) } }),
    );
    await service.addEntry('i1', '第二条');
    const patch = IdeaEditSchema.parse({
      id: 'i1',
      title: '改标题',
      notes: '',
      createdAt: 1,
    });
    // A stray timeline is stripped by the schema, not merged — the field is
    // gone from IdeaEditSchema, so a caller that still sends one loses it.
    const smuggled = IdeaEditSchema.parse({
      ...patch,
      timeline: [entry('e9', '偷带')],
    });
    expect(Object.keys(smuggled)).toEqual(['id', 'title', 'notes', 'createdAt']);
    await service.edit(patch);
    const d = await data();
    expect(d.ideas.i1?.timeline?.map((e) => e.text)).toEqual(['一', '第二条']);
    expect(d.ideas.i1?.title).toBe('改标题');
  });
});
