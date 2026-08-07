import { describe, expect, test } from 'bun:test';
import { emptyAppData } from '@tiny-schedule/shared';
import { buildChatTools } from '../src/main/ai/chatAgentTools';

function textOf(result: { content: { type: string; text?: string }[] }): unknown {
  const block = result.content[0];
  return JSON.parse((block as { text: string }).text);
}

describe('buildChatTools', () => {
  test('exposes exactly the three read-only tools', () => {
    const tools = buildChatTools(
      () => emptyAppData(),
      () => '2026-08-04',
    );
    expect(tools.map((t) => t.name).sort()).toEqual(['getSummary', 'listProjects', 'queryTasks']);
  });

  test('queryTasks tool executes and returns JSON', async () => {
    const data = emptyAppData();
    const tools = buildChatTools(
      () => data,
      () => '2026-08-04',
    );
    const tool = tools.find((t) => t.name === 'queryTasks');
    if (!tool) throw new Error('missing tool');
    const result = await tool.execute('call1', {}, AbortSignal.timeout(1000), undefined);
    expect(Array.isArray(textOf(result))).toBe(true);
  });

  test('getSummary tool defaults date to today', async () => {
    const data = emptyAppData();
    const tools = buildChatTools(
      () => data,
      () => '2026-08-04',
    );
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
