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
  private runIds = new Map<string, string>(); // sessionId -> 当前 requestId
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
    // 使当前 run 失效：被 abort 的 prompt/continue 落入重试分支时直接放弃
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
      const requestId = this.runIds.get(sessionId) ?? '';
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

    let attempt = 0;
    for (;;) {
      try {
        if (attempt === 0) await agent.prompt(text);
        else await agent.continue();
        break;
      } catch (err) {
        // run 已失效（用户 stop / 新的 send / 超时触发）：放弃重试与失败上报
        if (this.runIds.get(sessionId) !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          attempt += 1;
          this.deps.logger.info({ action: 'chat:retry', sessionId, attempt, error: message });
          this.deps.sink.status({ sessionId, requestId, status: 'retrying', attempt });
        } else {
          this.persist(sessionId, agent);
          this.deps.sink.status({ sessionId, requestId, status: 'failed', error: message });
          this.deps.sink.error({ sessionId, requestId, error: message });
          this.deps.logger.error({ action: 'chat:error', sessionId, error: message });
          return;
        }
      }
    }
    this.clearTimer(sessionId);
    this.persist(sessionId, agent);
    this.deps.sink.done(sessionId, requestId);
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
