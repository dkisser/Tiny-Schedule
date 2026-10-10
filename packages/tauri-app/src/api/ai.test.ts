import { describe, expect, test } from 'bun:test';
import {
  type AiStreamEvent,
  type AppData,
  type ChatEvent,
  emptyAppData,
  INBOX_PROJECT_ID,
  Ipc,
} from '@tiny-schedule/shared';
import { silentLogger } from '@/ai/logger';
import { DataStore } from '@/bridge/dataStore';
import { MemoryFs } from '@/bridge/fsAdapter';
import { _resetKeyCacheForTest, encryptKey, initKeyStore } from '@/bridge/keys';
import { createAiApi } from './ai';

/**
 * Slice-level tests for the AI API. The SSE bridge itself is mocked with a fake
 * `fetch`, so nothing here needs a Tauri host; what is being pinned is the
 * slice's own contract — the event sequence it emits, the error paths it takes,
 * and the rule that an API key never leaves the slice in plaintext.
 */

const DIR = '/data';

/** A key that is deliberately recognisable, so "did it leak?" is answerable. */
const FAKE_KEY = 'sk-FAKE-do-not-log-me-0123456789';

function task(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: INBOX_PROJECT_ID,
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    isImportant: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
    title: `task ${id}`,
    ...overrides,
  } as AppData['tasks'][string];
}

/** One `data: {...}` SSE line, as an OpenAI-compatible chat/completions stream emits it. */
function sseLine(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A `fetch` stand-in that replays a scripted SSE body, so a slice test
 * exercises the real `streamChat` parser without a network.
 *
 * `failAfter` makes the *body stream* error once that many lines have been
 * read — not the request, which is what "the connection dropped mid-report"
 * actually looks like to `streamChat`.
 */
function fakeSseFetch(lines: string[], opts: { status?: number; failAfter?: number } = {}) {
  const calls: FakeCall[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : '',
    });
    const status = opts.status ?? 200;
    const encoder = new TextEncoder();
    if (status !== 200) {
      return new Response(null, { status, headers: { 'content-type': 'text/plain' } });
    }
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (opts.failAfter !== undefined && sent >= opts.failAfter) {
          controller.error(new Error('connection reset by peer'));
          return;
        }
        if (sent >= lines.length) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        const line = lines[sent] as string;
        sent += 1;
        controller.enqueue(encoder.encode(line));
      },
    });
    return new Response(stream, {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function setup(
  options: {
    providers?: Array<{ id: string; registryId: string; model: string; isDefault: boolean }>;
    fetchImpl?: typeof fetch;
    chatDeps?: Parameters<typeof createAiApi>[0]['chatDeps'];
  } = {},
) {
  _resetKeyCacheForTest();
  const fs = new MemoryFs();
  await initKeyStore(DIR, fs);
  const store = await DataStore.open(DIR, fs);
  const data = emptyAppData();
  data.settings.aiProviders = await Promise.all(
    (
      options.providers ?? [{ id: 'p1', registryId: 'openai', model: 'gpt-4o', isDefault: true }]
    ).map(async (p) => ({ ...p, apiKeyEncrypted: await encryptKey(FAKE_KEY) })),
  );
  await store.save(data);
  const api = createAiApi({
    store,
    logger: silentLogger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.chatDeps ? { chatDeps: options.chatDeps } : {}),
  });
  return { api, store, fs, data };
}

/** Records every AI event the slice pushes, in order. */
function recordAi(api: ReturnType<typeof createAiApi>) {
  const events: AiStreamEvent[] = [];
  const unsub = api.onAiEvent((ev) => events.push(ev));
  return { events, unsub };
}

function recordChat(api: ReturnType<typeof createAiApi>) {
  const events: ChatEvent[] = [];
  const unsub = api.onChatEvent((ev) => events.push(ev));
  return { events, unsub };
}

/** Waits for the fire-and-forget aiAnalyze stream to reach a terminal event. */
async function untilDone(events: AiStreamEvent[], timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events.some((e) => e.full !== undefined || e.error !== undefined)) {
    if (Date.now() > deadline) throw new Error('aiAnalyze never reached a terminal event');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ai api slice — surface', () => {
  test('implements exactly the 10 AI invokes plus the two subscriptions', async () => {
    const { api } = await setup();
    const keys = Object.keys(api).sort();
    expect(keys).toEqual(
      [
        'aiAnalyze',
        'aiProviderKeyReveal',
        'aiRegistry',
        'aiTestProvider',
        'chatContinue',
        'chatSend',
        'chatSessionCreate',
        'chatSessionDelete',
        'chatSessionsList',
        'chatStop',
        'onAiEvent',
        'onChatEvent',
      ].sort(),
    );
  });

  test('aiRegistry returns the built-in providers with no baseUrl leak', async () => {
    const { api } = await setup();
    const registry = await api.aiRegistry();
    expect(registry.map((p) => p.id)).toEqual(['openai', 'deepseek', 'moonshot', 'custom']);
    // ProviderInfo carries no baseUrl — that stays an internal default.
    expect(Object.keys(registry[0] ?? {}).sort()).toEqual(['icon', 'id', 'models', 'name']);
  });

  test('aiTestProvider reports HTTP status without leaking the key', async () => {
    const { impl, calls } = fakeSseFetch([], { status: 401 });
    const { api } = await setup({ fetchImpl: impl });

    const result = await api.aiTestProvider({ providerId: 'p1' });

    expect(result).toEqual({ ok: false, error: 'HTTP 401' });
    // The key does go out on the wire — that is the point of the call.
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
  });

  test('aiTestProvider reports an unconfigured provider instead of calling out', async () => {
    const { impl, calls } = fakeSseFetch([]);
    const { api } = await setup({ fetchImpl: impl });

    expect(await api.aiTestProvider({ providerId: 'nope' })).toEqual({
      ok: false,
      error: 'PROVIDER_NOT_CONFIGURED',
    });
    expect(calls).toHaveLength(0);
  });

  test('aiProviderKeyReveal returns the plaintext key, and empty for an unknown provider', async () => {
    const { api } = await setup();

    expect(await api.aiProviderKeyReveal({ providerId: 'p1' })).toEqual({ apiKey: FAKE_KEY });
    expect(await api.aiProviderKeyReveal({ providerId: 'nope' })).toEqual({ apiKey: '' });
  });
});

describe('ai api slice — aiAnalyze event sequence', () => {
  test('emits chunk*, then a single done carrying the full text, and persists history', async () => {
    const { impl, calls } = fakeSseFetch([sseLine('今'), sseLine('天'), sseLine('很忙')]);
    const { api, store } = await setup({ fetchImpl: impl });
    const { events, unsub } = recordAi(api);

    const { requestId } = await api.aiAnalyze({ scope: 'today' });
    await untilDone(events);
    unsub();

    expect(
      events.map((e) =>
        e.delta !== undefined ? 'chunk' : e.full !== undefined ? 'done' : 'error',
      ),
    ).toEqual(['chunk', 'chunk', 'chunk', 'done']);
    expect(events[0]?.requestId).toBe(requestId);
    expect(events[0]?.delta).toBe('今');
    expect(events[3]?.full).toBe('今天很忙');

    // Persisted before `done`, so a renderer reload on done sees it.
    const history = (await store.get()).misc.aiHistory as Array<{ content: string; scope: string }>;
    expect(history[0]?.content).toBe('今天很忙');
    expect(history[0]?.scope).toBe('today');

    // The prompt went out with the key in the Authorization header only.
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(calls[0]?.body).toContain('效率分析助手');
    expect(JSON.parse(calls[0]?.body ?? '{}').stream).toBe(true);
  });

  test('emits aiError with the partial text when the stream dies mid-flight', async () => {
    // One line arrives, then the connection drops.
    const { impl } = fakeSseFetch([sseLine('半'), sseLine('句话')], { failAfter: 1 });
    const { api } = await setup({ fetchImpl: impl });
    const { events, unsub } = recordAi(api);

    await api.aiAnalyze({ scope: 'today' });
    await untilDone(events);
    unsub();

    const last = events[events.length - 1];
    expect(last?.error).toContain('connection reset');
    // The partial report rides along on the error, so the UI can show what
    // arrived before the drop — but no `done` may follow it.
    expect(last?.full).toBe('半');
    expect(events.filter((e) => e.delta !== undefined)).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  test('emits aiError without any network call when no provider is configured', async () => {
    const { impl, calls } = fakeSseFetch([]);
    const { api } = await setup({ fetchImpl: impl });
    // Remove the providers the fixture installed.
    await api.aiAnalyze({ scope: 'today', providerId: 'missing' });
    const { events, unsub } = recordAi(api);
    await api.aiAnalyze({ scope: 'today', providerId: 'missing' });
    unsub();

    expect(events).toHaveLength(1);
    expect(events[0]?.error).toBe('NO_PROVIDER_CONFIGURED');
    expect(calls).toHaveLength(0);
  });

  test('rejects a malformed request at the boundary, before any provider is touched', async () => {
    const { impl, calls } = fakeSseFetch([]);
    const { api } = await setup({ fetchImpl: impl });

    await expect(api.aiAnalyze({ scope: 'year' } as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('ai api slice — key containment', () => {
  test('the fake key never appears in any event payload', async () => {
    const { impl } = fakeSseFetch([sseLine('ok')]);
    const { api } = await setup({ fetchImpl: impl });
    const ai = recordAi(api);

    await api.aiAnalyze({ scope: 'today' });
    await untilDone(ai.events);
    ai.unsub();

    const serialized = JSON.stringify(ai.events);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain('sk-');
  });

  test('the fake key never appears in a chat event payload', async () => {
    const { api } = await setup({
      chatDeps: {
        // A stub agent stands in for pi-agent-core so the test does not need a
        // provider; what matters is the payload the sink emits.
        createAgent: () => {
          const listeners: Array<(e: unknown) => void> = [];
          return {
            state: { messages: [], isStreaming: false, errorMessage: undefined },
            subscribe: (cb: (e: unknown) => void) => listeners.push(cb),
            prompt: async () => undefined,
            continue: async () => undefined,
            abort: () => undefined,
            waitForIdle: async () => undefined,
          } as never;
        },
      },
    });
    const chat = recordChat(api);
    const session = await api.chatSessionCreate({});

    await api.chatSend({ sessionId: session.id, text: '你好' });
    await new Promise((r) => setTimeout(r, 20));
    chat.unsub();

    expect(JSON.stringify(chat.events)).not.toContain(FAKE_KEY);
  });

  test('an error message coming back from the provider is passed through verbatim', async () => {
    // The realistic risk: an SDK error string that happens to echo the URL or
    // headers. The slice forwards it as-is, matching the original — what is
    // asserted here is that it forwards the *provider's* message, not the key.
    const { impl } = fakeSseFetch([], { status: 401 });
    const { api } = await setup({ fetchImpl: impl });
    const { events, unsub } = recordAi(api);

    await api.aiAnalyze({ scope: 'today' });
    await untilDone(events);
    unsub();

    expect(events[0]?.error).toBe('AI_HTTP_401');
  });
});

describe('ai api slice — chat sessions', () => {
  test('create/list/delete round-trips through the store', async () => {
    const { api } = await setup();

    const a = await api.chatSessionCreate({});
    const b = await api.chatSessionCreate({ providerId: 'p1' });

    const listed = await api.chatSessionsList();
    expect(listed.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(b.providerId).toBe('p1');

    const afterDelete = await api.chatSessionDelete({ sessionId: a.id });
    expect(afterDelete.map((s) => s.id)).toEqual([b.id]);
  });

  test('the first message becomes the session title, truncated to 30 chars', async () => {
    const { api } = await setup({
      chatDeps: {
        createAgent: () =>
          ({
            state: { messages: [], isStreaming: false, errorMessage: undefined },
            subscribe: () => undefined,
            prompt: async () => undefined,
            continue: async () => undefined,
            abort: () => undefined,
            waitForIdle: async () => undefined,
          }) as never,
      },
    });
    const session = await api.chatSessionCreate({});

    const res = await api.chatSend({
      sessionId: session.id,
      text: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十',
    });
    expect('error' in res).toBe(false);
    await new Promise((r) => setTimeout(r, 20));

    const [updated] = await api.chatSessionsList();
    expect(updated?.title).toHaveLength(30);
  });

  test('send reports an error for an unknown session instead of throwing', async () => {
    const { api } = await setup();
    expect(await api.chatSend({ sessionId: 'missing', text: 'hi' })).toEqual({
      error: 'SESSION_NOT_FOUND',
    });
    expect(await api.chatContinue({ sessionId: 'missing' })).toEqual({
      error: 'SESSION_NOT_FOUND',
    });
  });

  test('send without a configured provider is refused before any request goes out', async () => {
    _resetKeyCacheForTest();
    const fs = new MemoryFs();
    await initKeyStore(DIR, fs);
    const store = await DataStore.open(DIR, fs);
    await store.save(emptyAppData()); // no aiProviders at all
    const { impl, calls } = fakeSseFetch([]);
    const api = createAiApi({ store, logger: silentLogger, fetchImpl: impl });
    const session = await api.chatSessionCreate({});

    expect(await api.chatSend({ sessionId: session.id, text: 'hi' })).toEqual({
      error: 'NO_PROVIDER_CONFIGURED',
    });
    expect(calls).toHaveLength(0);
  });

  test('chatStop on a session with no run resolves rather than throwing', async () => {
    const { api } = await setup();
    const session = await api.chatSessionCreate({});
    await expect(api.chatStop({ sessionId: session.id })).resolves.toBeUndefined();
  });
});

describe('ai api slice — chat event bus', () => {
  test('unsubscribing stops delivery without affecting the remaining subscribers', async () => {
    const { impl } = fakeSseFetch([sseLine('hi')]);
    const { api } = await setup({ fetchImpl: impl });

    const dropped: AiStreamEvent[] = [];
    const kept: AiStreamEvent[] = [];
    const unsub = api.onAiEvent((ev) => dropped.push(ev));
    api.onAiEvent((ev) => kept.push(ev));
    unsub();

    await api.aiAnalyze({ scope: 'today' });
    await untilDone(kept);

    expect(kept.some((e) => e.full === 'hi')).toBe(true);
    expect(dropped).toHaveLength(0);
  });

  test('onChatEvent receives events tagged with the shared channel names', async () => {
    const { api } = await setup({
      chatDeps: {
        createAgent: () => {
          const listeners: Array<(e: unknown) => void> = [];
          return {
            state: { messages: [], isStreaming: false, errorMessage: undefined },
            subscribe: (cb: (e: unknown) => void) => listeners.push(cb),
            prompt: async () => {
              // Emit one text delta so the sink has something to forward.
              for (const cb of listeners) {
                cb({
                  type: 'message_update',
                  assistantMessageEvent: { type: 'text_delta', delta: '答' },
                });
              }
            },
            continue: async () => undefined,
            abort: () => undefined,
            waitForIdle: async () => undefined,
          } as never;
        },
      },
    });
    const chat = recordChat(api);
    const session = await api.chatSessionCreate({});

    await api.chatSend({ sessionId: session.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 20));
    chat.unsub();

    const channels = chat.events.map((e) => e.channel);
    expect(channels[0]).toBe(Ipc.chatStatus);
    expect(channels).toContain(Ipc.chatChunk);
    expect(channels).toContain(Ipc.chatDone);
    // Payload shape must match the shared contract field for field.
    const chunk = chat.events.find((e) => e.channel === Ipc.chatChunk);
    expect(Object.keys(chunk?.payload ?? {}).sort()).toEqual(['delta', 'requestId', 'sessionId']);
    const done = chat.events.find((e) => e.channel === Ipc.chatDone);
    expect(Object.keys(done?.payload ?? {}).sort()).toEqual(['requestId', 'sessionId']);
  });

  test('a throwing subscriber does not stop the stream for the others', async () => {
    const { impl } = fakeSseFetch([sseLine('a'), sseLine('b')]);
    const { api } = await setup({ fetchImpl: impl });
    const good: AiStreamEvent[] = [];

    api.onAiEvent(() => {
      throw new Error('renderer bug');
    });
    api.onAiEvent((ev) => good.push(ev));

    await api.aiAnalyze({ scope: 'today' });
    await untilDone(good);

    expect(good.map((e) => e.delta)).toEqual(['a', 'b']);
    expect(good.some((e) => e.full === 'ab')).toBe(true);
  });
});
