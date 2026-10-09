import { sseFetch } from '@/bridge/sseFetch';

/**
 * Port of packages/app/src/main/ai/client.ts.
 *
 * The only behavioural change is the default transport: `fetchImpl` used to
 * default to node's global `fetch`, which cannot reach an OpenAI-compatible
 * endpoint from a WKWebView (no CORS headers), so it now defaults to
 * {@link sseFetch}, the Rust SSE bridge. Callers can still pass their own
 * implementation, which is what the tests do.
 *
 * `AbortSignal.timeout` is replaced with an explicit controller + timer: the
 * webview build targets Safari 15 (vite `build.target`), and that API only
 * landed in Safari 16.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  fetchImpl?: typeof fetch;
  firstTokenTimeoutMs?: number; // default 30_000
  idleTimeoutMs?: number; // default 60_000
}

const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<string> {
  const doFetch = opts.fetchImpl ?? (sseFetch as unknown as typeof fetch);
  const firstTokenMs = opts.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let receivedFirst = false;
  let abortError: Error | undefined;
  const controller = new AbortController();

  const schedule = (ms: number, kind: 'FIRST_TOKEN_TIMEOUT' | 'IDLE_TIMEOUT') => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      abortError = new Error(kind);
      controller.abort();
    }, ms);
  };

  schedule(firstTokenMs, 'FIRST_TOKEN_TIMEOUT');

  const res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true }),
    signal: controller.signal,
  }).catch((err: unknown) => {
    if (timeout) clearTimeout(timeout);
    // A timeout aborts via the same signal a caller-supplied cancellation
    // would, so `abortError` — not the DOMException — is the truthful report.
    if (abortError) throw abortError;
    throw err instanceof Error ? err : new Error(String(err));
  });

  if (!res.ok || !res.body) {
    if (timeout) clearTimeout(timeout);
    throw new Error(`AI_HTTP_${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read().catch((err: unknown) => {
        if (abortError) throw abortError;
        throw err;
      });
      if (done) break;
      schedule(idleMs, 'IDLE_TIMEOUT');
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            if (!receivedFirst) {
              receivedFirst = true;
              schedule(idleMs, 'IDLE_TIMEOUT');
            }
            yield delta;
          }
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
}

const TEST_TIMEOUT_MS = 10_000;

/** Lightweight connectivity check used by “连接测试”. */
export async function testConnection(
  baseUrl: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; error?: string }> {
  const doFetch = fetchImpl ?? (sseFetch as unknown as typeof fetch);
  // Safari 15 has no `AbortSignal.timeout`, so the deadline is a plain timer.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, error: 'TIMEOUT' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(deadline);
  }
}
