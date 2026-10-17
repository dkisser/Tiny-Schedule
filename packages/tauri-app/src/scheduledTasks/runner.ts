import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  type AiProviderConfig,
  type AppData,
  type FinishedScheduledTaskRun,
  localDate,
  newScheduledTaskRunId,
  type RunningScheduledTaskRun,
  type ScheduledTask,
  type ScheduledTaskRun,
} from '@tiny-schedule/shared';
import { buildChatModel, type ChatModel, createChatStreamFn } from '@/ai/chatProvider';
import { type AiLogger } from '@/ai/logger';
import { getProviderDef } from '@/ai/providers';
import { auditTools, createAuditSink } from './interceptor';
import { emitRunsChanged } from './runEvents';
import { buildScheduledTools, type InvokeFn } from './tools';

/**
 * 定时任务的执行器：一次触发 = 一个 Agent + 一次运行记录。
 *
 * 与 ChatAgentManager 同一套注入方式（同一个 pi-agent-core、同一个 provider 配置
 * 与 key 解密、同样的首 token / 空闲超时与 abort），差别只有三处，每处都是领域
 * 决定的：
 *
 *  - **不重试。** CONTEXT.md：失败不重试、不停用定时任务。聊天里重试是因为有人
 *    盯着看，一次抖动值得再试；无人值守的定时任务重试只会在一次网络波动后把同一条
 *    prompt 再执行一遍——而这次执行同样有全部工具的权限。
 *  - **每次触发一个全新 Agent。** 会话状态是聊天独有的：定时任务每次触发都从同一段
 *    prompt 出发，上一次的思考过程不该渗进这一次。
 *  - **结果只有一条运行记录。** 没有 chunk 流、没有 renderer 事件，结束时一条系统
 *    通知即全部反馈。这条记录从**开始**就落库，结束时改写为终态——所以进程在运行途
 *    中死掉时，这次执行连同它的工具调用仍然留在历史里，而不是连同进程一起消失。
 *
 * 重叠保护（上一轮未结束时的新触发记为 skipped）是调用方的职责，不在这一层：谁在
 * 什么时刻持有"这个任务正在跑"这把锁，属于调度器怎么组织的问题。
 */

/** 与 chatAgent.ts 同一组阈值：首 token 30s，空闲 60s。 */
const FIRST_TOKEN_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;

/** 执行目录缺省时的落点：用户主目录，而不是应用的 cwd。 */
const DEFAULT_WORKING_DIRECTORY = '~';

export const SCHEDULED_SYSTEM_PROMPT = `你是一个无人值守的定时任务执行器。你会收到一段 prompt 和一组工具，然后独立完成它，最后用中文简明汇报结果。
规则：
- 直接动手，不要反问；没有人会回答你的提问。
- 输出就是最终结果本身，不要写"我将要做什么"这类过程陈述。
- 工具执行失败时读错误信息，换一条路再试；仍不行就在输出里如实说明失败原因。`;

export interface ScheduledRunnerDeps {
  /** 读工具要用；webview 的 DataStore 走异步文件系统，所以是 promise。 */
  getData: () => AppData | Promise<AppData>;
  getProviders: () => AiProviderConfig[] | Promise<AiProviderConfig[]>;
  decryptKey: (encrypted: string) => string | Promise<string>;
  /**
   * 落一条 running：运行开始即写，所以进程中途死掉时这次执行仍在历史里。
   *
   * 这条记录里的 toolCalls 恒为空——工具调用审计随终态一次写全，不逐次落盘
   * （ADR-0008 要的是"一次运行留下完整的一次记录"）。
   */
  saveRunStart: (run: RunningScheduledTaskRun) => Promise<unknown>;
  /** 终结：把那条 running 改写为终态（output + 全部工具调用 + 耗时）。 */
  saveRunEnd: (run: FinishedScheduledTaskRun) => Promise<unknown>;
  logger: AiLogger;
  /** 发系统通知；调用方决定是否接插件。 */
  notify: (payload: { title: string; body: string }) => void | Promise<void>;
  /** 默认真实 Tauri invoke；测试注入 stub。 */
  invoke: InvokeFn;
  /** 注入时钟，让超时与耗时可测。 */
  now?: () => number;
  /** 覆盖超时阈值（ms）。 */
  timeouts?: { firstTokenMs?: number; idleMs?: number };
  /** 测试注入点：替换真实 provider 连接。 */
  createAgent?: (opts: CreateAgentOpts) => Agent;
}

export interface CreateAgentOpts {
  task: ScheduledTask;
  buildAgent: (streamFn: unknown, model: ChatModel) => Agent;
  tools: Agent['state']['tools'];
}

/** 一次触发的类型；手动触发走同一条路径（CONTEXT.md：立即运行与定时触发完全同构）。 */
export type RunTrigger = ScheduledTaskRun['trigger'];

/**
 * 执行途中那一次运行的草稿。
 *
 * 它就是一条 {@link RunningScheduledTaskRun}，没有别的含义：运行从开始就落库
 * （CONTEXT.md），而类型上写不出"一条已经成功却没有结束时点的运行记录"——那是上一版
 * 只增记录的做法下最容易被误造出来的形状。
 *
 * 剩下的差别只有一处：finishedAt 与 output 由执行过程决定，所以草稿不带它们，
 * 由 {@link finish} 在收尾时补上。工具调用审计也在那里一次写全。
 */
type RunDraft = RunningScheduledTaskRun;

/** 一次运行的结果形状，调用方据它决定通知文案。 */
export interface ScheduledRunResult {
  run: ScheduledTaskRun;
  ok: boolean;
  error?: string;
}

/** The last assistant message's text — the run's 最终输出. */
function finalOutput(agent: Agent): string {
  const messages = agent.state.messages as AgentMessage[];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text !== '') return text;
  }
  return '';
}

/**
 * 最近一次 run 是否以错误/中止收尾。
 *
 * pi-agent-core 在 abort 与流式失败时也会 **resolve**（以 stopReason
 * 'aborted'/'error' 的 assistant 消息收尾），所以 resolve 之后必须查终态，否则
 * 一次超时会被记成一次成功——而那次成功没有任何输出。
 */
function isErrorOutcome(agent: Agent): string | null {
  const messages = agent.state.messages as AgentMessage[];
  const last = messages[messages.length - 1];
  if (
    last?.role === 'assistant' &&
    (last.stopReason === 'error' || last.stopReason === 'aborted')
  ) {
    return last.errorMessage ?? (last.stopReason === 'aborted' ? '已中止' : 'AI provider 错误');
  }
  return agent.state.errorMessage ?? null;
}

function notificationFor(
  task: ScheduledTask,
  ok: boolean,
  error?: string,
): {
  title: string;
  body: string;
} {
  if (ok) return { title: `定时任务完成：${task.name}`, body: '执行成功' };
  return {
    title: `定时任务失败：${task.name}`,
    body: error ? `执行失败：${error}` : '执行失败',
  };
}

export function createScheduledTaskRunner(deps: ScheduledRunnerDeps) {
  const now = deps.now ?? Date.now;

  /**
   * 首 token 超时与空闲超时。
   *
   * 两条都必须有：没有人在场，一次永不返回的 provider 连接会让这个定时任务永远
   * 占着锁，而"前一次运行未结束时的新触发记为 skipped"意味着此后每一次触发都被跳
   * 过——任务看起来只是不再触发，实际是永久卡死。
   *
   * 超时走 abort 而不是抛错：abort 让 agent 以 stopReason 'aborted' 收尾，
   * `isErrorOutcome` 因此能把这次运行如实记成失败，而不是成功。
   */
  const armTimers = (agent: Agent): { clear: () => void; timedOut: () => string | null } => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timeoutReason: string | null = null;
    // 正在执行的工具数。工具在执行 = 有进展，而这段时间 LLM 本来就不会流式输出——
    // 把这段静默计进空闲，会把一次健康的长工具调用误掐成超时。工具可并发、按完成
    // 顺序逐个 emit end，所以是计数而不是开关。
    let pendingTools = 0;
    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const arm = (ms: number, reason: string): void => {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        // 是我们掐断的，先把原因留下来：abort 之后 agent 的 errorMessage 是 fetch 的
        // 原始文本（"Request aborted"），运行记录里它不该顶替真正的原因。
        timeoutReason = reason;
        agent.abort();
      }, ms);
    };
    const armIdle = (): void => {
      const ms = deps.timeouts?.idleMs ?? IDLE_TIMEOUT_MS;
      arm(ms, `空闲超时：${Math.round(ms / 1000)} 秒内没有新输出，已中止`);
    };
    // Idle is re-armed on every delta rather than measured from the start: a
    // long tool call is not a stall, and aborting one would misreport a healthy
    // run as failed.
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        pendingTools += 1;
        // 工具期间不再另计一道 TS 超时：卡死的工具由 Rust 网关的硬上限兜底。
        clearTimer();
        return;
      }
      if (event.type === 'tool_execution_end') {
        pendingTools = Math.max(0, pendingTools - 1);
        // 只有最后一个工具结束时才重新计 LLM 的空闲。
        if (pendingTools === 0) armIdle();
        return;
      }
      if (
        event.type === 'message_update' &&
        event.assistantMessageEvent.type === 'text_delta' &&
        pendingTools === 0
      ) {
        armIdle();
      }
    });
    const firstTokenMs = deps.timeouts?.firstTokenMs ?? FIRST_TOKEN_TIMEOUT_MS;
    arm(
      firstTokenMs,
      `首 token 超时：provider ${Math.round(firstTokenMs / 1000)} 秒内没有开始响应，已中止`,
    );
    return {
      clear: () => {
        clearTimer();
        unsubscribe();
      },
      timedOut: () => timeoutReason,
    };
  };

  const finish = async (
    task: ScheduledTask,
    draft: RunDraft,
    outcome: { ok: boolean; output: string; error?: string },
  ): Promise<ScheduledRunResult> => {
    const finished: FinishedScheduledTaskRun = {
      ...draft,
      finishedAt: now(),
      output: outcome.output,
      status: outcome.ok ? 'success' : 'failed',
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
    // The record lands before the notification on purpose: a user who taps the
    // banner opens the run detail, and that detail has to exist by then.
    await deps.saveRunEnd(finished);
    // ...and the history refresh rides on the same write: the running record was
    // already on screen, so this is what turns it into the terminal one.
    emitRunsChanged();
    await deps.notify(notificationFor(task, outcome.ok, outcome.error));
    deps.logger.info({
      action: 'scheduledTask:run',
      scheduledTaskId: task.id,
      runId: finished.id,
      trigger: finished.trigger,
      status: finished.status,
      toolCalls: finished.toolCalls.length,
      ...(finished.error !== undefined ? { error: finished.error } : {}),
    });
    return {
      run: finished,
      ok: outcome.ok,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  };

  const runScheduledTask = async (
    task: ScheduledTask,
    trigger: RunTrigger,
  ): Promise<ScheduledRunResult> => {
    const runId = newScheduledTaskRunId();
    const startedAt = now();
    const sink = createAuditSink(now);
    const base: RunDraft = {
      id: runId,
      scheduledTaskId: task.id,
      trigger,
      startedAt,
      status: 'running',
      toolCalls: [],
    };

    // 落库先于任何可能失败的准备动作：provider 配置缺失、key 解不开，这些都发生在
    // Agent 起来之前，而这一次触发已经发生过了——不先落一条，这次触发在历史里什么
    // 都不会留下。
    await deps.saveRunStart(base);
    emitRunsChanged();

    const providers = await deps.getProviders();
    // No providerId on the task: an unattended rule cannot be pointed at a
    // provider the user has to pick, so it follows the global default and falls
    // back to whatever is configured — same order chatAgent uses.
    const cfg = providers.find((p) => p.isDefault) ?? providers[0];
    if (!cfg) {
      return finish(task, base, { ok: false, output: '', error: 'NO_PROVIDER_CONFIGURED' });
    }

    try {
      const model = buildChatModel(cfg, getProviderDef(cfg.registryId));
      const apiKey = await deps.decryptKey(cfg.apiKeyEncrypted);
      // Every tool the agent can reach is wrapped by the interceptor — there is
      // no second list to keep in sync, which is the "no bypass" property.
      const tools = auditTools(
        buildScheduledTools({
          workingDirectory: task.workingDirectory ?? DEFAULT_WORKING_DIRECTORY,
          context: { taskId: task.id, runId },
          invoke: deps.invoke,
          getData: deps.getData,
          today: () => localDate(now()),
        }),
        sink,
      );
      const buildAgent = (streamFn: unknown, m: ChatModel) =>
        new Agent({
          initialState: {
            systemPrompt: SCHEDULED_SYSTEM_PROMPT,
            model: m,
            tools,
            messages: [],
          },
          streamFn: streamFn as never,
        });
      const agent = deps.createAgent
        ? deps.createAgent({ task, buildAgent, tools })
        : buildAgent(createChatStreamFn(apiKey), model);

      const timers = armTimers(agent);
      try {
        await agent.prompt(task.prompt);
      } finally {
        timers.clear();
      }

      // 超时被我们自己掐断时，原因以 armTimers 记下的为准：agent 侧的 errorMessage
      // 只是 fetch 被中止的原始文本（"Request aborted"），它说的是手段，不是原因。
      const failure = timers.timedOut() ?? isErrorOutcome(agent);
      return await finish(
        task,
        { ...base, toolCalls: sink.entries() },
        {
          ok: failure === null,
          output: finalOutput(agent),
          ...(failure !== null ? { error: failure } : {}),
        },
      );
    } catch (error) {
      // Anything thrown out here is the host refusing to start the run at all
      // (key decryption, provider config). The tool calls already recorded are
      // kept — a partial audit is still evidence.
      const message = error instanceof Error ? error.message : String(error);
      return await finish(
        task,
        { ...base, toolCalls: sink.entries() },
        { ok: false, output: '', error: message },
      );
    }
  };

  /**
   * 记一次 skipped：上一轮未结束时的新触发被跳过（CONTEXT.md）。
   *
   * 由调用方在**持有调度锁的前提下**调用，所以本方法不判断是否有任务在跑——那把锁
   * 在调用方手里，这里重复判断只会造出第二个真相来源。
   */
  const recordSkipped = async (
    task: ScheduledTask,
    trigger: RunTrigger,
  ): Promise<ScheduledRunResult> => {
    // One clock read: a skipped run consumed no time at all, and a record whose
    // finishedAt is a millisecond after its startedAt claims it did.
    const at = now();
    const run: FinishedScheduledTaskRun = {
      id: newScheduledTaskRunId(),
      scheduledTaskId: task.id,
      trigger,
      startedAt: at,
      finishedAt: at,
      status: 'skipped',
      output: '',
      toolCalls: [],
    };
    // 一条 skipped 从来没有过 running 阶段，所以它直接走终结通道：终态记录不落一
    // 条假的 running 再改写——那会在历史里多出一段并不存在的"运行中"。
    await deps.saveRunEnd(run);
    emitRunsChanged();
    deps.logger.info({
      action: 'scheduledTask:runSkipped',
      scheduledTaskId: task.id,
      runId: run.id,
      trigger,
    });
    // No notification: nothing ran, and a banner saying "skipped" on every
    // overlapping trigger is how users learn to ignore the ones that matter.
    return { run, ok: true };
  };

  return { runScheduledTask, recordSkipped };
}

export type ScheduledTaskRunner = ReturnType<typeof createScheduledTaskRunner>;
