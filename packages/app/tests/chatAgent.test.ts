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

function setup() {
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
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('listProjects', {})]),
        fauxAssistantMessage('你还没有创建任何项目。'),
      ]);
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
});
