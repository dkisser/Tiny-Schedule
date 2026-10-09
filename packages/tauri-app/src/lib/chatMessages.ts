export type DisplayMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; stopReason?: string }
  | { kind: 'tool'; toolCallId: string; toolName: string; args?: unknown }
  | { kind: 'toolResult'; toolCallId: string; isError: boolean; text: string };

interface RawBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface RawMessage {
  role?: string;
  content?: string | RawBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
}

function textOf(content: string | RawBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

export function toDisplayMessages(raw: unknown[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as RawMessage;
    if (m.role === 'user') {
      out.push({ kind: 'user', text: textOf(m.content) });
    } else if (m.role === 'assistant') {
      const text = textOf(m.content);
      // aborted（用户停止）的消息即使文本为空也要渲染，UI 展示占位 + 重试入口
      if (text || m.stopReason === 'aborted') {
        out.push({ kind: 'assistant', text, stopReason: m.stopReason });
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'toolCall' && b.id && b.name) {
          out.push({ kind: 'tool', toolCallId: b.id, toolName: b.name, args: b.arguments });
        }
      }
    } else if (m.role === 'toolResult' && m.toolCallId) {
      out.push({
        kind: 'toolResult',
        toolCallId: m.toolCallId,
        isError: m.isError === true,
        text: textOf(m.content),
      });
    }
  }
  return out;
}
