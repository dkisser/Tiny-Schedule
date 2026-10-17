import { describe, expect, test } from 'bun:test';
import type { Agent, AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { emptyAppData, type ScheduledTask, type ScheduledTaskRun } from '@tiny-schedule/shared';
import { silentLogger } from '@/ai/logger';
import { installTauriMocks } from '@/test/tauriMocks';
import { createScheduledTaskRunner, type ScheduledRunnerDeps } from './runner';

/**
 * The runner never reaches a real host: `invoke` and the notification are
 * injected, and the agent itself is stubbed through `createAgent`. That seam
 * exists for the same reason ChatAgentManager has one — asserting a lifecycle
 * against a live provider would make the test a network test.
 */
installTauriMocks();

const PROVIDER = {
  id: 'p1',
  registryId: 'openai',
  apiKeyEncrypted: 'enc',
  model: 'gpt-4o-mini',
  isDefault: true,
};

const TASK: ScheduledTask = {
  id: 'st1',
  name: '每日汇总',
  prompt: '汇总今天的提交',
  schedule: { kind: 'daily', time: '09:00' },
  workingDirectory: '/repo',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

interface AgentStub {
  /** Assistant messages the run ends with; controls the outcome. */
  messages: AgentMessage[];
  aborts: number;
  agent: Agent;
  /** Push an event to the runner's subscription, as pi-agent-core would. */
  emit: (event: AgentEvent) => void;
}

/**
 * An agent that ends every prompt with `messages`, so a test chooses success or
 * failure by choosing the transcript rather than by mocking pi-agent-core.
 */
function stubAgent(options: {
  messages: AgentMessage[];
  onPrompt?: () => void | Promise<void>;
  onAbort?: () => void;
}): AgentStub {
  const listeners: ((event: AgentEvent) => void)[] = [];
  const stub: AgentStub = {
    messages: options.messages,
    aborts: 0,
    agent: null as never,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
  const agent = {
    state: {
      messages: options.messages,
      isStreaming: false,
      errorMessage: undefined,
      tools: [],
    },
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
    prompt: async () => {
      await options.onPrompt?.();
    },
    abort: () => {
      stub.aborts += 1;
      options.onAbort?.();
    },
  } as unknown as Agent;
  stub.agent = agent;
  return stub;
}

const textMessage = (text: string): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }) as never;

const errorMessage = (error: string): AgentMessage =>
  ({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: error,
  }) as never;

const textDelta = (): AgentEvent =>
  ({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: '…' },
  }) as never;

const toolStart = (toolCallId: string): AgentEvent =>
  ({ type: 'tool_execution_start', toolCallId, toolName: 'runCommand', args: {} }) as never;

const toolEnd = (toolCallId: string): AgentEvent =>
  ({
    type: 'tool_execution_end',
    toolCallId,
    toolName: 'runCommand',
    result: {},
    isError: false,
  }) as never;

function harness(
  agent: AgentStub,
  overrides: Partial<ScheduledRunnerDeps> = {},
): {
  runner: ReturnType<typeof createScheduledTaskRunner>;
  /** 结束时写下的终态记录。 */
  saved: ScheduledTaskRun[];
  /** 开始时写下的 running 记录。 */
  started: ScheduledTaskRun[];
  notified: { title: string; body: string }[];
  deps: ScheduledRunnerDeps;
} {
  const saved: ScheduledTaskRun[] = [];
  const started: ScheduledTaskRun[] = [];
  const notified: { title: string; body: string }[] = [];
  let clock = 1_000;
  const deps: ScheduledRunnerDeps = {
    getData: () => emptyAppData(),
    getProviders: () => [PROVIDER],
    decryptKey: () => 'sk-test',
    saveRunStart: async (run) => {
      started.push(run);
      return run;
    },
    saveRunEnd: async (run) => {
      saved.push(run);
      return run;
    },
    logger: silentLogger,
    notify: (payload) => {
      notified.push(payload);
    },
    invoke: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    now: () => (clock += 1),
    createAgent: ({ buildAgent }) => buildAgent({}, {} as never),
    ...overrides,
  };
  if (!overrides.createAgent) {
    // Hand the built tool list to the stub, exactly as the real Agent would
    // receive it — that is what lets a test prove the agent's tools are the
    // audited ones and not the raw ones.
    deps.createAgent = ({ tools }) => {
      (agent.agent.state as { tools: unknown }).tools = tools;
      return agent.agent;
    };
  }
  return { runner: createScheduledTaskRunner(deps), saved, started, notified, deps };
}

describe('runScheduledTask — 一次触发的完整生命周期', () => {
  test('a successful run records status, output, finishedAt and its trigger', async () => {
    const agent = stubAgent({ messages: [textMessage('今天有 3 次提交')] });
    const { runner, saved, started } = harness(agent);

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('success');
    expect(result.run.output).toBe('今天有 3 次提交');
    expect(result.run.trigger).toBe('scheduled');
    expect(result.run.scheduledTaskId).toBe('st1');
    expect(result.run.startedAt).toBeGreaterThan(0);
    expect(result.run.finishedAt).toBeGreaterThanOrEqual(result.run.startedAt);
    // 运行从开始就落库，结束时改写为终态：同一条记录的两个时刻，而不是两条记录。
    expect(started).toHaveLength(1);
    expect(started[0]?.id).toBe(result.run.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.id).toBe(result.run.id);
  });

  test('the running record lands before the agent starts, with no output and no audit', async () => {
    // CONTEXT.md：运行从开始就落库。这条记录里此刻还没有输出、没有工具调用——审计随
    // 终态一次写全，所以运行中它必须是空的，而不是"写到一半"。
    const order: string[] = [];
    const agent = stubAgent({
      messages: [textMessage('done')],
      onPrompt: () => {
        order.push('prompt');
      },
    });
    const { runner, started } = harness(agent, {
      saveRunStart: async (run) => {
        order.push('start');
        started.push(run);
        return run;
      },
    });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(order).toEqual(['start', 'prompt']);
    const record = started[0];
    expect(record?.status).toBe('running');
    expect(record?.trigger).toBe('scheduled');
    expect(record?.startedAt).toBeGreaterThan(0);
    expect(record?.finishedAt).toBeUndefined();
    expect(record?.output).toBeUndefined();
    expect(record?.toolCalls).toEqual([]);
    // The same run id is later rewritten into the terminal record — a run that
    // dies in between keeps this id, which is what makes it findable.
    expect(record?.id).toBe(result.run.id);
  });

  test('a run the process never finishes leaves its running record behind', async () => {
    // 这是新增的持久化存在的理由：模拟进程在 Agent 跑到一半时死掉——执行器侧什么都没有，
    // 但那条 running 记录已经在库里了，等着启动对账把它记成 interrupted。
    const agent = stubAgent({
      messages: [],
      onPrompt: () => {
        throw new Error('进程被杀');
      },
    });
    const { runner, started } = harness(agent);

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(result.run.status).toBe('failed');
    expect(started).toHaveLength(1);
    expect(started[0]?.status).toBe('running');
  });

  test('「立即运行」produces the same shape as a scheduled trigger', async () => {
    // CONTEXT.md: 立即运行产生的运行与定时触发完全同构. Only the trigger differs.
    const manual = await harness(
      stubAgent({ messages: [textMessage('ok')] }),
    ).runner.runScheduledTask(TASK, 'manual');
    expect(manual.run.status).toBe('success');
    expect(manual.run.trigger).toBe('manual');
    expect(manual.run.finishedAt).toBeDefined();
    expect(manual.run.toolCalls).toEqual([]);
  });

  test('a failed run records the reason, and the record lands before the notification', async () => {
    const order: string[] = [];
    const agent = stubAgent({ messages: [errorMessage('provider 500')] });
    const { runner, saved, notified } = harness(agent, {
      saveRunEnd: async (run) => {
        order.push('save');
        saved.push(run);
        return run;
      },
      notify: (payload) => {
        order.push('notify');
        notified.push(payload);
      },
    });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(result.ok).toBe(false);
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toBe('provider 500');
    // A user who taps the banner opens the run detail; that detail must exist.
    expect(order).toEqual(['save', 'notify']);
  });

  test('a missing provider fails the run without ever constructing an agent', async () => {
    let built = false;
    const { runner, saved, started } = harness(stubAgent({ messages: [] }), {
      getProviders: () => [],
      createAgent: () => {
        built = true;
        return stubAgent({ messages: [] }).agent;
      },
    });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(built).toBe(false);
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toBe('NO_PROVIDER_CONFIGURED');
    expect(saved).toHaveLength(1);
    // The trigger already happened, so it is on record even though no agent ran.
    expect(started).toHaveLength(1);
  });

  test('a host error before the agent starts is a failed run, not a throw', async () => {
    const { runner, saved } = harness(stubAgent({ messages: [] }), {
      decryptKey: () => {
        throw new Error('safeStorage 不可用');
      },
    });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(result.run.status).toBe('failed');
    expect(result.run.error).toContain('safeStorage');
    expect(saved).toHaveLength(1);
  });

  test('the run record lands even when the agent throws outright', async () => {
    const agent = stubAgent({
      messages: [],
      onPrompt: () => {
        throw new Error('already processing');
      },
    });
    const { runner, saved } = harness(agent);

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(result.run.status).toBe('failed');
    expect(result.run.error).toContain('already processing');
    expect(saved).toHaveLength(1);
  });
});

describe('通知 — 结束时按结果发一条', () => {
  test('success says the task finished; failure names the task and the reason', async () => {
    const ok = harness(stubAgent({ messages: [textMessage('done')] }));
    await ok.runner.runScheduledTask(TASK, 'scheduled');
    expect(ok.notified[0]?.title).toContain('每日汇总');
    expect(ok.notified[0]?.title).toContain('完成');

    const bad = harness(stubAgent({ messages: [errorMessage('超时')] }));
    await bad.runner.runScheduledTask(TASK, 'scheduled');
    expect(bad.notified[0]?.title).toContain('失败');
    expect(bad.notified[0]?.body).toContain('超时');
  });

  test('a notification failure does not undo the run record', async () => {
    // The record is the durable part; a cosmetic banner failing must not turn a
    // completed run into a failed one.
    const { runner } = harness(stubAgent({ messages: [textMessage('done')] }), {
      notify: () => {
        throw new Error('通知权限被拒');
      },
    });
    await expect(runner.runScheduledTask(TASK, 'scheduled')).rejects.toThrow('通知权限被拒');
  });
});

describe('recordSkipped — 重叠保护由调用方决定，这里只负责如实记一笔', () => {
  test('a skipped run is recorded with no output and no tool calls', async () => {
    const agent = stubAgent({ messages: [textMessage('should never run')] });
    const { runner, saved, started, notified } = harness(agent);

    const result = await runner.recordSkipped(TASK, 'scheduled');

    expect(result.run.status).toBe('skipped');
    expect(result.run.output).toBe('');
    expect(result.run.toolCalls).toEqual([]);
    expect(result.run.finishedAt).toBe(result.run.startedAt);
    expect(saved).toHaveLength(1);
    // Nothing ran, so nothing is announced — a banner on every overlapping
    // trigger is how a user learns to ignore the ones that matter.
    expect(notified).toHaveLength(0);
    // And crucially the agent was never constructed.
    expect(agent.aborts).toBe(0);
    // 开始即结束：skipped 从来没有过 running 阶段，所以不落一条 running 再改写。
    expect(started).toHaveLength(0);
  });
});

describe('审计与运行的接合 — ADR-0008 的底线在整条链路上成立', () => {
  test("a tool the agent calls lands in that run's record", async () => {
    // The end-to-end version of the interceptor's unit tests: the agent's own
    // tool list is the audited one, and what it does with a tool shows up in
    // the record for this run and no other.
    let tools: Agent['state']['tools'] = [];
    const agent = stubAgent({
      messages: [textMessage('done')],
      onPrompt: async () => {
        const runCommand = tools.find((t) => t.name === 'runCommand');
        await runCommand?.execute('tc1', { command: 'git', args: ['log'] } as never);
      },
    });
    const invoked: { cmd: string; args?: Record<string, unknown> }[] = [];
    const { runner, saved, started } = harness(agent, {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        invoked.push({ cmd, args });
        return { exitCode: 0, stdout: '2 commits', stderr: '' };
      },
      createAgent: ({ tools: built }) => {
        tools = built;
        return agent.agent;
      },
    });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(invoked).toHaveLength(1);
    // Tauri 按参数名匹配：Rust 命令的入参是单个 `request` 结构体，所以调用必须且只能
    // 带一个 `request` 键——平铺会在运行时被拒（missing required key `request`）。
    expect(Object.keys(invoked[0]?.args ?? {})).toEqual(['request']);
    const request = invoked[0]?.args?.request as Record<string, unknown>;
    expect(request?.taskId).toBe('st1');
    expect(request?.runId).toBe(result.run.id);
    expect(result.run.toolCalls).toHaveLength(1);
    expect(result.run.toolCalls[0]).toMatchObject({
      id: 'tc1',
      toolName: 'runCommand',
      target: '/repo',
    });
    expect(saved[0]?.toolCalls).toHaveLength(1);
    // 审计随终态一次写全：开始时那条 running 里工具调用仍是空的。
    expect(started[0]?.toolCalls).toEqual([]);
  });

  test("the tool calls carry this run's id, so one run's audit cannot be read as another's", async () => {
    // Two runs of the same task, distinguished only by runId — which is why the
    // gateway demands it on every request.
    const seen: string[] = [];
    let tools: Agent['state']['tools'] = [];
    const agent = stubAgent({
      messages: [textMessage('done')],
      onPrompt: async () => {
        await tools
          .find((t) => t.name === 'runCommand')
          ?.execute('tc1', { command: 'ls' } as never);
      },
    });
    const { runner } = harness(agent, {
      invoke: async (_cmd: string, args?: Record<string, unknown>) => {
        seen.push(String((args?.request as Record<string, unknown>)?.runId));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      createAgent: ({ tools: built }) => {
        tools = built;
        return agent.agent;
      },
    });

    const first = await runner.runScheduledTask(TASK, 'scheduled');
    const second = await runner.runScheduledTask(TASK, 'scheduled');

    expect(new Set(seen).size).toBe(2);
    expect(seen).toContain(first.run.id);
    expect(seen).toContain(second.run.id);
  });

  test('a tool failure is recorded and still lets the run finish', async () => {
    let tools: Agent['state']['tools'] = [];
    const agent = stubAgent({
      messages: [textMessage('我改用别的方式完成了')],
      onPrompt: async () => {
        await tools
          .find((t) => t.name === 'runCommand')
          ?.execute('tc1', { command: 'nope' } as never);
      },
    });
    const { runner } = harness(agent, {
      invoke: async () => {
        throw new Error('command not found');
      },
      createAgent: ({ tools: built }) => {
        tools = built;
        return agent.agent;
      },
    });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(result.run.status).toBe('success');
    expect(result.run.toolCalls).toHaveLength(1);
    expect(result.run.toolCalls[0]?.resultSummary).toContain('command not found');
  });
});

describe('超时', () => {
  test('a first-token timeout aborts the agent, and the run lands as failed', async () => {
    // Without this, one provider that never answers holds the run open forever,
    // and because a new trigger while one is running is skipped, every trigger
    // after it is skipped too: the task looks merely idle, when it is wedged.
    let signalAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      signalAborted = resolve;
    });
    const agent = stubAgent({
      messages: [errorMessage('已中止')],
      // Never resolves on its own: only the abort can end this run.
      onPrompt: () => aborted,
      onAbort: signalAborted,
    });
    const { runner } = harness(agent, { timeouts: { firstTokenMs: 5, idleMs: 10_000 } });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(agent.aborts).toBe(1);
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toContain('首 token 超时');
    expect(result.run.error).toContain('已中止');
  });

  test('a long tool call is not counted as idle silence', async () => {
    // 工具在执行 = 有进展：这段时间 LLM 本来就不会流式输出，把它计进空闲会把一次
    // 健康的长工具调用误掐成超时。卡死的工具由 Rust 网关的硬上限兜底，不在这里计时。
    const agent = stubAgent({
      messages: [textMessage('done')],
      onPrompt: async () => {
        agent.emit(textDelta());
        agent.emit(toolStart('t1'));
        await new Promise((resolve) => setTimeout(resolve, 50)); // 远超 idleMs
        agent.emit(toolEnd('t1'));
      },
    });
    const { runner } = harness(agent, { timeouts: { firstTokenMs: 10_000, idleMs: 10 } });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(agent.aborts).toBe(0);
    expect(result.run.status).toBe('success');
  });

  test('silence after the tool ends still trips the idle timeout', async () => {
    // 计数归零后 LLM 再无输出 = 真的卡住了：无人值守时这次运行必须被掐断，否则它
    // 永远占着锁，之后的每一次触发都被记成 skipped。
    let signalAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      signalAborted = resolve;
    });
    const agent = stubAgent({
      messages: [errorMessage('已中止')],
      onPrompt: async () => {
        agent.emit(toolStart('t1'));
        agent.emit(toolEnd('t1'));
        // 此后 LLM 再无输出：只有空闲超时能结束这次运行。
        await aborted;
      },
      onAbort: signalAborted,
    });
    const { runner } = harness(agent, { timeouts: { firstTokenMs: 10_000, idleMs: 10 } });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(agent.aborts).toBe(1);
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toContain('空闲超时');
  });

  test('overlapping tools hold the idle timer until the last one ends', async () => {
    // 并发工具按完成顺序逐个 emit end（pi-agent-core 文档）：第一个结束不代表
    // LLM 该重新被计时——计数到零才 arm，所以这里是计数而不是开关。
    const agent = stubAgent({
      messages: [textMessage('done')],
      onPrompt: async () => {
        agent.emit(toolStart('t1'));
        agent.emit(toolStart('t2'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        agent.emit(toolEnd('t1'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        agent.emit(toolEnd('t2'));
      },
    });
    const { runner } = harness(agent, { timeouts: { firstTokenMs: 10_000, idleMs: 10 } });

    const result = await runner.runScheduledTask(TASK, 'scheduled');

    expect(agent.aborts).toBe(0);
    expect(result.run.status).toBe('success');
  });

  test('the timer is cleared when the run finishes, so nothing fires afterwards', async () => {
    // A timer left armed would abort the *next* run's agent — the same object is
    // reused by createAgent in some hosts, and an abort with no run to stop is
    // a crash-shaped bug rather than a slow one.
    const agent = stubAgent({ messages: [textMessage('done')] });
    const { runner } = harness(agent, { timeouts: { firstTokenMs: 5, idleMs: 10_000 } });

    await runner.runScheduledTask(TASK, 'scheduled');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(agent.aborts).toBe(0);
  });
});
