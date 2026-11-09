import { describe, expect, test } from 'bun:test';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { TaskTrackerService } from '../src/service/service.ts';
import { registerTools } from '../src/tools/index.ts';
import { createFakeDomain } from './helpers/fakeDomain.ts';

const EXPECTED_TOOLS = [
  'ts_query_tasks',
  'ts_get_summary',
  'ts_list_projects',
  'ts_list_tags',
  'ts_upsert_task',
  'ts_complete_task',
  'ts_uncomplete_task',
  'ts_delete_task',
  'ts_set_task_order',
  'ts_log_time',
  'ts_start_timer',
  'ts_pause_timer',
  'ts_resume_timer',
  'ts_stop_timer',
  'ts_finish_day',
  'ts_idea_create',
  'ts_idea_complete',
  'ts_idea_discard',
  'ts_idea_close',
  'ts_idea_upgrade_project',
  'ts_list_ideas',
  'ts_upsert_followup',
  'ts_resolve_followup',
  'ts_list_followups',
];

async function harness(): Promise<{
  ctx: Context;
  tracker: TaskTrackerService;
  dispose: () => void;
  registered: ReturnType<typeof registerTools>;
}> {
  const ctx = new Context();
  // The tool runtime only needs the system prompt's two registration seams.
  ctx.provide('systemPrompt', {
    tools: () => {},
    section: () => {},
  } as never);
  await ctx.plugin(ToolRuntime, {} as never);
  const tracker = new TaskTrackerService(createFakeDomain().domain);
  const registered = registerTools(ctx, tracker);
  return { ctx, tracker, dispose: registered.dispose, registered };
}

describe('the tool surface', () => {
  test('every planned tool is registered under its own name', async () => {
    const { ctx, dispose, registered } = await harness();
    for (const name of EXPECTED_TOOLS) {
      expect(ctx.tools.get(name)).toBeDefined();
    }
    expect(registered.names).toEqual(EXPECTED_TOOLS);
    dispose();
  });

  test('every tool carries a description, a parameter schema and an output renderer', async () => {
    const { ctx, dispose } = await harness();
    for (const name of EXPECTED_TOOLS) {
      const tool = ctx.tools.get(name);
      expect(tool?.description.length ?? 0).toBeGreaterThan(20);
      expect(tool?.parameters).toBeDefined();
      expect(typeof tool?.output.render).toBe('function');
    }
    dispose();
  });

  test('the tools unregister when the plugin is disposed', async () => {
    const { ctx, dispose } = await harness();
    dispose();
    expect(ctx.tools.get('ts_query_tasks')).toBeUndefined();
  });
});

describe('tool behaviour', () => {
  test('invalid arguments are rejected before the tool runs', async () => {
    const { ctx, dispose } = await harness();
    const tool = ctx.tools.get('ts_upsert_task');
    await expect(tool?.execute({ title: 42 }, {} as never)).rejects.toThrow();
    dispose();
  });

  test('a missing required argument is rejected', async () => {
    const { ctx, dispose } = await harness();
    const tool = ctx.tools.get('ts_upsert_task');
    await expect(tool?.execute({}, {} as never)).rejects.toThrow();
    dispose();
  });

  test('querying returns the open tasks with their derived state', async () => {
    const { ctx, tracker, dispose } = await harness();
    await tracker.upsertTask({ title: '写插件', dueDay: '2099-01-01', isImportant: true });
    const tool = ctx.tools.get('ts_query_tasks');
    const result = (await tool?.execute({}, {} as never)) as {
      count: number;
      tasks: { title: string; important: boolean }[];
    };
    expect(result.count).toBe(1);
    expect(result.tasks[0]?.title).toBe('写插件');
    expect(result.tasks[0]?.important).toBe(true);
    dispose();
  });

  test('a task can be created and completed through the tools', async () => {
    const { ctx, tracker, dispose } = await harness();
    const upsert = ctx.tools.get('ts_upsert_task');
    const created = (await upsert?.execute({ title: '写插件' }, {} as never)) as { id: string };
    expect(created.id).toBeDefined();
    const complete = ctx.tools.get('ts_complete_task');
    await complete?.execute({ id: created.id }, {} as never);
    expect(tracker.listTasks()[0]?.isDone).toBe(true);
    dispose();
  });

  test('the summary reports the open and done counts', async () => {
    const { ctx, tracker, dispose } = await harness();
    const task = await tracker.upsertTask({ title: '写插件' });
    await tracker.setTaskDone(task.id, true);
    const summary = ctx.tools.get('ts_get_summary');
    const result = (await summary?.execute({ scope: 'today' }, {} as never)) as {
      open: number;
      done: number;
    };
    expect(result.done).toBe(1);
    dispose();
  });

  test('the renderer turns a result into readable text', async () => {
    const { ctx, dispose } = await harness();
    const tool = ctx.tools.get('ts_list_tags');
    const blocks = tool?.output.render({}, { count: 0, tags: [] });
    expect(Array.isArray(blocks)).toBe(true);
    expect(String((blocks as { text?: string }[])[0]?.text ?? '')).toContain('tag');
    dispose();
  });
});
