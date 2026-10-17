import { describe, expect, test } from 'bun:test';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { emptyAppData } from '@tiny-schedule/shared';
import {
  AUDIT_SUMMARY_LIMIT,
  auditTools,
  createAuditSink,
  TOOL_RESULT_LIMIT,
  truncate,
} from './interceptor';
import { buildScheduledTools, type InvokeFn } from './tools';

/** Records every invoke so a test can assert what crossed the gateway boundary. */
function recordingInvoke(
  outcome: unknown = { exitCode: 0, stdout: 'ok', stderr: '' },
): InvokeFn & { calls: { cmd: string; args?: Record<string, unknown> }[] } {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const fn = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as unknown as InvokeFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function deps(invoke: InvokeFn) {
  return {
    workingDirectory: '/repo',
    context: { taskId: 'st1', runId: 'run1' },
    invoke,
    getData: () => emptyAppData(),
    today: () => '2026-10-17',
  };
}

function call(tool: AgentTool, params: unknown): Promise<unknown> {
  return tool.execute('tc1', params as never);
}

describe('the gateway tools — ADR-0008: 每一次调用都带 taskId/runId', () => {
  test('each tool invokes its own Rust command, carrying the caller identity', async () => {
    const invoke = recordingInvoke({ exitCode: 0, stdout: '', stderr: '' });
    const sink = createAuditSink();
    const tools = auditTools(buildScheduledTools(deps(invoke)), sink);
    const byName = new Map(tools.map((t) => [t.name, t]));

    await call(byName.get('runCommand') as AgentTool, { command: 'git', args: ['log'] });
    await call(byName.get('httpRequest') as AgentTool, { url: 'https://example.com/x' });
    await call(byName.get('writeFile') as AgentTool, { path: 'a.txt', content: 'hello' });
    await call(byName.get('readFile') as AgentTool, { path: 'a.txt' });

    // Spelled out rather than imported from a table: these literals are what
    // `scripts/check-ipc-literals.ts` matches against lib.rs, and a table would
    // make the test agree with whatever the code says instead of with the host.
    expect(invoke.calls.map((c) => c.cmd)).toEqual([
      'scheduled_exec',
      'scheduled_http_request',
      'scheduled_write_file',
      'scheduled_read_file',
    ]);
    // Not "currently unused but carried along": this is the only anchor the
    // Rust entry points have for who is asking. Tauri names args by parameter —
    // the commands take a single `request` struct, so that must be the only key.
    for (const entry of invoke.calls) {
      expect(Object.keys(entry.args ?? {})).toEqual(['request']);
      const request = entry.args?.request as Record<string, unknown>;
      expect(request?.taskId).toBe('st1');
      expect(request?.runId).toBe('run1');
    }
  });

  test("runCommand runs in the task's working directory, not one the model chose", async () => {
    // The recorded cwd is what "where did this run execute" has to answer. If
    // the model could set it, the audit would be recording its claim rather
    // than the fact.
    const invoke = recordingInvoke({ exitCode: 0, stdout: '', stderr: '' });
    const sink = createAuditSink();
    const tools = auditTools(buildScheduledTools(deps(invoke)), sink);
    const runCommand = tools.find((t) => t.name === 'runCommand') as AgentTool;

    await call(runCommand, { command: 'ls', args: [], cwd: '/etc' });

    const request = invoke.calls[0]?.args?.request as Record<string, unknown>;
    expect(request?.cwd).toBe('/repo');
    expect(sink.entries()[0]?.target).toBe('/repo');
  });

  test("the file tools carry the task's working directory too", async () => {
    // 「相对路径相对于执行目录」是这两个工具对模型许下的承诺。不把 cwd 发过去，
    // 相对路径就落在应用碰巧启动的那个目录里，而记录里看不出差别。
    const invoke = recordingInvoke({ path: 'a.txt', bytesWritten: 1 });
    const tools = auditTools(buildScheduledTools(deps(invoke)), createAuditSink());

    await call(tools.find((t) => t.name === 'writeFile') as AgentTool, {
      path: 'notes.md',
      content: 'x',
    });
    await call(tools.find((t) => t.name === 'readFile') as AgentTool, { path: 'notes.md' });

    for (const c of invoke.calls) {
      const request = c.args?.request as Record<string, unknown>;
      expect(request?.cwd).toBe('/repo');
    }
  });

  test("the three app-data tools come along, so a prompt can read the user's own data", async () => {
    const tools = auditTools(buildScheduledTools(deps(recordingInvoke())), createAuditSink());
    // 这个列表同时是一道闸：定时运行能碰到的东西就这么多。往里加名字是一次
    // 有意的决定，而不是"chat 那边加了什么它就跟着有什么"。
    expect(tools.map((t) => t.name).sort()).toEqual([
      'getSummary',
      'httpRequest',
      'listProjects',
      'queryTasks',
      'readFile',
      'runCommand',
      'writeFile',
    ]);
  });
});

describe('interceptor — 审计是底线', () => {
  test('a successful call records tool, args, target, result, duration and time', async () => {
    const invoke = recordingInvoke({ exitCode: 0, stdout: 'done', stderr: '' });
    const sink = createAuditSink(() => 42);
    const tools = auditTools(buildScheduledTools(deps(invoke)), sink);

    await call(tools.find((t) => t.name === 'runCommand') as AgentTool, {
      command: 'git',
      args: ['log'],
    });

    const entry = sink.entries()[0];
    expect(entry?.id).toBe('tc1');
    expect(entry?.toolName).toBe('runCommand');
    expect(entry?.argsSummary).toContain('"command":"git"');
    expect(entry?.target).toBe('/repo');
    expect(entry?.resultSummary).toContain('exit=0');
    expect(typeof entry?.durationMs).toBe('number');
    expect(entry?.at).toBe(42);
  });

  test('an http call records the host, not the full URL with its query string', async () => {
    const invoke = recordingInvoke({ status: 200, headers: {}, body: 'hi' });
    const sink = createAuditSink();
    const tools = auditTools(buildScheduledTools(deps(invoke)), sink);

    await call(tools.find((t) => t.name === 'httpRequest') as AgentTool, {
      url: 'https://api.example.com/v1/token?key=sk-secret',
    });

    const entry = sink.entries()[0];
    expect(entry?.target).toBe('api.example.com');
    // The query string is where credentials live; the audit wants to know where
    // the run reached, not to store what it was handed.
    expect(entry?.argsSummary).not.toContain('sk-secret');
  });

  test('file content and request bodies are recorded as sizes, never verbatim', async () => {
    const invoke = recordingInvoke({ path: 'a.txt', bytesWritten: 11 });
    const sink = createAuditSink();
    const tools = auditTools(buildScheduledTools(deps(invoke)), sink);

    await call(tools.find((t) => t.name === 'writeFile') as AgentTool, {
      path: 'a.txt',
      content: 'x'.repeat(5_000),
    });

    const entry = sink.entries()[0];
    expect(entry?.argsSummary).toContain('<5000 chars>');
    expect(entry?.argsSummary).not.toContain('xxxxx');
  });

  test('a failing call is still recorded — that is the case a record exists for', async () => {
    const invoke = recordingInvoke(new Error('command not found'));
    const sink = createAuditSink();
    const tools = auditTools(buildScheduledTools(deps(invoke)), sink);

    const result = (await call(tools.find((t) => t.name === 'runCommand') as AgentTool, {
      command: 'nope',
    })) as { content: { text: string }[] };

    expect(sink.entries()).toHaveLength(1);
    expect(sink.entries()[0]?.resultSummary).toContain('command not found');
    // Errors come back as a result the model can read and route around, not as
    // a throw: nobody is watching this run, so aborting the loop would throw
    // away the answer it already had.
    expect(result.content[0]?.text).toContain('失败');
  });

  test('a tool error does not stop the next call', async () => {
    let n = 0;
    const invoke = (async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return { path: 'a.txt', bytesWritten: 1 };
    }) as unknown as InvokeFn;
    const sink = createAuditSink();
    const tools = auditTools(buildScheduledTools(deps(invoke)), sink);
    const writeFile = tools.find((t) => t.name === 'writeFile') as AgentTool;

    await call(writeFile, { path: 'a.txt', content: 'a' });
    await call(writeFile, { path: 'a.txt', content: 'b' });

    expect(sink.entries()).toHaveLength(2);
    expect(sink.entries()[1]?.resultSummary).toContain('wrote=1B');
  });

  test('every tool reaches the agent wrapped — there is no unwrapped path', async () => {
    // The property that makes the audit a floor rather than a convention: the
    // agent's tool list is only ever produced by auditTools.
    const auditable = buildScheduledTools(deps(recordingInvoke()));
    const wrapped = auditTools(auditable, createAuditSink());
    expect(wrapped).toHaveLength(auditable.length);
    for (const tool of wrapped) {
      expect(auditable.some((a) => a.tool === tool)).toBe(false);
    }
  });

  test('the app-data tools are audited too, targeting app:data', async () => {
    const sink = createAuditSink();
    const tools = auditTools(buildScheduledTools(deps(recordingInvoke())), sink);
    await call(tools.find((t) => t.name === 'listProjects') as AgentTool, {});
    expect(sink.entries()[0]).toMatchObject({ toolName: 'listProjects', target: 'app:data' });
  });
});

describe('truncation — 两处，各有各的理由', () => {
  test('the audit summary is capped, and says how much was dropped', async () => {
    // stderr is what a failing command explains itself with, so it is the part
    // that legitimately makes a summary long — and long enough to need a cap.
    const invoke = recordingInvoke({
      exitCode: 1,
      stdout: '',
      stderr: 'e'.repeat(9_000),
    });
    const sink = createAuditSink();
    const tools = auditTools(buildScheduledTools(deps(invoke)), sink);

    await call(tools.find((t) => t.name === 'runCommand') as AgentTool, { command: 'make' });

    const summary = sink.entries()[0]?.resultSummary ?? '';
    expect(summary.length).toBeLessThan(AUDIT_SUMMARY_LIMIT + 40);
    // A bare ellipsis reads as "that was all of it", which is the one wrong
    // conclusion for the reader who opens a run record to see what happened.
    expect(summary).toContain('已截断');
  });

  test("a successful command's stdout stays out of the audit summary", async () => {
    // The summary says which command, where, and how it ended. 9 KB of stdout
    // belongs in the model's context, not in a one-line audit record.
    const invoke = recordingInvoke({ exitCode: 0, stdout: 'y'.repeat(9_000), stderr: '' });
    const sink = createAuditSink();
    const tools = auditTools(buildScheduledTools(deps(invoke)), sink);

    await call(tools.find((t) => t.name === 'runCommand') as AgentTool, { command: 'cat' });

    const summary = sink.entries()[0]?.resultSummary ?? '';
    expect(summary).toBe('exit=0 | ');
    expect(summary).not.toContain('yyy');
  });

  test('what goes back to the model is capped too, and says so', async () => {
    const invoke = recordingInvoke({
      exitCode: 0,
      stdout: 'z'.repeat(TOOL_RESULT_LIMIT + 500),
      stderr: '',
    });
    const tools = auditTools(buildScheduledTools(deps(invoke)), createAuditSink());
    const result = (await call(tools.find((t) => t.name === 'runCommand') as AgentTool, {
      command: 'cat',
    })) as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('已截断');
    expect(result.content[0]?.text.length).toBeLessThan(TOOL_RESULT_LIMIT + 40);
  });

  test('截断保留尾部，那里是编译器与测试框架报告错误的地方', () => {
    // 只留头部的话，一次 40 KB 的编译输出会被削成 8000 个字符的警告，模型读完
    // 得出"编译通过"的结论——而真正的 `error TS2304` 在它读不到的最后 2 KB 里。
    // 标记只说明"丢过东西"，不说明"活下来的是哪一头"，所以读者无从察觉自己
    // 看到的是误导性的开头。
    //
    // 两头都留：开头说明这是哪次运行的输出（模型据此判断上下文），结尾才是
    // 诊断所在（CONTEXT.md 把工具结果的价值定在"我能据此做什么"上）。
    const head = 'HEAD_MARKER_编译开始';
    const tail = 'TAIL_MARKER_error TS2304: Cannot find name';
    const text = head + 'x'.repeat(40_000) + tail;

    const clipped = truncate(text, 8_000);

    expect(clipped).toContain(head);
    expect(clipped).toContain(tail);
    expect(clipped).toContain('已截断');
    expect(clipped.length).toBeLessThan(8_000 + 60);
  });

  test('只比上限多一点的文本不值得挤掉头部去留尾部', () => {
    // 两段保留不能反噬：文本刚过线时，尾部带来的诊断价值抵不过被砍掉的头部。
    const text = 'A'.repeat(90) + 'B'.repeat(30);
    const clipped = truncate(text, 100);
    expect(clipped).toContain('已截断');
    // 头部保住了远超 MIN_HEAD 的量——没有被尾部挤成一小截。
    expect(clipped.split('…[已截断')[0]?.length ?? 0).toBeGreaterThan(50);
  });

  test('不超上限的文本原样返回，不加标记', () => {
    expect(truncate('x'.repeat(100), 100)).toBe('x'.repeat(100));
    expect(truncate('short', 100)).toBe('short');
  });

  test('极小的上限下标记不会被尾部挤掉', () => {
    // 审计摘要上限是 500，而标记本身在数字够大时会变长。分给尾部的预算不能
    // 反过来把"这里截断了"这句话吃掉——那句话正是读者判断该去看原始输出的
    // 唯一依据。
    const clipped = truncate('E'.repeat(100_000), AUDIT_SUMMARY_LIMIT);
    expect(clipped).toContain('已截断');
    expect(clipped.length).toBeLessThanOrEqual(AUDIT_SUMMARY_LIMIT + 40);
  });
});
