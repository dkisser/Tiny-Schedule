import { describe, expect, test } from 'bun:test';
import { toDisplayMessages } from '../src/renderer/src/lib/chatMessages';

describe('toDisplayMessages', () => {
  test('user string message', () => {
    const out = toDisplayMessages([{ role: 'user', content: '你好' }]);
    expect(out).toEqual([{ kind: 'user', text: '你好' }]);
  });

  test('user block content', () => {
    const out = toDisplayMessages([{ role: 'user', content: [{ type: 'text', text: '嗨' }] }]);
    expect(out[0]).toMatchObject({ kind: 'user', text: '嗨' });
  });

  test('assistant text and toolCall blocks', () => {
    const out = toDisplayMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我查一下' },
          { type: 'toolCall', id: 'c1', name: 'queryTasks', arguments: { from: '2026-08-01' } },
        ],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'assistant', text: '我查一下' });
    expect(out[1]).toMatchObject({ kind: 'tool', toolName: 'queryTasks', toolCallId: 'c1' });
  });

  test('toolResult message', () => {
    const out = toDisplayMessages([
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'queryTasks',
        isError: false,
        content: [{ type: 'text', text: '[]' }],
      },
    ]);
    expect(out[0]).toMatchObject({ kind: 'toolResult', toolCallId: 'c1', isError: false });
  });

  test('unknown shapes are skipped', () => {
    expect(toDisplayMessages([null, { foo: 1 }, { role: 'weird' }])).toEqual([]);
  });
});
