import { describe, expect, test } from 'bun:test';
import {
  ChatContinueReqSchema,
  ChatSendReqSchema,
  ChatSessionCreateReqSchema,
  ChatSessionDeleteReqSchema,
  ChatStatusEventSchema,
  ChatStopReqSchema,
  IdeaSchema,
  Ipc,
} from '../src/ipc';

describe('chat IPC schemas', () => {
  test('chat channels exist', () => {
    expect(Ipc.chatSessionsList).toBe('chat:sessionsList');
    expect(Ipc.chatSessionCreate).toBe('chat:sessionCreate');
    expect(Ipc.chatSessionDelete).toBe('chat:sessionDelete');
    expect(Ipc.chatSend).toBe('chat:send');
    expect(Ipc.chatStop).toBe('chat:stop');
    expect(Ipc.chatContinue).toBe('chat:continue');
    expect(Ipc.chatChunk).toBe('chat:chunk');
    expect(Ipc.chatToolEvent).toBe('chat:toolEvent');
    expect(Ipc.chatStatus).toBe('chat:status');
    expect(Ipc.chatDone).toBe('chat:done');
    expect(Ipc.chatError).toBe('chat:error');
  });

  test('chatSend requires non-empty text', () => {
    expect(ChatSendReqSchema.safeParse({ sessionId: 's1', text: '  ' }).success).toBe(false);
    expect(ChatSendReqSchema.parse({ sessionId: 's1', text: '你好' }).text).toBe('你好');
    expect(
      ChatSendReqSchema.parse({ sessionId: 's1', text: 'x', providerId: 'p' }).providerId,
    ).toBe('p');
  });

  test('session create/delete/stop schemas', () => {
    expect(ChatSessionCreateReqSchema.parse({}).providerId).toBeUndefined();
    expect(ChatSessionDeleteReqSchema.safeParse({}).success).toBe(false);
    expect(ChatStopReqSchema.parse({ sessionId: 's1' }).sessionId).toBe('s1');
  });

  test('chatContinue requires a sessionId', () => {
    expect(ChatContinueReqSchema.safeParse({}).success).toBe(false);
    expect(ChatContinueReqSchema.safeParse({ sessionId: '' }).success).toBe(false);
    expect(ChatContinueReqSchema.parse({ sessionId: 's1' }).sessionId).toBe('s1');
  });

  test('chatStatus event schema', () => {
    const ev = ChatStatusEventSchema.parse({ sessionId: 's', status: 'retrying', attempt: 1 });
    expect(ev.status).toBe('retrying');
    expect(ChatStatusEventSchema.safeParse({ sessionId: 's', status: 'bogus' }).success).toBe(
      false,
    );
  });
});

describe('IdeaSchema status migration', () => {
  const base = { id: 'i1', title: '想法', notes: '', createdAt: 1 };

  test('legacy ideas without status derive from convertedAt', () => {
    expect(IdeaSchema.parse(base).status).toBe('open');
    expect(IdeaSchema.parse({ ...base, convertedAt: 2 }).status).toBe('converted');
  });

  test('explicit status wins over derivation', () => {
    expect(IdeaSchema.parse({ ...base, status: 'incubating' }).status).toBe('incubating');
    expect(IdeaSchema.parse({ ...base, status: 'done', convertedAt: 2 }).status).toBe('done');
  });

  test('invalid status falls back to derivation', () => {
    expect(IdeaSchema.parse({ ...base, status: 'bogus' }).status).toBe('open');
  });

  test('new fields round-trip', () => {
    const parsed = IdeaSchema.parse({
      ...base,
      status: 'incubating',
      projectId: 'p1',
      validationGoal: '目标',
      timeline: [{ id: 'e1', createdAt: 3, text: '记录' }],
      incubatedAt: 2,
    });
    expect(parsed.projectId).toBe('p1');
    expect(parsed.timeline?.[0]?.text).toBe('记录');
    const closed = IdeaSchema.parse({
      ...base,
      status: 'closed',
      verdict: { result: 'partial', text: '一半', closedAt: 4 },
      resolvedAt: 4,
    });
    expect(closed.verdict?.result).toBe('partial');
  });
});
