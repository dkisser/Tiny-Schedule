import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@earendil-works/pi-agent-core';
import { type ToolCallRecord } from '@tiny-schedule/shared';
import type { AuditableTool } from './tools';

/**
 * 审计拦截器：ADR-0008 里"现在就建"的那一层。
 *
 * 对模型而言，注册进 pi-agent-core 的工具就是它对世界的全部接口——它没有别的
 * invoke 通道——所以这一层的拦截是完全中介。这里管四件事，每件都是 ADR 点名的
 * **记录与体验**：审计、计时、错误规整、超长输出截断。真正的强制校验留在 Rust
 * 收口，因为 TS 拦截器挡不住 webview 自身被注入。
 *
 * 唯一入口是 {@link auditTools}。`tools.ts` 的原始工具只能经它变成 AgentTool，
 * 因此"所有工具调用都被记录"是构造上的事实，而不是一条约定。
 */

/** 审计记录里的摘要上限。够人看懂这次调用碰到了什么，又不会把 data.json 撑大。 */
/**
 * 工具结果的形状。`details` 一直是 undefined——工具只交回文本，审计与上下文都用
 * 同一份，所以没有第二个载荷需要类型化。
 */
type ToolResult = AgentToolResult<undefined>;

export const AUDIT_SUMMARY_LIMIT = 500;

/**
 * 回给模型的单次工具结果上限。
 *
 * 与审计上限是两件事：审计存的是"发生了什么"，模型读的是"我能据此做什么"。Rust
 * 侧 exec 允许到 1 MB 输出，原样塞回上下文会顶爆模型窗口，而这次运行真正需要的
 * 通常是尾部而不是全部。
 */
export const TOOL_RESULT_LIMIT = 8_000;

/**
 * 收集一次运行的审计记录。
 *
 * 只增：运行记录是只增的（任务 A 的领域决定），所以这里也只有 append，没有
 * update——能改写的审计就不是审计了。
 */
export interface AuditSink {
  record(entry: Omit<ToolCallRecord, 'at'>): void;
  /** 按发生顺序快照；runner 落库时取的那一份。 */
  entries(): ToolCallRecord[];
}

export function createAuditSink(now: () => number = Date.now): AuditSink {
  const calls: ToolCallRecord[] = [];
  return {
    record(entry) {
      calls.push({ ...entry, at: now() });
    },
    entries() {
      return calls.slice();
    },
  };
}

/**
 * Clips to `limit`, keeping the head **and** the tail.
 *
 * Both ends, because a single-ended clip silently picks the wrong one. Keeping
 * only the head turns a 40 KB compiler log into 8000 characters of warnings: the
 * model reads it, concludes the build passed, and the `error TS2304` it needed
 * is in the 2 KB that were dropped. Keeping only the tail loses the context that
 * says which run this was.
 *
 * The marker states *how much* was dropped, because a bare ellipsis reads as
 * "this is the whole thing" — exactly the wrong conclusion for the one reader
 * the record exists for.
 *
 * A run with two-ended clipping is left alone rather than having its head
 * shortened to make room for a tail: when almost everything fits, the tail adds
 * nothing the head does not already have.
 */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = `…[已截断，共 ${text.length} 字符]`;
  // 3:1 in favour of the head. The head establishes which run this is; the tail
  // carries the error, but a traceback is a handful of lines, not thousands of
  // characters, so it needs far less room than the log it is buried in.
  const budget = limit - marker.length;
  if (budget <= 0) return `${text.slice(0, limit)}${marker}`;
  const headRoom = Math.floor(budget * 0.75);
  const tailRoom = budget - headRoom;
  return `${text.slice(0, headRoom)}${marker}${tailRoom > 0 ? text.slice(text.length - tailRoom) : ''}`;
}

function errorResult(toolName: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `工具 ${toolName} 执行失败：${message}` }],
    details: undefined,
  } as unknown as ToolResult;
}

/**
 * 规整后的错误文本：模型看到的是"这个工具失败了，原因是 X"，而不是一段栈。
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

/** The text of a tool result, which is what both the audit and the model read. */
function readResultText(result: ToolResult): string {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
    )
    .join('\n');
}

/**
 * 把审计目标包成 AgentTool：每次调用前后各记一次。
 *
 * **错误不重抛。** `AgentTool.execute` 的文档说失败应当 throw，但那是对有人盯着
 * 的会话说的：一次工具失败会让 pi-agent-core 中断这一轮对话，把已经拿到的上下文
 * 和部分答案一起丢掉。定时任务是无人值守的——没有人在下一轮给出方向——所以失败
 * 被规整成一条工具结果交回模型，让它自己看到失败原因并换条路走。审计里如实记下
 * 这是失败，两边都不说谎。
 */
export function auditTools(auditable: AuditableTool[], sink: AuditSink): AgentTool[] {
  return auditable.map(({ tool, describe, summarize }) => {
    const wrapped: AgentTool = {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.executionMode !== undefined ? { executionMode: tool.executionMode } : {}),
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
      ): Promise<ToolResult> => {
        const started = Date.now();
        const { target, argsSummary } = describe(params);
        try {
          const result = await tool.execute(toolCallId, params as never, signal, onUpdate as never);
          const text = readResultText(result);
          sink.record({
            id: toolCallId,
            toolName: tool.name,
            argsSummary: truncate(argsSummary, AUDIT_SUMMARY_LIMIT),
            target,
            resultSummary: truncate(summarize(text) || text, AUDIT_SUMMARY_LIMIT),
            durationMs: Date.now() - started,
          });
          // Truncated on the way *out* as well as into the record: the Rust
          // side caps at 1 MB, which would not survive a context window.
          const clipped = truncate(text, TOOL_RESULT_LIMIT);
          return clipped === text
            ? result
            : ({ ...result, content: [{ type: 'text', text: clipped }] } as ToolResult);
        } catch (error) {
          const message = truncate(errorMessage(error), AUDIT_SUMMARY_LIMIT);
          sink.record({
            id: toolCallId,
            toolName: tool.name,
            argsSummary: truncate(argsSummary, AUDIT_SUMMARY_LIMIT),
            target,
            resultSummary: `失败：${message}`,
            durationMs: Date.now() - started,
          });
          return errorResult(tool.name, message);
        }
      },
    };
    return wrapped;
  });
}
