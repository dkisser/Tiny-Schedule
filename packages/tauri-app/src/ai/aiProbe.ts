import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { AiStreamEvent, ChatEvent } from '@tiny-schedule/shared';
import { createAiApi } from '@/api/ai';
import { dataDir } from '@/bridge/bootstrap';
import { DataStore } from '@/bridge/dataStore';
import { initKeyStore } from '@/bridge/keys';
import { TauriFs } from '@/bridge/tauriFs';

/**
 * Dev-only harness for the AI chain, served at /ai-probe.html by the vite dev
 * server. Not part of the production build (vite only bundles index.html).
 *
 * It exists so the real path can be exercised on a machine that has a key,
 * without waiting for the app UI. Everything goes through production code —
 * `createAiApi`, `sseFetch`, the real `DataStore` on the real data dir — so a
 * pass here is a pass for the app. It deliberately does *not* wire itself into
 * `bootstrap()`: the probe opens its own store handle, which means running it
 * never changes what the running app is using.
 *
 * Query parameters:
 *   ?scope=today|week   analyze scope for the aiAnalyze leg (default today)
 *   ?prompt=…           chat prompt (default "列出今天的任务")
 *   ?port=8788          mock-server port to mirror the log to, like sseProbe
 *
 * The API key comes from the encrypted store; it is never accepted as a
 * parameter and never printed. The summary at the end greps every event payload
 * for a key-shaped string, which is the one assertion worth automating here.
 */
const out = document.getElementById('out') as HTMLPreElement;
const started = Date.now();
const lines: string[] = [];
const reportPort = new URLSearchParams(location.search).get('port') ?? '8788';

function log(message: string) {
  const line = `[${String(Date.now() - started).padStart(6)}ms] ${message}`;
  lines.push(line);
  out.textContent = lines.join('\n');
  console.log(line);
  // The webview console is invisible from the terminal, so mirror the log to
  // the mock server; tauri-plugin-http sidesteps CORS for this report call.
  void tauriFetch(`http://127.0.0.1:${reportPort}/report`, {
    method: 'POST',
    body: line,
  }).catch(() => undefined);
}

/** Any key-shaped substring in an event payload would be a leak. */
const KEY_SHAPED = /sk-[A-Za-z0-9_-]{10,}/;

const params = new URLSearchParams(location.search);

try {
  const fs = new TauriFs();
  // bootstrap() must have run for dataDir() to resolve; it is what initializes
  // the key store, which the slice needs to decrypt anything.
  await initKeyStore(dataDir(), fs);
  const store = await DataStore.open(dataDir(), fs);
  const api = createAiApi({ store });

  const data = await store.get();
  const provider =
    data.settings.aiProviders.find((p) => p.isDefault) ?? data.settings.aiProviders[0];
  if (!provider) throw new Error('no AI provider configured — add one in 设置 first');

  log(`provider ${provider.id} (${provider.registryId}) model=${provider.model}`);
  log(`baseUrl ${provider.baseUrl ?? '<registry default>'}`);
  log('key loaded from the encrypted store; it is never printed');

  // ---- leg 1: onAiEvent / aiAnalyze over the SSE bridge -------------------
  const aiEvents: AiStreamEvent[] = [];
  api.onAiEvent((ev) => {
    aiEvents.push(ev);
    if (ev.delta !== undefined) log(`ai chunk: ${JSON.stringify(ev.delta)}`);
    if (ev.full !== undefined) log(`ai done: ${ev.full.length} chars\n${ev.full}`);
    if (ev.error !== undefined) log(`ai error: ${ev.error}`);
  });

  // ---- leg 2: onChatEvent / chatSend through pi-agent-core ----------------
  const chatEvents: ChatEvent[] = [];
  api.onChatEvent((ev) => {
    chatEvents.push(ev);
    log(`chat ${ev.channel}: ${JSON.stringify(ev.payload).slice(0, 200)}`);
  });

  const scope = params.get('scope') === 'week' ? 'week' : 'today';
  log(`--- aiAnalyze (scope=${scope}) ---`);
  const { requestId } = await api.aiAnalyze({ scope });
  log(`aiAnalyze requestId=${requestId}`);

  log('--- chatSend ---');
  const session = await api.chatSessionCreate({});
  const chatResult = await api.chatSend({
    sessionId: session.id,
    text: params.get('prompt') ?? '列出今天的任务',
  });
  if ('error' in chatResult) log(`chatSend refused: ${chatResult.error}`);

  const deadline = Date.now() + 180_000;
  const aiSettled = () => aiEvents.some((e) => e.full !== undefined || e.error !== undefined);
  const chatSettled = () =>
    chatEvents.some((e) => e.channel === 'chat:done' || e.channel === 'chat:error');
  while ((!aiSettled() || !chatSettled()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!aiSettled()) log('aiAnalyze did not settle within 180s');
  if (!chatSettled()) log('chatSend did not settle within 180s');

  log('=== summary ===');
  const allEvents = JSON.stringify([...aiEvents, ...chatEvents]);
  log(
    `ai events:   ${aiEvents.map((e) => (e.delta ? 'chunk' : e.full !== undefined ? 'done' : 'error')).join(', ')}`,
  );
  log(`chat events: ${chatEvents.map((e) => e.channel).join(', ')}`);
  log(`ai payload fields:   ${[...new Set(aiEvents.flatMap((e) => Object.keys(e)))].join(', ')}`);
  log(`chat channels seen:  ${[...new Set(chatEvents.map((e) => e.channel))].join(', ')}`);
  log(
    KEY_SHAPED.test(allEvents)
      ? 'FAIL: a key-shaped string appeared in an event payload'
      : 'OK: no key in any event payload',
  );
} catch (error) {
  log(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
}
