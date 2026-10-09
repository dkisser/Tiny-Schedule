import {
  type AiStreamEvent,
  type ChatEvent,
  type ChatSession,
  Ipc,
  IpcInvokeContract,
  type IpcInvokeFn,
  type IpcInvokeKey,
  localDate,
  type ProviderInfo,
} from '@tiny-schedule/shared';
import { ChatAgentManager } from '@/ai/chatAgent';
import { streamChat, testConnection } from '@/ai/client';
import { type AiLogger, consoleLogger } from '@/ai/logger';
import { buildAnalysisData, renderPrompt } from '@/ai/prompts';
import { getProviderDef, PROVIDER_REGISTRY, toProviderInfo } from '@/ai/providers';
import type { DataStore } from '@/bridge/dataStore';
import { decryptKey } from '@/bridge/keys';

/**
 * The AI slice of the renderer API: the 10 AI/chat invokes plus the two event
 * push channels.
 *
 * Ported from packages/app/src/main/ipcHandlers.ts (ai* and chat* handlers)
 * and the AI modules it leaned on. Three things are structurally different
 * from the Electron original, all consequences of the data living in this same
 * process now:
 *
 *  1. **No IPC.** `sendSafe(win, Ipc.aiChunk, payload)` became
 *     {@link AiEventBus.emit}. The payload shape is unchanged — it is still
 *     validated against the shared schemas on the way in and is byte-identical
 *     to what the preload used to hand the renderer.
 *  2. **Keys.** The renderer used to receive only `hasApiKey` and had to ask
 *     the main process to decrypt on demand. Here the ciphertext is in the
 *     same heap as the caller, but the plaintext is still produced only inside
 *     this module ({@link resolveApiKey}) — nothing below ever receives it.
 *  3. **Async persistence.** `store.update` here goes through the filesystem,
 *     so every handler that used to be synchronous awaits it.
 */

/** Contract keys this slice owns. */
export type AiInvokeKey = Extract<
  IpcInvokeKey,
  | 'aiRegistry'
  | 'aiTestProvider'
  | 'aiProviderKeyReveal'
  | 'aiAnalyze'
  | 'chatSessionsList'
  | 'chatSessionCreate'
  | 'chatSessionDelete'
  | 'chatSend'
  | 'chatContinue'
  | 'chatStop'
>;

export type AiApi = {
  [K in AiInvokeKey]: IpcInvokeFn<K>;
} & Pick<RendererEventApi, 'onAiEvent' | 'onChatEvent'>;

type RendererEventApi = {
  onAiEvent: (cb: (ev: AiStreamEvent) => void) => () => void;
  onChatEvent: (cb: (ev: ChatEvent) => void) => () => void;
};

/** How many ai:analyze reports are kept, matching the original's cap. */
const AI_HISTORY_LIMIT = 50;

/**
 * Local push channel, standing in for `webContents.send`.
 *
 * A plain listener set rather than a Tauri `emit`: the producer and the
 * consumer are the same webview, so round-tripping through the Rust event bus
 * would add a serialise/deserialise hop for nothing. Listener errors are
 * contained per-callback so one bad subscriber cannot stop the rest from being
 * notified — the Rust side had the same property, because an emit to a
 * destroyed window was a no-op rather than a throw.
 */
export class AiEventBus {
  private readonly listeners = new Set<(payload: unknown) => void>();

  subscribe(cb: (payload: unknown) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  get size(): number {
    return this.listeners.size;
  }

  emit(payload: unknown): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(payload);
      } catch (error) {
        // A throwing subscriber is a renderer bug; it must not abort the stream
        // that is delivering the remaining events.
        consoleLogger.error({ action: 'ai:listener', error: String(error) }, 'AI listener threw');
      }
    }
  }
}

export interface CreateAiApiOptions {
  store: DataStore;
  logger?: AiLogger;
  /** Test seam: replaces the SSE bridge so a slice test needs no Tauri host. */
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the chat agent's provider connection. */
  chatDeps?: Partial<ChatAgentDeps>;
}

type ChatAgentDeps = ConstructorParameters<typeof ChatAgentManager>[0];

/** Applies the contract's zod schema, exactly as the ipcMain loop did. */
function parse<K extends AiInvokeKey>(key: K, raw: unknown): unknown {
  const entry = IpcInvokeContract[key] as { req?: { parse(value: unknown): unknown } };
  return entry.req ? entry.req.parse(raw) : raw;
}

export function createAiApi(options: CreateAiApiOptions): AiApi {
  const { store } = options;
  const logger = options.logger ?? consoleLogger;
  const fetchImpl = options.fetchImpl;
  const bus = new AiEventBus();

  const settings = async () => (await store.get()).settings;
  const readSessions = async (): Promise<ChatSession[]> =>
    ((await store.get()).misc.chatSessions ?? []) as ChatSession[];

  /**
   * The one place a plaintext API key is ever materialised.
   *
   * Returns it to the caller only for the two uses that genuinely need one —
   * the outgoing Authorization header and the explicit user-initiated reveal —
   * and never logs it, never puts it in an event payload, and never returns it
   * alongside the provider list. Everything else in the slice sees
   * `apiKeyEncrypted` or `hasApiKey`.
   */
  async function resolveApiKey(encrypted: string): Promise<string> {
    if (encrypted === '') return '';
    return decryptKey(encrypted);
  }

  const chatManager = new ChatAgentManager({
    getSessions: readSessions,
    saveSession: async (s) => {
      await store.update((d) => {
        const list = ((d.misc.chatSessions ?? []) as ChatSession[]).filter((x) => x.id !== s.id);
        return { ...d, misc: { ...d.misc, chatSessions: [s, ...list] } };
      });
    },
    deleteStoredSession: async (id) => {
      let next: ChatSession[] = [];
      await store.update((d) => {
        next = ((d.misc.chatSessions ?? []) as ChatSession[]).filter((x) => x.id !== id);
        return { ...d, misc: { ...d.misc, chatSessions: next } };
      });
      return next;
    },
    getProviders: async () => (await store.get()).settings.aiProviders,
    decryptKey: resolveApiKey,
    getData: () => store.get(),
    today: () => localDate(Date.now()),
    sink: {
      chunk: (sessionId, requestId, delta) =>
        bus.emit({ channel: Ipc.chatChunk, payload: { sessionId, requestId, delta } }),
      tool: (payload) => bus.emit({ channel: Ipc.chatToolEvent, payload }),
      status: (payload) => bus.emit({ channel: Ipc.chatStatus, payload }),
      done: (sessionId, requestId) =>
        bus.emit({ channel: Ipc.chatDone, payload: { sessionId, requestId } }),
      error: (payload) => bus.emit({ channel: Ipc.chatError, payload }),
    },
    logger,
    ...options.chatDeps,
  });

  const handlers: Record<AiInvokeKey, (raw: unknown) => Promise<unknown>> = {
    aiRegistry: async () => PROVIDER_REGISTRY.map(toProviderInfo) satisfies ProviderInfo[],

    aiTestProvider: async (raw) => {
      const { providerId } = parse('aiTestProvider', raw) as { providerId: string };
      const cfg = (await settings()).aiProviders.find((p) => p.id === providerId);
      if (!cfg) return { ok: false, error: 'PROVIDER_NOT_CONFIGURED' };
      const def = getProviderDef(cfg.registryId);
      const baseUrl = cfg.baseUrl ?? def?.baseUrl ?? '';
      if (!baseUrl) return { ok: false, error: 'MISSING_BASE_URL' };
      const result = await testConnection(
        baseUrl,
        await resolveApiKey(cfg.apiKeyEncrypted),
        fetchImpl,
      );
      // The key is deliberately absent from this log line and from the result:
      // `ok`/`error` is all the UI needs.
      logger.info({ action: 'ai:testProvider', providerId, ok: result.ok });
      return result;
    },

    /**
     * Reveal semantics, and how they differ from the Electron original.
     *
     * Original (main process, renderer asked over IPC): `store.get()` →
     * find provider → `decryptKey` → `{ apiKey }`. Same lookup, same
     * `'PROVIDER_NOT_FOUND' → { apiKey: '' }` fallback shape.
     *
     * What changed is the *boundary*, not the behaviour. Electron kept the key
     * out of the renderer heap and revealed it on a narrow, auditable IPC call;
     * here the ciphertext the key was derived from already sits in this
     * process, so the reveal is a plain function call that any code in the
     * webview could equally perform by calling `decryptKey` directly. The
     * contract still requires this method, so the UI keeps working and the
     * payload is still exactly `{ apiKey: string }` — but it should be read as
     * a UI convenience, not as a privilege gate. The real protection against a
     * key leaking to disk or to a log is unchanged: nothing else in the app
     * ever holds the plaintext, and it is never part of an event payload.
     *
     * One behavioural tightening relative to the original: a configured
     * provider with an empty key returns `{ apiKey: '' }` rather than
     * attempting a decrypt of an empty string, which on the legacy base64
     * format would have thrown `malformed encrypted key`.
     */
    aiProviderKeyReveal: async (raw) => {
      const { providerId } = parse('aiProviderKeyReveal', raw) as { providerId: string };
      const cfg = (await settings()).aiProviders.find((p) => p.id === providerId);
      if (!cfg || cfg.apiKeyEncrypted === '') return { apiKey: '' };
      return { apiKey: await resolveApiKey(cfg.apiKeyEncrypted) };
    },

    aiAnalyze: async (raw) => {
      const req = parse('aiAnalyze', raw) as {
        scope: 'today' | 'week' | 'project';
        projectId?: string;
        providerId?: string;
      };
      const requestId = crypto.randomUUID();
      const data = await store.get();
      const providers = data.settings.aiProviders;
      const cfg = req.providerId
        ? providers.find((p) => p.id === req.providerId)
        : (providers.find((p) => p.isDefault) ?? providers[0]);
      if (!cfg) {
        bus.emit({ channel: Ipc.aiError, payload: { requestId, error: 'NO_PROVIDER_CONFIGURED' } });
        return { requestId };
      }
      const def = getProviderDef(cfg.registryId);
      const baseUrl = cfg.baseUrl ?? def?.baseUrl ?? '';
      const today = localDate(Date.now());
      const prompt = renderPrompt(data.settings.aiPrompt, {
        date: today,
        data: buildAnalysisData(data, { scope: req.scope, date: today, projectId: req.projectId }),
      });
      logger.info({ action: 'ai:analyze', requestId, scope: req.scope, providerId: cfg.id });
      // Fire-and-forget, exactly as before: `aiAnalyze` answers with the
      // requestId and the report arrives over onAiEvent.
      void (async () => {
        let full = '';
        try {
          const apiKey = await resolveApiKey(cfg.apiKeyEncrypted);
          for await (const delta of streamChat({
            baseUrl,
            apiKey,
            model: cfg.model,
            messages: [{ role: 'user', content: prompt }],
            ...(fetchImpl ? { fetchImpl } : {}),
          })) {
            full += delta;
            bus.emit({ channel: Ipc.aiChunk, payload: { requestId, delta } });
          }
          // Persist before signaling done so the renderer can reload and see the
          // history entry.
          await store.update((d) => {
            const history = [
              {
                id: crypto.randomUUID(),
                scope: req.scope,
                ...(req.projectId ? { projectId: req.projectId } : {}),
                createdAt: Date.now(),
                content: full,
              },
              ...((d.misc.aiHistory ?? []) as unknown[]),
            ].slice(0, AI_HISTORY_LIMIT);
            return { ...d, misc: { ...d.misc, aiHistory: history } };
          });
          bus.emit({ channel: Ipc.aiDone, payload: { requestId, full } });
          logger.info({ action: 'ai:analyze:done', requestId, length: full.length });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // `full` is the partial report, never the key: the key only ever
          // reached the Authorization header, which no error path echoes back.
          bus.emit({ channel: Ipc.aiError, payload: { requestId, error: message, full } });
          logger.error({ action: 'ai:analyze:error', requestId, error: message });
        }
      })();
      return { requestId };
    },

    chatSessionsList: async () => chatManager.listSessions(),

    chatSessionCreate: async (raw) => {
      const req = parse('chatSessionCreate', raw) as { providerId?: string };
      return chatManager.createSession(req.providerId);
    },

    chatSessionDelete: async (raw) => {
      const { sessionId } = parse('chatSessionDelete', raw) as { sessionId: string };
      return chatManager.deleteSession(sessionId);
    },

    chatSend: async (raw) => {
      const req = parse('chatSend', raw) as {
        sessionId: string;
        text: string;
        providerId?: string;
      };
      return chatManager.send(req.sessionId, req.text, req.providerId);
    },

    chatContinue: async (raw) => {
      const { sessionId } = parse('chatContinue', raw) as { sessionId: string };
      return chatManager.continue(sessionId);
    },

    chatStop: async (raw) => {
      const { sessionId } = parse('chatStop', raw) as { sessionId: string };
      chatManager.stop(sessionId);
      // 等 run 结算（含 aborted 尾部的 persist），渲染端随后 load() 才能看到中断内容
      await chatManager.waitForIdle(sessionId);
    },
  };

  const api = {} as Record<AiInvokeKey, (raw?: unknown) => Promise<unknown>>;
  for (const key of Object.keys(handlers) as AiInvokeKey[]) {
    const handler = handlers[key];
    api[key] = (raw?: unknown) => handler(raw);
  }

  return {
    ...(api as unknown as AiApi),
    /**
     * `onAiEvent` is one callback for three channels in the shared contract
     * (`aiChunk`/`aiDone`/`aiError`), and the payload carries no channel field
     * — the renderer tells them apart by which optional keys are present. The
     * bus carries the channel internally so the slice can filter, then hands
     * the renderer the bare payload, matching the preload exactly.
     */
    onAiEvent: (cb) =>
      bus.subscribe((payload) => {
        const { channel, payload: body } = payload as { channel: string; payload: AiStreamEvent };
        if (channel === Ipc.aiChunk || channel === Ipc.aiDone || channel === Ipc.aiError) {
          cb(body);
        }
      }),
    onChatEvent: (cb) => bus.subscribe((payload) => cb(payload as ChatEvent)),
  };
}
