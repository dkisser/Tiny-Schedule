import { describe, expect, test } from 'bun:test';
import {
  ChatContinueReqSchema,
  ChatSendReqSchema,
  ChatSessionCreateReqSchema,
  ChatSessionDeleteReqSchema,
  ChatStatusEventSchema,
  ChatStopReqSchema,
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
