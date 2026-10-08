import { describe, expect, test } from 'bun:test';
import { AppDataSchema, emptyAppData } from '@tiny-schedule/shared';
import type { DataStore } from '../src/main/infra/dataStore';
import { buildChatTools } from '../src/main/services/chatTools';
import { createProjectService } from '../src/main/services/projectService';
import { createTaskService } from '../src/main/services/taskService';

const logger = { info: () => {}, error: () => {}, warn: () => {} } as never;

/** The tools read through services now (ADR-0003), so build them over a real store. */
function services(data = emptyAppData()) {
  // Parses, as DataStore.save does — see the note on the other store doubles.
  const store = {
    get: () => data,
    update: (fn: (c: typeof data) => typeof data) => AppDataSchema.parse(fn(data)) as typeof data,
  };
  const deps = { store: store as unknown as DataStore, logger };
  return { tasks: createTaskService(deps), projects: createProjectService(deps) };
}

function textOf(result: { content: { type: string; text?: string }[] }): unknown {
  const block = result.content[0];
  return JSON.parse((block as { text: string }).text);
}

describe('buildChatTools', () => {
  test('exposes exactly the three read-only tools', () => {
    const tools = buildChatTools(
      services(emptyAppData()).tasks,
      services(emptyAppData()).projects,
      () => '2026-08-04',
    );
    expect(tools.map((t) => t.name).sort()).toEqual(['getSummary', 'listProjects', 'queryTasks']);
  });

  test('queryTasks tool executes and returns JSON', async () => {
    const data = emptyAppData();
    const tools = buildChatTools(services(data).tasks, services(data).projects, () => '2026-08-04');
    const tool = tools.find((t) => t.name === 'queryTasks');
    if (!tool) throw new Error('missing tool');
    const result = await tool.execute('call1', {}, AbortSignal.timeout(1000), undefined);
    expect(Array.isArray(textOf(result))).toBe(true);
  });

  test('getSummary tool defaults date to today', async () => {
    const data = emptyAppData();
    const tools = buildChatTools(services(data).tasks, services(data).projects, () => '2026-08-04');
    const tool = tools.find((t) => t.name === 'getSummary');
    if (!tool) throw new Error('missing tool');
    const result = await tool.execute(
      'call2',
      { scope: 'today' },
      AbortSignal.timeout(1000),
      undefined,
    );
    const summary = textOf(result) as { range: string };
    expect(summary.range).toContain('2026-08-04');
  });
});
