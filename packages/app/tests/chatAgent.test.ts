import { describe, expect, test } from 'bun:test';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import type { ChatSession } from '@tiny-schedule/shared';
import type { ChatEventSink } from '../src/main/ai/chatAgent';
import { ChatAgentManager } from '../src/main/ai/chatAgent';

type SetupOptions = {
  /** 'default': 工具调用 + 文本答案两轮；'error': 每次调用都返回 stopReason 'error'；'slow': 慢速流式响应（保持 run in-flight） */
  script?: 'default' | 'error' | 'slow';
};

function setup(options: SetupOptions = {}) {
  const { script = 'default' } = options;
  const sessions: ChatSession[] = [];
  const events: { kind: string; payload: unknown }[] = [];
  const sink: ChatEventSink = {
    chunk: (sessionId, requestId, delta) => events.push({ kind: 'chunk', payload: delta }),
    tool: (ev) => events.push({ kind: 'tool', payload: ev }),
    status: (ev) => events.push({ kind: 'status', payload: ev }),
    done: (sessionId, requestId) =>
      events.push({ kind: 'done', payload: { sessionId, requestId } }),
    error: (ev) => events.push({ kind: 'error', payload: ev }),
  };
  const logger = { info: () => {}, error: () => {} } as never;
  const manager = new ChatAgentManager({
    getSessions: () => sessions,
    saveSession: (s) => {
      const i = sessions.findIndex((x) => x.id === s.id);
      if (i >= 0) sessions[i] = s;
      else sessions.push(s);
    },
    deleteStoredSession: (id) => {
      const next = sessions.filter((s) => s.id !== id);
      sessions.length = 0;
      sessions.push(...next);
      return next;
    },
    getProviders: () => [
      {
        id: 'p1',
        registryId: 'custom',
        apiKeyEncrypted: '',
        baseUrl: 'http://x',
        model: 'm',
        isDefault: true,
      },
    ],
    decryptKey: () => 'sk-test',
    today: () => '2026-08-04',
    getData: () => ({
      version: 1,
      tasks: {},
      projects: {},
      tags: {},
      timeTracking: null,
      notes: null,
      planner: null,
      metric: null,
      boards: null,
      misc: {},
      settings: {
        userName: '',
        avatar: null,
        theme: 'system',
        aiProviders: [],
        aiPrompt: '',
        autoAiAnalyzeOnFinishDay: false,
      },
      activeTimer: null,
    }),
    sink,
    logger,
    // 测试注入：用 faux provider 替代真实 openai-completions 调用。
    // 脚本在钩子内部注入（两轮响应：先调 listProjects 工具，再给文本答案），
    // 测试不需要持有 faux 引用。
    createAgent: (opts) => {
      const faux = fauxProvider(script === 'slow' ? { tokensPerSecond: 20 } : undefined);
      const models = createModels();
      models.setProvider(faux.provider);
      if (script === 'error') {
        // 每次 provider 调用都返回 stopReason 'error'（流式失败，run 会 resolve 而不是 reject）。
        // faux 每次 stream 调用消费一条脚本响应，重试共 3 次调用，故脚本 3 条错误。
        faux.setResponses([
          fauxAssistantMessage('provider exploded', {
            stopReason: 'error',
            errorMessage: 'provider exploded',
          }),
          fauxAssistantMessage('provider exploded', {
            stopReason: 'error',
            errorMessage: 'provider exploded',
          }),
          fauxAssistantMessage('provider exploded', {
            stopReason: 'error',
            errorMessage: 'provider exploded',
          }),
        ]);
      } else if (script === 'slow') {
        faux.setResponses([fauxAssistantMessage('慢速长响应 ' + 'x'.repeat(300))]);
      } else {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('listProjects', {})]),
          fauxAssistantMessage('你还没有创建任何项目。'),
        ]);
      }
      return opts.buildAgent(models.streamSimple.bind(models), faux.getModel() as never);
    },
  });
  return { manager, sessions, events };
}

describe('ChatAgentManager', () => {
  test('createSession persists and listSessions sorts by updatedAt', () => {
    const { manager, sessions } = setup();
    const s = manager.createSession();
    expect(sessions).toHaveLength(1);
    expect(manager.listSessions()[0]?.id).toBe(s.id);
  });

  test('send without provider returns NO_PROVIDER_CONFIGURED', async () => {
    const { manager } = setup();
    const s = manager.createSession();
    // 用 providerId 指向不存在的 provider 验证同样的错误路径
    const res = await manager.send(s.id, '你好', 'nonexistent');
    expect(res).toEqual({ error: 'NO_PROVIDER_CONFIGURED' });
  });

  test('send streams text, runs tool, persists messages, emits done', async () => {
    const { manager, sessions, events } = setup();
    const s = manager.createSession();
    const res = await manager.send(s.id, '看看我的项目');
    expect('requestId' in res).toBe(true);
    await manager.waitForIdle(s.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('tool');
    expect(kinds).toContain('chunk');
    expect(kinds[kinds.length - 1]).toBe('done');
    expect((sessions[0]?.messages ?? []).length).toBeGreaterThan(0);
    expect(sessions[0]?.title).toBe('看看我的项目');
  });

  test('deleteSession removes stored session', () => {
    const { manager, sessions } = setup();
    const s = manager.createSession();
    manager.deleteSession(s.id);
    expect(sessions).toHaveLength(0);
  });

  test('stop mid-run: no done event and no aborted tail persisted', async () => {
    const { manager, sessions, events } = setup({ script: 'slow' });
    const s = manager.createSession();
    const res = await manager.send(s.id, '慢速响应，用于测试 stop');
    expect('requestId' in res).toBe(true);
    manager.stop(s.id);
    await manager.waitForIdle(s.id);
    const kinds = events.map((e) => e.kind);
    // 用户 stop 后：不发 done、不发 error、不进入 retrying/failed
    expect(kinds).not.toContain('done');
    expect(kinds).not.toContain('error');
    const statuses = events
      .filter((e) => e.kind === 'status')
      .map((e) => (e.payload as { status: string }).status);
    expect(statuses).toEqual(['running']);
    // 中止的 assistant 尾部消息（stopReason 'aborted'）不得持久化进 session
    expect(sessions[0]?.messages ?? []).toHaveLength(0);
  });

  test('provider stream error: retrying then failed + error, no done', async () => {
    const { manager, sessions, events } = setup({ script: 'error' });
    const s = manager.createSession();
    const res = await manager.send(s.id, '触发 provider 错误');
    expect('requestId' in res).toBe(true);
    await manager.waitForIdle(s.id);
    const statuses = events
      .filter((e) => e.kind === 'status')
      .map((e) => e.payload as { status: string; attempt?: number; error?: string });
    // 3 次 provider 调用全部失败：running → retrying(1) → retrying(2) → failed
    expect(statuses.map((st) => st.status)).toEqual(['running', 'retrying', 'retrying', 'failed']);
    expect(statuses.filter((st) => st.status === 'retrying').map((st) => st.attempt)).toEqual([
      1, 2,
    ]);
    expect(statuses[statuses.length - 1]).toMatchObject({
      status: 'failed',
      error: 'provider exploded',
    });
    const errors = events.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toMatchObject({ error: 'provider exploded' });
    expect(events.some((e) => e.kind === 'done')).toBe(false);
    // 重试耗尽后按规格 persist 转录
    expect((sessions[0]?.messages ?? []).length).toBeGreaterThan(0);
  });
});
