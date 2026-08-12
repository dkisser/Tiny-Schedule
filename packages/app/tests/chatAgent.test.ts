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
  /** 覆盖超时阈值（ms），用于快速触发超时路径 */
  timeouts?: { firstTokenMs?: number; idleMs?: number };
};

function setup(options: SetupOptions = {}) {
  const { script = 'default', timeouts } = options;
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
  const faux = fauxProvider(script === 'slow' ? { tokensPerSecond: 20 } : undefined);
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
        idlePauseEnabled: true,
        idlePauseMinutes: 5,
      },
      activeTimer: null,
    }),
    sink,
    logger,
    ...(timeouts ? { timeouts } : {}),
    // 测试注入：用 faux provider 替代真实 openai-completions 调用。
    // 脚本在钩子内部注入（两轮响应：先调 listProjects 工具，再给文本答案），
    // 测试通过返回的 faux 句柄追加/替换脚本（如 continue 恢复场景）。
    createAgent: (opts) => {
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
  return { manager, sessions, events, faux };
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

  test('stop mid-run: no done/error, 用户提问与部分回答被持久化，可 continue 重新生成', async () => {
    const { manager, sessions, events, faux } = setup({ script: 'slow' });
    const s = manager.createSession();
    const res = await manager.send(s.id, '慢速响应，用于测试 stop');
    expect('requestId' in res).toBe(true);
    // 等首个 chunk（流式已在途）再 stop；真实场景用户点停止时必然已开始流式
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (events.some((e) => e.kind === 'chunk')) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
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
    // 消息不丢：用户提问 + aborted 尾部（含已流出的部分回答）持久化进 session
    const msgs = (sessions[0]?.messages ?? []) as { role?: string; stopReason?: string }[];
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1);
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe('assistant');
    expect(last?.stopReason).toBe('aborted');

    // reload（continue）重新生成：strip aborted 尾部，不新增 user 消息
    faux.setResponses([fauxAssistantMessage('重新生成成功')]);
    const continueRes = await manager.continue(s.id);
    expect('requestId' in continueRes).toBe(true);
    await manager.waitForIdle(s.id);
    const allKinds = events.map((e) => e.kind);
    expect(allKinds[allKinds.length - 1]).toBe('done');
    const msgs2 = (sessions[0]?.messages ?? []) as { role?: string; stopReason?: string }[];
    expect(msgs2.filter((m) => m.role === 'user')).toHaveLength(1);
    const last2 = msgs2[msgs2.length - 1];
    expect(last2?.role).toBe('assistant');
    expect(last2?.stopReason).not.toBe('aborted');
  });

  test('timeout mid-run: 发 error 但不持久化中断内容（区别于用户 stop）', async () => {
    const { manager, sessions, events } = setup({
      script: 'slow',
      timeouts: { firstTokenMs: 5, idleMs: 20 },
    });
    const s = manager.createSession();
    const res = await manager.send(s.id, '慢速响应，用于测试超时');
    expect('requestId' in res).toBe(true);
    await manager.waitForIdle(s.id);
    const errors = events.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(['FIRST_TOKEN_TIMEOUT', 'IDLE_TIMEOUT']).toContain(
      (errors[0]?.payload as { error: string }).error,
    );
    expect(events.some((e) => e.kind === 'done')).toBe(false);
    // 超时不属于用户 stop：中断内容不落盘
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

  test('continue with unknown session returns SESSION_NOT_FOUND', async () => {
    const { manager } = setup();
    // 会话不存在（无缓存 agent 不再报错：run() 会用持久化消息重建 agent）
    expect(await manager.continue('nonexistent')).toEqual({ error: 'SESSION_NOT_FOUND' });
  });

  test('continue after a failed run emits running -> done and adds no user message', async () => {
    const { manager, sessions, events, faux } = setup({ script: 'error' });
    const s = manager.createSession();
    const sendRes = await manager.send(s.id, '第一次触发 provider 错误');
    expect('requestId' in sendRes).toBe(true);
    await manager.waitForIdle(s.id);
    const statuses = events
      .filter((e) => e.kind === 'status')
      .map((e) => e.payload as { status: string });
    expect(statuses[statuses.length - 1]?.status).toBe('failed');
    const userCountBefore = (sessions[0]?.messages ?? []).filter(
      (m) => (m as { role?: string }).role === 'user',
    ).length;
    expect(userCountBefore).toBe(1);

    // provider 恢复后，continue() 复用同一套 run 机制（running -> done），
    // 但不新增 user 消息，也不改变会话标题。
    faux.setResponses([fauxAssistantMessage('重试成功')]);
    const continueRes = await manager.continue(s.id);
    expect('requestId' in continueRes).toBe(true);
    await manager.waitForIdle(s.id);

    const kinds = events.map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe('done');
    const userCountAfter = (sessions[0]?.messages ?? []).filter(
      (m) => (m as { role?: string }).role === 'user',
    ).length;
    expect(userCountAfter).toBe(userCountBefore);
    const last = sessions[0]?.messages?.at(-1) as { role?: string; content?: unknown };
    expect(last?.role).toBe('assistant');
    expect(sessions[0]?.title).toBe('第一次触发 provider 错误');
  });
});
