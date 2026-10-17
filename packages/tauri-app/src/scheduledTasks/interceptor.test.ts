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

  test("the three app-data tools come along, so a prompt can read the user's own data", async () => {
    const tools = auditTools(buildScheduledTools(deps(recordingInvoke())), createAuditSink());
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

  test('a short result is passed through untouched', () => {
    expect(truncate('short', 100)).toBe('short');
    expect(truncate('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });
});
