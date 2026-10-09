import { describe, expect, test } from 'bun:test';
import {
  ChatContinueReqSchema,
  ChatSendReqSchema,
  ChatSessionCreateReqSchema,
  ChatSessionDeleteReqSchema,
  ChatStatusEventSchema,
  ChatStopReqSchema,
  DROPPED_TIMER,
  IdeaUpgradeToProjectReqSchema,
  Ipc,
  ProjectCreateReqSchema,
  ProjectUpdateReqSchema,
  REFUSED_TIMER,
  TimerChangedPayloadSchema,
} from '../src/contract/ipc';
import { type AppData, AppDataSchema, emptyAppData } from '../src/domain/appData';
import { IdeaSchema } from '../src/domain/idea';
import { PROJECT_TITLE_MAX_LENGTH } from '../src/domain/project';
import { ActiveTimerSchema, settleTimer } from '../src/domain/task';

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

  test('an unrecognised status fails loudly instead of resurrecting a closed idea', () => {
    // Derivation treats a missing status as "not converted", i.e. open. So a
    // .catch() that downgraded an unknown value to undefined silently turned a
    // closed idea from a newer build back into an open one in the inbox — with
    // its verdict still attached and 完成/废弃 enabled. Throwing instead lets
    // readValidated fall back to the backup, which is the safe failure.
    expect(() => IdeaSchema.parse({ ...base, status: 'bogus' })).toThrow();
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

describe('ActiveTimerSchema — nothing the interface declares may be stripped', () => {
  const timer = {
    taskId: 't1',
    startedAt: 0,
    accumulatedMs: 0,
    isPaused: false,
    mode: 'pomodoro' as const,
    phase: 'focus' as const,
    cyclesCompleted: 1,
    focusAccumulatedMs: 1_500_000,
  };

  test('banked pomodoro focus survives a parse', () => {
    // A zod object strips keys it does not declare, and every save runs this
    // schema. Omitting the field here zeroed 25 minutes of focus at settlement
    // time — the migration that backfilled it was undone by the next save.
    expect(ActiveTimerSchema.parse(timer).focusAccumulatedMs).toBe(1_500_000);
  });

  test('and survives a whole-dataset parse, which is what save() runs', () => {
    const parsed = AppDataSchema.parse({ ...emptyAppData(), activeTimer: timer }) as AppData;
    expect(parsed.activeTimer?.focusAccumulatedMs).toBe(1_500_000);
    expect(settleTimer(parsed.activeTimer!, 1_500_000).ms).toBe(1_500_000);
  });
});

describe('timerChanged payloads — a drop and a refusal are different values', () => {
  test('the two branches parse, and parse to different things', () => {
    // The whole point of issue #20: under `ActiveTimer | null` the refused
    // auto-pause and the real drop were the same `null`, so the renderer could
    // only ever clear its TimerBar — which is wrong for a refusal, where main's
    // cache still holds the running session.
    expect(TimerChangedPayloadSchema.parse(DROPPED_TIMER)).toEqual({ kind: 'timer', timer: null });
    expect(TimerChangedPayloadSchema.parse(REFUSED_TIMER)).toEqual({
      kind: 'refused',
      reason: 'store-unwritable',
    });
    expect(DROPPED_TIMER).not.toEqual(REFUSED_TIMER);
  });

  test('the old wire format no longer parses', () => {
    // A bare ActiveTimer and a bare null are the shapes send sites used to
    // produce. If either parses again, a call site that was not migrated is
    // silently back on the ambiguous format instead of failing.
    expect(TimerChangedPayloadSchema.safeParse(null).success).toBe(false);
    expect(TimerChangedPayloadSchema.safeParse({ kind: 'timer', taskId: 't1' }).success).toBe(
      false,
    );
  });

  test('a refusal carries no timer to adopt', () => {
    // Nothing changed, so there is nothing to converge on — the same rule the
    // WRITE_REFUSED branch of TimingStopResult follows. A `timer` key on the
    // refused branch would give a reader something to clear the TimerBar with.
    expect(Object.hasOwn(REFUSED_TIMER, 'timer')).toBe(false);
  });
});

describe('project title length — the wire constraint and the enforced one agree', () => {
  const long = 'x'.repeat(PROJECT_TITLE_MAX_LENGTH + 10);

  test('a title past the enforced maximum is refused at the wire, not truncated', () => {
    // The schema used to allow 100 while the service sliced to 32: the user saw
    // "saved" for a name they never chose, and two ideas sharing a 32-char
    // prefix produced two identically-titled projects.
    expect(ProjectCreateReqSchema.safeParse({ title: long }).success).toBe(false);
    expect(IdeaUpgradeToProjectReqSchema.safeParse({ id: 'i1', title: long }).success).toBe(false);
    expect(ProjectUpdateReqSchema.safeParse({ id: 'p1', title: long }).success).toBe(false);
  });

  test('a title at the maximum still gets through', () => {
    const exact = 'x'.repeat(PROJECT_TITLE_MAX_LENGTH);
    expect(ProjectCreateReqSchema.safeParse({ title: exact }).success).toBe(true);
  });
});
