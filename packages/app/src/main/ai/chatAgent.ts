import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AiProviderConfig, AppData, ChatSession } from '@tiny-schedule/shared';
import type { Logger } from 'pino';
import { buildChatTools, CHAT_SYSTEM_PROMPT } from './chatAgentTools';
import { buildChatModel, type ChatModel, createChatStreamFn } from './chatProvider';
import { getProviderDef } from './providers';

const FIRST_TOKEN_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

export interface ChatEventSink {
  chunk(sessionId: string, requestId: string, delta: string): void;
  tool(ev: {
    sessionId: string;
    requestId: string;
    toolCallId: string;
    name: string;
    status: 'running' | 'done' | 'error';
    args?: unknown;
    resultSummary?: string;
  }): void;
  status(ev: {
    sessionId: string;
    requestId?: string;
    status: 'running' | 'retrying' | 'failed';
    attempt?: number;
    error?: string;
  }): void;
  done(sessionId: string, requestId: string): void;
  error(ev: { sessionId: string; requestId?: string; error: string }): void;
}

export interface ChatManagerDeps {
  getSessions: () => ChatSession[];
  saveSession: (s: ChatSession) => void;
  deleteStoredSession: (id: string) => ChatSession[];
  getProviders: () => AiProviderConfig[];
  decryptKey: (encrypted: string) => string;
  getData: () => AppData;
  today: () => string;
  sink: ChatEventSink;
  logger: Logger;
  /** 测试注入点：替换真实 provider 连接。 */
  createAgent?: (opts: CreateAgentOpts) => Agent;
}

export interface CreateAgentOpts {
  session: ChatSession;
  buildAgent: (streamFn: unknown, model: ChatModel) => Agent;
}

export class ChatAgentManager {
  private agents = new Map<string, Agent>();
  private runIds = new Map<string, string>(); // sessionId -> 当前 requestId（run 失效校验）
  private agentRunIds = new Map<Agent, string>(); // agent -> 正在其上执行的 run 的 requestId（订阅事件归属）
  private runPromises = new Map<string, Promise<void>>(); // sessionId -> 最近一次 run() 的 promise
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private deps: ChatManagerDeps) {}

  listSessions(): ChatSession[] {
    return this.deps
      .getSessions()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  createSession(providerId?: string): ChatSession {
    const s: ChatSession = {
      id: randomUUID(),
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      ...(providerId ? { providerId } : {}),
    };
    this.deps.saveSession(s);
    return s;
  }

  deleteSession(id: string): ChatSession[] {
    this.stop(id);
    this.agents.delete(id);
    this.runPromises.delete(id);
    return this.deps.deleteStoredSession(id);
  }

  async send(
    sessionId: string,
    text: string,
    providerId?: string,
  ): Promise<{ requestId: string } | { error: string }> {
    const session = this.deps.getSessions().find((s) => s.id === sessionId);
    if (!session) return { error: 'SESSION_NOT_FOUND' };
    const providers = this.deps.getProviders();
    const cfg = providerId
      ? providers.find((p) => p.id === providerId)
      : (providers.find((p) => p.id === session.providerId) ??
        providers.find((p) => p.isDefault) ??
        providers[0]);
    if (!cfg) return { error: 'NO_PROVIDER_CONFIGURED' };

    const requestId = randomUUID();
    this.runIds.set(sessionId, requestId);
    if (session.title === '') {
      this.deps.saveSession({ ...session, title: text.slice(0, 30) });
    }
    const runPromise = this.run(sessionId, text, requestId, cfg);
    this.runPromises.set(sessionId, runPromise);
    void runPromise;
    return { requestId };
  }

  stop(sessionId: string): void {
    this.clearTimer(sessionId);
    // 使当前 run 失效：被 abort 的 prompt/continue 以 stopReason 'aborted' 收尾并 resolve，
    // run 循环在 resolve 后的 runIds 校验里检测到失效，静默放弃（不发 done/error、不 persist）。
    this.runIds.delete(sessionId);
    this.agents.get(sessionId)?.abort();
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.agents.get(sessionId)?.waitForIdle();
    // run() 在 agent run 结算之后还要 persist + 发 done 事件，
    // 所以额外等 run() 自身的 promise，保证调用方看到完整终态。
    await this.runPromises.get(sessionId);
  }

  private resolveProvider(cfg: AiProviderConfig): { model: ChatModel; apiKey: string } {
    return {
      model: buildChatModel(cfg, getProviderDef(cfg.registryId)),
      apiKey: this.deps.decryptKey(cfg.apiKeyEncrypted),
    };
  }

  private getOrCreateAgent(session: ChatSession, cfg: AiProviderConfig): Agent {
    const cached = this.agents.get(session.id);
    if (cached) return cached;
    const { model, apiKey } = this.resolveProvider(cfg);
    const tools = buildChatTools(
      () => this.deps.getData(),
      () => this.deps.today(),
    );
    const buildAgent = (streamFn: unknown, m: ChatModel) =>
      new Agent({
        initialState: {
          systemPrompt: CHAT_SYSTEM_PROMPT,
          model: m,
          tools,
          messages: session.messages as AgentMessage[],
        },
        streamFn: streamFn as never,
      });
    const agent = this.deps.createAgent
      ? this.deps.createAgent({ session, buildAgent })
      : buildAgent(createChatStreamFn(apiKey), model);
    this.subscribeAgent(agent, session.id);
    this.agents.set(session.id, agent);
    return agent;
  }

  private subscribeAgent(agent: Agent, sessionId: string): void {
    agent.subscribe((event) => {
      // 事件归属按 run 作用域取值：run() 在开始执行时写入 agentRunIds，
      // 避免用 session 级 runIds 实时读取导致旧 run 的迟到 chunk 被标成新 run 的 requestId。
      const requestId = this.agentRunIds.get(agent) ?? '';
      switch (event.type) {
        case 'message_update': {
          const inner = event.assistantMessageEvent;
          if (inner.type === 'text_delta') {
            this.armTimer(sessionId, IDLE_TIMEOUT_MS, 'IDLE_TIMEOUT');
            this.deps.sink.chunk(sessionId, requestId, inner.delta);
          }
          break;
        }
        case 'tool_execution_start': {
          this.deps.sink.tool({
            sessionId,
            requestId,
            toolCallId: event.toolCallId,
            name: event.toolName,
            status: 'running',
            args: event.args,
          });
          break;
        }
        case 'tool_execution_end': {
          const text = event.result?.content?.[0]?.text ?? '';
          this.deps.sink.tool({
            sessionId,
            requestId,
            toolCallId: event.toolCallId,
            name: event.toolName,
            status: event.isError ? 'error' : 'done',
            resultSummary: text.slice(0, 200),
          });
          break;
        }
      }
    });
  }

  private async run(
    sessionId: string,
    text: string,
    requestId: string,
    cfg: AiProviderConfig,
  ): Promise<void> {
    const session = this.deps.getSessions().find((s) => s.id === sessionId);
    if (!session) return;
    const agent = this.getOrCreateAgent(session, cfg);
    this.deps.sink.status({ sessionId, requestId, status: 'running' });
    this.armTimer(sessionId, FIRST_TOKEN_TIMEOUT_MS, 'FIRST_TOKEN_TIMEOUT', () => agent.abort());
    // 事件归属：仅当 agent 空闲时把本次 run 的 requestId 绑定到订阅映射。
    // 若 agent 正忙（例如并发 send），本次 run 会立即失败，不应抢占当前执行中 run 的事件标签。
    if (!agent.state.isStreaming) this.agentRunIds.set(agent, requestId);

    let attempt = 0;
    for (;;) {
      try {
        if (attempt === 0) await agent.prompt(text);
        else await agent.continue();
      } catch (err) {
        // 拒绝路径（agent 抛出的真实错误，如 "already processing"、监听器异常）
        if (this.runIds.get(sessionId) !== requestId) {
          // run 已失效（用户 stop / 超时 / 新 send 抢占）：静默放弃
          this.clearTimer(sessionId);
          this.stripErrorTail(sessionId);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          attempt += 1;
          this.deps.logger.info({ action: 'chat:retry', sessionId, attempt, error: message });
          this.deps.sink.status({ sessionId, requestId, status: 'retrying', attempt });
          continue;
        }
        this.clearTimer(sessionId);
        this.persist(sessionId, agent);
        this.deps.sink.status({ sessionId, requestId, status: 'failed', error: message });
        this.deps.sink.error({ sessionId, requestId, error: message });
        this.deps.logger.error({ action: 'chat:error', sessionId, error: message });
        return;
      }

      // pi-agent-core 在 abort / 流式失败时也会 RESOLVE（以 stopReason 'aborted'/'error'
      // 的 assistant 消息收尾），所以 resolve 后必须检查 run 是否仍有效 + 终态是否错误。
      if (this.runIds.get(sessionId) !== requestId) {
        // run 已失效（用户 stop / 超时 / 新 send 抢占）：
        // 不发 done/error、不 persist 被中止的尾部消息
        this.clearTimer(sessionId);
        this.stripErrorTail(sessionId);
        return;
      }
      if (this.isErrorOutcome(agent)) {
        const message = agent.state.errorMessage ?? 'AI provider error';
        if (attempt < MAX_RETRIES) {
          attempt += 1;
          // 移除错误 assistant 尾部消息后 continue() 才能通过
          // （pi-agent-core 不允许从 assistant 消息继续）
          this.stripErrorTail(sessionId);
          this.deps.logger.info({ action: 'chat:retry', sessionId, attempt, error: message });
          this.deps.sink.status({ sessionId, requestId, status: 'retrying', attempt });
          continue;
        }
        this.clearTimer(sessionId);
        this.persist(sessionId, agent);
        this.deps.sink.status({ sessionId, requestId, status: 'failed', error: message });
        this.deps.sink.error({ sessionId, requestId, error: message });
        this.deps.logger.error({ action: 'chat:error', sessionId, error: message });
        return;
      }
      break;
    }
    this.clearTimer(sessionId);
    this.persist(sessionId, agent);
    this.deps.sink.done(sessionId, requestId);
  }

  /** 最近一次 run 是否以错误/中止收尾（最后一条 assistant 消息 stopReason 为 error/aborted，或 state.errorMessage 已置位）。 */
  private isErrorOutcome(agent: Agent): boolean {
    const messages = agent.state.messages as AgentMessage[];
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') {
      const reason = last.stopReason;
      if (reason === 'error' || reason === 'aborted') return true;
    }
    return agent.state.errorMessage !== undefined;
  }

  /** 移除 transcript 末尾的 assistant error/aborted 消息（pi-agent-core 失败/中止时追加的），
   *  避免它在后续 run 中继续污染转录或被持久化。 */
  private stripErrorTail(sessionId: string): void {
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    const messages = agent.state.messages as AgentMessage[];
    const last = messages[messages.length - 1];
    if (
      last?.role === 'assistant' &&
      (last.stopReason === 'error' || last.stopReason === 'aborted')
    ) {
      agent.state.messages = messages.slice(0, -1);
    }
  }

  private persist(sessionId: string, agent: Agent): void {
    const session = this.deps.getSessions().find((s) => s.id === sessionId);
    if (!session) return;
    this.deps.saveSession({
      ...session,
      updatedAt: Date.now(),
      messages: agent.state.messages as unknown[],
    });
  }

  private armTimer(
    sessionId: string,
    ms: number,
    errorCode: 'FIRST_TOKEN_TIMEOUT' | 'IDLE_TIMEOUT',
    onTimeout?: () => void,
  ): void {
    this.clearTimer(sessionId);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        const requestId = this.runIds.get(sessionId);
        // 先使 run 失效：被 abort 的 prompt/continue 不再重试
        this.runIds.delete(sessionId);
        this.deps.sink.error({ sessionId, requestId, error: errorCode });
        (onTimeout ?? (() => this.stop(sessionId)))();
      }, ms),
    );
  }

  private clearTimer(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) clearTimeout(t);
    this.timers.delete(sessionId);
  }
}
