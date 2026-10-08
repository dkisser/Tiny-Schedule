import { randomUUID } from 'node:crypto';
import type { ServiceDeps } from './taskService';

/** How many analysis entries are retained. Older ones fall off the front. */
const AI_HISTORY_LIMIT = 50;

export interface AiHistoryEntry {
  scope: 'today' | 'week' | 'project';
  projectId?: string;
  content: string;
}

/**
 * AI 分析历史的写侧唯一入口（ADR-0003）。
 *
 * 这不是聚合数据，但 handler 不写 store 是 deps.ts 写死的规矩——流式请求的编排
 * 属于 handler，落库属于这里。留在这两者的接缝里，唯一的读者是 handler 自己的
 * 下一段代码。
 */
export function createAiHistoryService({ store, logger }: ServiceDeps) {
  return {
    append(entry: AiHistoryEntry): void {
      const record = {
        id: randomUUID(),
        scope: entry.scope,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        createdAt: Date.now(),
        content: entry.content,
      };
      store.update((d) => {
        const history = [record, ...((d.misc.aiHistory ?? []) as unknown[])].slice(
          0,
          AI_HISTORY_LIMIT,
        );
        return { ...d, misc: { ...d.misc, aiHistory: history } };
      });
      logger.info({ action: 'ai:history:append', scope: entry.scope });
    },
  };
}

export type AiHistoryService = ReturnType<typeof createAiHistoryService>;
