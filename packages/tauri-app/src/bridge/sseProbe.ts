/**
 * Dev-only harness for the SSE bridge, served at /sse-probe.html by the vite
 * dev server. Not part of the production build (vite only bundles index.html).
 *
 * It proves the thing that actually matters: chunks arrive one at a time over
 * time, not buffered and delivered in one burst. Each read prints the elapsed
 * milliseconds since the response resolved, so a bridge that lost streaming
 * would show ~0ms for every chunk.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { sseFetch } from './sseFetch';

const out = document.getElementById('out') as HTMLPreElement;
const started = Date.now();
const lines: string[] = [];

function log(message: string) {
  const line = `[${String(Date.now() - started).padStart(5)}ms] ${message}`;
  lines.push(line);
  out.textContent = lines.join('\n');
  console.log(line);
  // The webview console is invisible from the terminal, so mirror the log to
  // the mock server; tauri-plugin-http sidesteps CORS for this report call.
  const report = `${String(new URLSearchParams(location.search).get('port') ?? '8788')}`;
  void tauriFetch(`http://127.0.0.1:${report}/report`, {
    method: 'POST',
    body: line,
  }).catch(() => undefined);
}

const params = new URLSearchParams(location.search);
const target = params.get('url') ?? 'http://127.0.0.1:8788/sse';
// `?abortAfter=2` cancels mid-stream, which must tear down the Rust task too —
// not just stop reading on this side.
const abortAfter = Number(params.get('abortAfter') ?? '0');

log(`probing ${target}${abortAfter ? ` (abort after ${abortAfter} chunks)` : ''}`);

const controller = new AbortController();
let chunkCount = 0;

try {
  const response = await sseFetch(target, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  log(`response ${response.status} ${response.headers.get('content-type')}`);

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunkCount += 1;
    const text = decoder.decode(value, { stream: true });
    log(`chunk #${chunkCount} (${value.length}B): ${JSON.stringify(text)}`);
    if (abortAfter && chunkCount >= abortAfter) {
      log('calling abort()');
      controller.abort();
    }
  }

  log(`stream closed after ${chunkCount} chunks`);
} catch (error) {
  if (abortAfter) {
    log(`aborted after ${chunkCount} chunks: ${error instanceof Error ? error.name : error}`);
  } else {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
