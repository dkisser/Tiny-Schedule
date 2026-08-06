import { describe, expect, test } from 'bun:test';
import { streamChat } from '../src/main/ai/client';

function sseStream(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(encoder.encode(chunks[i] as string));
      i += 1;
    },
  });
}

const okHeaders = { 'content-type': 'text/event-stream' };

function fakeFetch(body: ReadableStream<Uint8Array>, status = 200): typeof fetch {
  // Bun's typeof fetch carries extra props (e.g. preconnect); cast the fake for convenience.
  return (async (_url: string, _init: RequestInit): Promise<Response> =>
    new Response(body, { status, headers: okHeaders })) as typeof fetch;
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const c of gen) out += c;
  return out;
}

describe('streamChat', () => {
  test('yields deltas from SSE lines and stops at [DONE]', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\ndata: [DONE]\n\n',
    ]);
    const gen = streamChat({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch(body),
    });
    expect(await collect(gen)).toBe('你好，世界');
  });

  test('handles chunks split across SSE boundaries', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"cont',
      'ent":"AB"}}]}\n\ndata: [DONE]\n\n',
    ]);
    const gen = streamChat({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch(body),
    });
    expect(await collect(gen)).toBe('AB');
  });

  test('throws AI_HTTP_401 on unauthorized', async () => {
    const gen = streamChat({
      baseUrl: 'http://x/v1',
      apiKey: 'bad',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch(sseStream([]), 401),
    });
    await expect(collect(gen)).rejects.toThrow('AI_HTTP_401');
  });

  test('throws FIRST_TOKEN_TIMEOUT when no data arrives', async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stalled = new ReadableStream<Uint8Array>({
      // never enqueues on its own — hangs until aborted
      start(controller) {
        ctl = controller;
      },
    });
    // Real fetch errors the body stream when the signal aborts; simulate that.
    const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
      init.signal?.addEventListener('abort', () => {
        ctl.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
      return new Response(stalled, { status: 200, headers: okHeaders });
    };
    const gen = streamChat({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fetchImpl as typeof fetch,
      firstTokenTimeoutMs: 50,
    });
    await expect(collect(gen)).rejects.toThrow('FIRST_TOKEN_TIMEOUT');
  });

  test('slow but steady stream is NOT aborted', async () => {
    const body = sseStream(
      [
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
        'data: [DONE]\n\n',
      ],
      30,
    ); // each chunk slower than idle check granularity but under idle timeout
    const gen = streamChat({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch(body),
      firstTokenTimeoutMs: 500,
      idleTimeoutMs: 500,
    });
    expect(await collect(gen)).toBe('ab');
  });

  test('propagates fetch rejection unrelated to timeout', async () => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const gen = streamChat({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });
    await expect(collect(gen)).rejects.toThrow('network down');
  });

  test('sends expected request shape', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fetchImpl = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(sseStream(['data: [DONE]\n\n']), { status: 200, headers: okHeaders });
    };
    await collect(
      streamChat({
        baseUrl: 'http://x/v1',
        apiKey: 'sk-1',
        model: 'gpt-x',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );
    expect(captured.url).toBe('http://x/v1/chat/completions');
    expect(((captured.init?.headers ?? {}) as Record<string, string>).Authorization).toBe(
      'Bearer sk-1',
    );
    const body = JSON.parse((captured.init?.body ?? '') as string);
    expect(body.model).toBe('gpt-x');
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toBe('hi');
  });
});
