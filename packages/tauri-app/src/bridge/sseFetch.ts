import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * `fetch`-compatible wrapper around the Rust SSE bridge (see src-tauri/src/sse.rs).
 *
 * The webview cannot stream from an OpenAI-compatible API itself — those
 * endpoints send no CORS headers — so the body is relayed by the Rust host as
 * `sse://{request_id}` events. Everything else here is shaped to be a drop-in
 * for `fetch`: it returns a real `Response` whose `body` is a
 * `ReadableStream`, and it honours `AbortSignal` on both ends.
 */

interface SseRequestInit extends RequestInit {
  signal?: AbortSignal;
}

interface SseResponseMeta {
  status: number;
  headers: Record<string, string>;
}

type SseEvent =
  // `dataBase64` is what the current shell emits; `data` is the byte-array form
  // an older shell sends. Both are accepted so a `bun run dev` reload where one
  // side rebuilt and the other did not degrades to the slower path instead of
  // producing garbage.
  | { kind: 'chunk'; dataBase64: string; data?: undefined }
  | { kind: 'chunk'; data: number[]; dataBase64?: undefined }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/**
 * Why an {@link SseFetchError} happened.
 *
 * The three cases need different reactions from the caller, and collapsing
 * them into one message is what makes a bridge failure hard to debug:
 *
 *   - `transport` — the Rust side could not get response *headers* at all:
 *     DNS failure, connection refused, TLS error, an invalid method. The
 *     provider was never reached. Retrying later may work.
 *   - `stream` — headers arrived (so the provider *was* reached and answered)
 *     but the body died mid-flight: the connection dropped, the provider
 *     reset it, an idle gateway timed it out. Partial text already delivered
 *     is still valid, so the caller usually keeps what it got.
 *   - `panic` — a Rust command panicked. The request id may have no entry in
 *     the abort registry, so a later cancel for it is a no-op rather than an
 *     error; nothing on the webview side can recover it.
 *
 * `requestId` is attached whenever one was allocated, so a failure can be
 * correlated with a bridge-side log line. It is deliberately absent on a
 * network-level abort, where no Rust task was ever created.
 */
export type SseErrorKind = 'transport' | 'stream' | 'panic';

/**
 * An error raised by the SSE bridge, as opposed to an HTTP error status.
 *
 * A non-2xx response is *not* an error here — like `fetch`, it resolves with
 * the status and body intact, and the AI client turns it into
 * `AI_HTTP_<status>` itself. Only the paths that have no HTTP response at all
 * surface as a rejection.
 */
export class SseFetchError extends Error {
  readonly kind: SseErrorKind;
  readonly requestId?: string;

  constructor(kind: SseErrorKind, message: string, requestId?: string) {
    super(message);
    this.name = 'SseFetchError';
    this.kind = kind;
    this.requestId = requestId;
  }
}

/**
 * Statuses whose responses carry no body per the fetch spec. The `Response`
 * constructor does not enforce this — it happily accepts a body for 204 — but
 * handing back a stream that can never produce anything is worse than handing
 * back `null`, and a 204 from a streaming endpoint means "nothing to stream".
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * A Tauri command that panics rejects the `invoke` promise with the panic
 * message rather than a structured error, and the panic text has a
 * recognisable shape. Matching it is what separates "the bridge broke" from
 * "the network is down" in the log.
 */
function looksLikeRustPanic(message: string): boolean {
  return /panicked at|thread '[^']*' panicked|RUST_BACKTRACE/i.test(message);
}

/**
 * Request ids must be unique for the whole session, not just per call: the id
 * is the event-channel name on the Rust side, so a collision would let two
 * concurrent streams deliver into each other's listeners. A random suffix
 * makes that collision-free across two live module instances too, which the
 * `Date.now() + counter` scheme was not.
 */
function nextRequestId(): string {
  const random = crypto.randomUUID().slice(0, 8);
  return `sse-${Date.now().toString(36)}-${random}`;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Decodes one chunk payload to bytes.
 *
 * The shell sends base64 (`dataBase64`) because a JSON byte array inflates the
 * chunk by ~3.6x — one decimal number per byte — and every byte of that
 * crosses the IPC boundary on every chunk. `atob` yields a binary string, so
 * each code unit is exactly one byte; no re-encoding happens, which is what
 * keeps a chunk that splits a multi-byte UTF-8 character intact.
 */
function chunkBytes(payload: Extract<SseEvent, { kind: 'chunk' }>): Uint8Array {
  if (payload.dataBase64 !== undefined) {
    const binary = atob(payload.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(payload.data ?? []);
}

/**
 * The Rust side takes a plain string body. Only the body types that survive
 * that round-trip losslessly are accepted: `String(formData)` and
 * `String(blob)` both yield "[object FormData]" / "[object Blob]", which would
 * silently POST garbage instead of failing, so those are rejected outright.
 */
function serializeBody(body: BodyInit | null | undefined): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) {
    throw new TypeError('sseFetch: Blob bodies are not supported yet; pass a string');
  }
  throw new TypeError(`sseFetch: unsupported body type ${body.constructor?.name ?? typeof body}`);
}

export async function sseFetch(input: string | URL, init: SseRequestInit = {}): Promise<Response> {
  const { signal, headers: initHeaders, body: initBody, ...rest } = init;

  if (signal?.aborted) throw abortError();

  const requestId = nextRequestId();
  const channel = `sse://${requestId}`;

  const requestHeaders: Record<string, string> = {};
  new Headers(initHeaders).forEach((value, key) => {
    requestHeaders[key] = value;
  });

  let unlisten: (() => void) | undefined;
  /**
   * Drops the event listener and the abort hook. Idempotent, and safe to call
   * from several places at once: the reference is cleared *before* awaiting,
   * so overlapping calls cannot both run the same unlisten. Every terminal
   * path — done, stream error, abort, cancel, invoke failure — goes through
   * here, which is what keeps a long session from accumulating one stale
   * listener per finished request.
   */
  const detach = async (): Promise<void> => {
    const stop = unlisten;
    unlisten = undefined;
    await stop?.();
    signal?.removeEventListener('abort', onAbort);
  };

  // Cancelling twice is harmless: the Rust side reports whether it actually
  // aborted anything, and a repeat call simply finds no task.
  const cancelRemote = () => invoke('sse_cancel', { requestId }).catch(() => undefined);

  // `start` runs synchronously, so both `controller` and `settle` are wired up
  // before any listener can fire — no window where an early chunk would hit an
  // undefined controller.
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let settle: (result: { ok: true } | { ok: false; error: Error }) => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      settle = (result) => {
        // Chunks can still be in flight after done/error/abort; dropping them
        // instead of enqueueing on a closed controller keeps it from throwing.
        if (closed) return;
        closed = true;
        if (result.ok) c.close();
        else c.error(result.error);
      };
    },
    cancel() {
      // Consumer walked away (e.g. `reader.cancel()`); stop the Rust task too.
      // The detach matters as much as the cancel: aborting the task means the
      // Rust side never reaches its `Done` emit, so without this the listener
      // for this request would stay registered for the rest of the session.
      closed = true;
      void cancelRemote();
      void detach();
    },
  });

  function onAbort() {
    void cancelRemote();
    void detach();
    settle({ ok: false, error: abortError() });
  }

  unlisten = await listen<SseEvent>(channel, (event) => {
    const payload = event.payload;
    if (payload.kind === 'chunk') {
      if (closed) return;
      // Enqueue through the stream's own queue so backpressure is honoured
      // instead of buffering the whole SSE body in memory.
      try {
        controller?.enqueue(chunkBytes(payload));
      } catch {
        // Consumer cancelled mid-flight; the Rust task is already being aborted.
      }
      return;
    }
    void detach();
    if (payload.kind === 'error') {
      settle({ ok: false, error: new SseFetchError('stream', payload.message, requestId) });
      return;
    }
    settle({ ok: true });
  });

  signal?.addEventListener('abort', onAbort, { once: true });

  let meta: SseResponseMeta;
  try {
    meta = await invoke<SseResponseMeta>('sse_request', {
      request: {
        url: String(input),
        method: rest.method ?? 'GET',
        headers: requestHeaders,
        body: serializeBody(initBody),
        requestId,
      },
    });
  } catch (error) {
    await detach();
    const message = error instanceof Error ? error.message : String(error);
    settle({
      ok: false,
      error: new SseFetchError(
        looksLikeRustPanic(message) ? 'panic' : 'transport',
        message,
        requestId,
      ),
    });
    throw new SseFetchError(
      looksLikeRustPanic(message) ? 'panic' : 'transport',
      message,
      requestId,
    );
  }

  // An abort that landed while the headers were still in flight still has to
  // reach the Rust task, which only registers once `sse_request` returns.
  if (signal?.aborted) {
    await cancelRemote();
    await detach();
    throw abortError();
  }

  return new Response(NULL_BODY_STATUSES.has(meta.status) ? null : stream, {
    status: meta.status,
    headers: meta.headers,
  });
}
