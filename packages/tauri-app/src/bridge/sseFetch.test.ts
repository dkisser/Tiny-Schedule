import { describe, expect, mock, test } from 'bun:test';
import * as realCore from '@tauri-apps/api/core';
import * as realEvent from '@tauri-apps/api/event';

/**
 * Unit tests for the stream plumbing in `sseFetch`, driven against a fake Tauri
 * IPC layer. The end-to-end path is covered separately by scripts/sse-mock.ts
 * driven through `tauri dev`; what is worth pinning here is the logic that
 * harness cannot easily reach — abort racing a pending header fetch, body
 * serialisation, and listener cleanup.
 */

interface SseEventPayload {
  kind: 'chunk' | 'done' | 'error';
  data?: number[];
  message?: string;
}

/** What the Rust host actually receives for one `sse_request`. */
interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  requestId: string;
}

interface FakeIpc {
  invokeCalls: Array<{ cmd: string; requestId?: string }>;
  /**
   * The `request` object of each `sse_request`, in call order.
   *
   * Recorded rather than merely counted. Without it the fake only proved that
   * *something* was invoked — so `sseFetch` could serialise a request body into
   * `"[object Object]"` and every test in this file still passed, since none of
   * them ever looked at what reached the host. The serialisation tests below
   * assert on these fields, which is what makes them able to fail.
   */
  requests: () => RecordedRequest[];
  /** Resolves the next pending `sse_request` invoke with 200 + headers. */
  respond: (
    meta?: { status?: number; headers?: Record<string, string> },
    n?: number,
  ) => Promise<void>;
  /** Rejects the next pending `sse_request` invoke. */
  reject: (message: string, n?: number) => Promise<void>;
  /** Pushes an event to whatever listener is subscribed to that request. */
  emit: (requestId: string, payload: SseEventPayload) => void;
  listenerCount: () => number;
  /** Every channel name currently subscribed, in subscription order. */
  channels: () => string[];
  restore: () => void;
}

interface PendingRequest {
  meta: { status: number; headers: Record<string, string> };
  resolve: (meta: { status: number; headers: Record<string, string> }) => void;
  reject: (message: string) => void;
}

const DEFAULT_META = { status: 200, headers: { 'x-probe': 'yes' } };

function installFakeIpc(): FakeIpc {
  const handlers = new Map<string, (event: { payload: SseEventPayload }) => void>();
  const invokeCalls: FakeIpc['invokeCalls'] = [];
  const requests: RecordedRequest[] = [];
  // One entry per in-flight `sse_request`, so two concurrent requests can be
  // answered independently instead of overwriting each other's resolver.
  const pending: PendingRequest[] = [];
  // `sseFetch` awaits `listen` before it calls `invoke`, so a test cannot answer
  // the instant it kicks off a request — the resolver does not exist yet.
  // `awaitPending(n)` blocks until the n-th request has reached `invoke`, which
  // keeps tests from having to sleep and then hope.
  const waiters: Array<() => void> = [];
  function awaitPending(n: number): Promise<void> {
    if (pending.length >= n) return Promise.resolve();
    return new Promise<void>((resolve) => waiters.push(resolve));
  }
  function takePending(n: number): PendingRequest {
    if (pending.length < n) throw new Error(`sse_request #${n} was never invoked`);
    return pending[n - 1] as PendingRequest;
  }

  // Spread the real module rather than replacing it with a literal: this file
  // needs to own `invoke` and `listen`, but other test files in the run import
  // the *other* exports of these same modules, and a literal would strip them
  // for the whole run. See src/test/tauriMocks.ts.
  mock.module('@tauri-apps/api/core', () => ({
    ...realCore,
    invoke: (cmd: string, args: { request?: RecordedRequest }) => {
      invokeCalls.push({ cmd, requestId: args?.request?.requestId });
      if (cmd === 'sse_cancel') return Promise.resolve(false);
      if (args?.request) requests.push(args.request);
      return new Promise((resolve, rejectPromise) => {
        pending.push({ meta: DEFAULT_META, resolve, reject: rejectPromise });
        waiters.splice(0).forEach((resolveWaiter) => resolveWaiter());
      });
    },
  }));

  mock.module('@tauri-apps/api/event', () => ({
    ...realEvent,
    listen: (name: string, handler: (event: { payload: SseEventPayload }) => void) => {
      handlers.set(name, handler);
      return Promise.resolve(() => {
        if (handlers.get(name) === handler) handlers.delete(name);
      });
    },
  }));

  return {
    invokeCalls,
    requests: () => requests,
    respond: async (meta, n = 1) => {
      await awaitPending(n);
      const entry = takePending(n);
      if (meta) entry.meta = { status: meta.status ?? 200, headers: meta.headers ?? {} };
      entry.resolve(entry.meta);
    },
    reject: async (message: string, n = 1) => {
      await awaitPending(n);
      takePending(n).reject(message);
    },
    emit: (requestId, payload) => handlers.get(`sse://${requestId}`)?.({ payload }),
    listenerCount: () => handlers.size,
    channels: () => [...handlers.keys()],
    restore: () => mock.restore(),
  };
}

/** The request id of the n-th `sse_request` the fake IPC was asked to stream for. */
function nthRequestId(ipc: FakeIpc, n: number): string {
  const id = ipc.invokeCalls.filter((c) => c.cmd === 'sse_request')[n - 1]?.requestId;
  if (!id) throw new Error(`sse_request #${n} was never invoked`);
  return id;
}

/** Pulls the request id the fake IPC was asked to stream for. */
function streamedRequestId(ipc: FakeIpc): string {
  const id = ipc.invokeCalls.find((call) => call.cmd === 'sse_request')?.requestId;
  if (!id) throw new Error('sse_request was never invoked');
  return id;
}

async function drain(response: Response): Promise<string> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

describe('sseFetch', () => {
  test('delivers chunks as they arrive and closes on done', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://127.0.0.1/sse');
      await ipc.respond();
      const response = await pending;
      const requestId = streamedRequestId(ipc);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-probe')).toBe('yes');

      ipc.emit(requestId, { kind: 'chunk', data: [104, 105] });
      ipc.emit(requestId, { kind: 'chunk', data: [33] });
      ipc.emit(requestId, { kind: 'done' });

      expect(await drain(response)).toBe('hi!');
      // The listener must be gone once the stream finishes.
      expect(ipc.listenerCount()).toBe(0);
    } finally {
      ipc.restore();
    }
  });

  test('preserves byte boundaries across chunks instead of decoding per event', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://127.0.0.1/sse');
      await ipc.respond();
      const response = await pending;
      const requestId = streamedRequestId(ipc);

      // "你" split mid-character across two chunks — the decoder must stitch it
      // back together, which it only can if bytes are carried, not strings.
      ipc.emit(requestId, { kind: 'chunk', data: [0xe4, 0xbd] });
      ipc.emit(requestId, { kind: 'chunk', data: [0xa0] });
      ipc.emit(requestId, { kind: 'done' });

      expect(await drain(response)).toBe('你');
    } finally {
      ipc.restore();
    }
  });

  test('surfaces a Rust-side stream error as a rejected body', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://127.0.0.1/sse');
      await ipc.respond();
      const response = await pending;

      ipc.emit(streamedRequestId(ipc), { kind: 'error', message: 'connection reset' });

      await expect(drain(response)).rejects.toThrow('connection reset');
      expect(ipc.listenerCount()).toBe(0);
    } finally {
      ipc.restore();
    }
  });

  test('cancels the Rust task when the signal aborts mid-stream', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const controller = new AbortController();
      const pending = sseFetch('http://127.0.0.1/sse', { signal: controller.signal });
      await ipc.respond();
      const response = await pending;

      controller.abort();

      await expect(drain(response)).rejects.toThrow('The operation was aborted.');
      expect(ipc.invokeCalls.some((call) => call.cmd === 'sse_cancel')).toBe(true);
      expect(ipc.listenerCount()).toBe(0);
    } finally {
      ipc.restore();
    }
  });

  test('cancelling the reader also stops the Rust task', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://127.0.0.1/sse');
      await ipc.respond();
      const response = await pending;

      await (response.body as ReadableStream<Uint8Array>).cancel();

      expect(ipc.invokeCalls.some((call) => call.cmd === 'sse_cancel')).toBe(true);
    } finally {
      ipc.restore();
    }
  });

  test('an abort racing a pending header fetch still cancels on the Rust side', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const controller = new AbortController();
      const pending = sseFetch('http://127.0.0.1/sse', { signal: controller.signal });

      // Abort before the invoke resolves: the task only exists on the Rust side
      // once that call returns, so sseFetch has to cancel after the fact.
      controller.abort();
      await ipc.respond();

      await expect(pending).rejects.toThrow('The operation was aborted.');
      expect(ipc.invokeCalls.some((call) => call.cmd === 'sse_cancel')).toBe(true);
    } finally {
      ipc.restore();
    }
  });

  test('rejects an unsupported body rather than posting "[object FormData]"', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const form = new FormData();
      form.append('a', 'b');
      await expect(sseFetch('http://x/sse', { method: 'POST', body: form })).rejects.toThrow(
        /unsupported body type|not supported/,
      );
    } finally {
      ipc.restore();
    }
  });

  test('serialises URLSearchParams and passes strings through', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse', {
        method: 'POST',
        body: new URLSearchParams({ a: 'b' }),
      });
      await ipc.respond();
      await pending;
      expect(ipc.invokeCalls[0]?.cmd).toBe('sse_request');
    } finally {
      ipc.restore();
    }
  });

  test('the host receives the URL, method, headers and body it was asked to send', async () => {
    // The mutation blind spot this closes: the fake used to record only the
    // command name and the request id, so a body serialised into
    // `"[object Object]"` — or a dropped header, or a defaulted method — passed
    // every test in this file. Asserting on what actually crossed the IPC
    // boundary is what makes the serialisation above meaningful.
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://api.example.com/v1/chat?stream=1', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-test', stream: true }),
      });
      await ipc.respond();
      await pending;

      expect(ipc.requests()).toHaveLength(1);
      const sent = ipc.requests()[0] as RecordedRequest;
      expect(sent.url).toBe('http://api.example.com/v1/chat?stream=1');
      expect(sent.method).toBe('POST');
      expect(sent.headers.authorization).toBe('Bearer sk-test');
      expect(sent.headers['content-type']).toBe('application/json');
      expect(sent.body).toBe('{"model":"gpt-test","stream":true}');
      // Header names are lowercased by `Headers`, which is what the host sees.
      expect(Object.keys(sent.headers)).not.toContain('Authorization');
    } finally {
      ipc.restore();
    }
  });

  test('a URLSearchParams body survives as a query string, not "[object URLSearchParams]"', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse', {
        method: 'POST',
        body: new URLSearchParams({ model: 'gpt-test', q: '中文' }),
      });
      await ipc.respond();
      await pending;

      const sent = ipc.requests()[0] as RecordedRequest;
      expect(sent.body).toBe('model=gpt-test&q=%E4%B8%AD%E6%96%87');
      expect(sent.body).not.toContain('[object');
      // And it round-trips to the same parameters on the other side.
      expect(new URLSearchParams(sent.body ?? '').get('q')).toBe('中文');
    } finally {
      ipc.restore();
    }
  });

  test('a GET with no body sends null rather than "undefined" or an empty string', async () => {
    // The AI daily-report path. Rust would forward the literal string to
    // reqwest, so `"undefined"` here becomes a body the provider rejects.
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse');
      await ipc.respond();
      await pending;

      const sent = ipc.requests()[0] as RecordedRequest;
      expect(sent.method).toBe('GET');
      expect(sent.body).toBeNull();
    } finally {
      ipc.restore();
    }
  });

  test('propagates a failed invoke and leaves no listener behind', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse');
      await ipc.reject('connection refused');
      await expect(pending).rejects.toThrow('connection refused');
      expect(ipc.listenerCount()).toBe(0);
    } finally {
      ipc.restore();
    }
  });

  test('throws AbortError without touching Rust when already aborted', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const controller = new AbortController();
      controller.abort();
      await expect(sseFetch('http://x/sse', { signal: controller.signal })).rejects.toThrow(
        'The operation was aborted.',
      );
      expect(ipc.invokeCalls).toHaveLength(0);
    } finally {
      ipc.restore();
    }
  });
});

describe('sseFetch error taxonomy', () => {
  test('classifies a failed header fetch as a transport error carrying the request id', async () => {
    const ipc = installFakeIpc();
    try {
      const { SseFetchError, sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse');
      await ipc.reject('dns error: no route to host');

      const err = await pending.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SseFetchError);
      expect((err as InstanceType<typeof SseFetchError>).kind).toBe('transport');
      expect((err as InstanceType<typeof SseFetchError>).requestId).toBe(streamedRequestId(ipc));
      expect((err as Error).message).toContain('no route to host');
    } finally {
      ipc.restore();
    }
  });

  test('classifies a mid-body error as a stream error, distinct from transport', async () => {
    const ipc = installFakeIpc();
    try {
      const { SseFetchError, sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse');
      await ipc.respond();
      const response = await pending;

      ipc.emit(streamedRequestId(ipc), { kind: 'error', message: 'stream reset' });

      const err = await response.text().catch((e: unknown) => e);
      expect((err as InstanceType<typeof SseFetchError>).kind).toBe('stream');
    } finally {
      ipc.restore();
    }
  });

  test('a Rust panic is called out as such rather than blamed on the network', async () => {
    const ipc = installFakeIpc();
    try {
      const { SseFetchError, sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse');
      await ipc.reject(
        "called `Result::unwrap()` on an `Err` value: poisoned\nthread 'main' panicked at src/sse.rs:99",
      );

      const err = (await pending.catch((e: unknown) => e)) as InstanceType<typeof SseFetchError>;
      expect(err.kind).toBe('panic');
      // A panic is not retryable by retrying the same request id, so the id is
      // still attached for log correlation but the kind must not read as a
      // transient network problem.
      expect(err.kind).not.toBe('transport');
    } finally {
      ipc.restore();
    }
  });

  test('an HTTP error status resolves rather than rejecting, like fetch does', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse', { headers: { authorization: 'Bearer sk-fake' } });
      await ipc.respond({ status: 401, headers: { 'content-type': 'application/json' } });
      const response = await pending;

      // The caller — not the bridge — decides what a 401 means (client.ts turns
      // it into AI_HTTP_401). Throwing here would break that contract.
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toBe('application/json');
      ipc.emit(streamedRequestId(ipc), {
        kind: 'chunk',
        data: [...new TextEncoder().encode('{"error":"bad key"}')],
      });
      ipc.emit(streamedRequestId(ipc), { kind: 'done' });
      expect(await response.text()).toBe('{"error":"bad key"}');
      expect(ipc.listenerCount()).toBe(0);
    } finally {
      ipc.restore();
    }
  });

  test('a 204 gets no body stream rather than one that can never produce data', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse');
      await ipc.respond({ status: 204, headers: {} });
      const response = await pending;

      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
      ipc.emit(streamedRequestId(ipc), { kind: 'done' });
    } finally {
      ipc.restore();
    }
  });
});

describe('sseFetch concurrency isolation', () => {
  test('two concurrent streams get distinct channels and never see each other’s chunks', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const first = sseFetch('http://x/first');
      const second = sseFetch('http://x/second');
      await ipc.respond(undefined, 1);
      await ipc.respond(undefined, 2);
      const [a, b] = await Promise.all([first, second]);

      const idA = streamedRequestId(ipc);
      const idB = nthRequestId(ipc, 2);
      expect(idA).not.toBe(idB);
      expect(new Set(ipc.channels()).size).toBe(2);

      ipc.emit(idA, { kind: 'chunk', data: [65] });
      ipc.emit(idB, { kind: 'chunk', data: [66] });
      ipc.emit(idB, { kind: 'chunk', data: [66] });
      ipc.emit(idA, { kind: 'done' });

      // A is closed while B is still streaming: A must see only its own byte.
      expect(await a.text()).toBe('A');
      ipc.emit(idB, { kind: 'done' });
      expect(await b.text()).toBe('BB');
    } finally {
      ipc.restore();
    }
  });

  test('finishing one stream does not tear down the other’s listener', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const first = sseFetch('http://x/first');
      const second = sseFetch('http://x/second');
      await ipc.respond(undefined, 1);
      await ipc.respond(undefined, 2);
      const [a, b] = await Promise.all([first, second]);
      const idA = nthRequestId(ipc, 1);
      const idB = nthRequestId(ipc, 2);

      ipc.emit(idA, { kind: 'done' });
      await a.text();

      expect(ipc.listenerCount()).toBe(1);
      expect(ipc.channels()).toEqual([`sse://${idB}`]);

      ipc.emit(idB, { kind: 'chunk', data: [90] });
      ipc.emit(idB, { kind: 'done' });
      expect(await b.text()).toBe('Z');
      expect(ipc.listenerCount()).toBe(0);
    } finally {
      ipc.restore();
    }
  });

  test('a stream error on one request leaves the other request untouched', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const first = sseFetch('http://x/first');
      const second = sseFetch('http://x/second');
      await ipc.respond(undefined, 1);
      await ipc.respond(undefined, 2);
      const [a, b] = await Promise.all([first, second]);
      const idA = nthRequestId(ipc, 1);
      const idB = nthRequestId(ipc, 2);

      ipc.emit(idA, { kind: 'error', message: 'only A failed' });
      await expect(a.text()).rejects.toThrow('only A failed');

      expect(ipc.listenerCount()).toBe(1);
      ipc.emit(idB, { kind: 'chunk', data: [79] });
      ipc.emit(idB, { kind: 'done' });
      expect(await b.text()).toBe('O');
    } finally {
      ipc.restore();
    }
  });
});

describe('sseFetch listener hygiene', () => {
  test('cancelling the reader detaches the listener, not just the Rust task', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse');
      await ipc.respond();
      const response = await pending;
      expect(ipc.listenerCount()).toBe(1);

      await (response.body as ReadableStream<Uint8Array>).cancel();

      expect(ipc.invokeCalls.some((c) => c.cmd === 'sse_cancel')).toBe(true);
      // The Rust task is aborted, so it will never emit `done` — without an
      // explicit detach this listener would stay registered forever.
      expect(ipc.listenerCount()).toBe(0);
    } finally {
      ipc.restore();
    }
  });

  test('an abort after done is a no-op — no cancel is sent for a finished stream', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const controller = new AbortController();
      const pending = sseFetch('http://x/sse', { signal: controller.signal });
      await ipc.respond();
      const response = await pending;

      ipc.emit(streamedRequestId(ipc), { kind: 'done' });
      await response.text();
      controller.abort();

      expect(ipc.listenerCount()).toBe(0);
    } finally {
      ipc.restore();
    }
  });

  test('chunks arriving after a terminal event are dropped, not enqueued on a closed stream', async () => {
    const ipc = installFakeIpc();
    try {
      const { sseFetch } = await import('./sseFetch');
      const pending = sseFetch('http://x/sse');
      await ipc.respond();
      const response = await pending;
      const requestId = streamedRequestId(ipc);

      ipc.emit(requestId, { kind: 'chunk', data: [111] });
      ipc.emit(requestId, { kind: 'done' });
      // Late traffic from an already-finished stream must not throw inside the
      // listener, which would surface as an unhandled rejection.
      ipc.emit(requestId, { kind: 'chunk', data: [107] });
      ipc.emit(requestId, { kind: 'error', message: 'too late' });

      expect(await drain(response)).toBe('o');
      expect(ipc.listenerCount()).toBe(0);
    } finally {
      ipc.restore();
    }
  });
});
