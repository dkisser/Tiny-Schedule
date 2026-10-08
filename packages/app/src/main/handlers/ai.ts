import { randomUUID } from 'node:crypto';
import { Ipc, localDate } from '@tiny-schedule/shared';
import type { BrowserWindow } from 'electron';
import { streamChat, testConnection } from '../infra/ai/client';
import { getProviderDef, PROVIDER_REGISTRY, toProviderInfo } from '../infra/ai/providers';
import type { DataStore } from '../infra/dataStore';
import { decryptKey } from '../infra/keys';
import { buildAnalysisData, renderPrompt } from '../services/prompts';
import { sendSafe } from './deps';

/**
 * AI 日报（非 agent）的 handler：供应商网络调用在 infra/ai，这里只编排
 * 一次流式请求并把增量推给渲染进程。持久化的是分析历史，不是聚合数据。
 */
export function aiHandlers({
  store,
  logger,
  getWindow,
}: {
  store: DataStore;
  logger: { info: (o: object) => void; error: (o: object) => void };
  getWindow: () => BrowserWindow | null;
}) {
  return {
    aiRegistry: () => PROVIDER_REGISTRY.map(toProviderInfo),

    aiTestProvider: async ({ providerId }: { providerId: string }) => {
      const cfg = store.get().settings.aiProviders.find((p) => p.id === providerId);
      if (!cfg) return { ok: false, error: 'PROVIDER_NOT_CONFIGURED' };
      const def = getProviderDef(cfg.registryId);
      const baseUrl = cfg.baseUrl ?? def?.baseUrl ?? '';
      if (!baseUrl) return { ok: false, error: 'MISSING_BASE_URL' };
      const result = await testConnection(baseUrl, decryptKey(cfg.apiKeyEncrypted));
      logger.info({ action: 'ai:testProvider', providerId, ok: result.ok });
      return result;
    },

    aiProviderKeyReveal: ({ providerId }: { providerId: string }) => {
      const cfg = store.get().settings.aiProviders.find((p) => p.id === providerId);
      if (!cfg) return { apiKey: '' };
      return { apiKey: decryptKey(cfg.apiKeyEncrypted) };
    },

    aiAnalyze: (req: {
      scope: 'today' | 'week' | 'project';
      projectId?: string;
      providerId?: string;
    }) => {
      const requestId = randomUUID();
      const data = store.get();
      const providers = data.settings.aiProviders;
      const cfg = req.providerId
        ? providers.find((p) => p.id === req.providerId)
        : (providers.find((p) => p.isDefault) ?? providers[0]);
      if (!cfg) {
        sendSafe(getWindow(), Ipc.aiError, { requestId, error: 'NO_PROVIDER_CONFIGURED' });
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
      void (async () => {
        const win = getWindow();
        let full = '';
        try {
          for await (const delta of streamChat({
            baseUrl,
            apiKey: decryptKey(cfg.apiKeyEncrypted),
            model: cfg.model,
            messages: [{ role: 'user', content: prompt }],
          })) {
            full += delta;
            sendSafe(win, Ipc.aiChunk, { requestId, delta });
          }
          // Persist before signaling done so the renderer can reload and see the history entry.
          store.update((d) => {
            const history = [
              {
                id: randomUUID(),
                scope: req.scope,
                ...(req.projectId ? { projectId: req.projectId } : {}),
                createdAt: Date.now(),
                content: full,
              },
              ...((d.misc.aiHistory ?? []) as unknown[]),
            ].slice(0, 50);
            return { ...d, misc: { ...d.misc, aiHistory: history } };
          });
          sendSafe(win, Ipc.aiDone, { requestId, full });
          logger.info({ action: 'ai:analyze:done', requestId, length: full.length });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendSafe(win, Ipc.aiError, { requestId, error: message, full });
          logger.error({ action: 'ai:analyze:error', requestId, error: message });
        }
      })();
      return { requestId };
    },
  };
}
