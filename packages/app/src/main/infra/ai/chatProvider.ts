import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { AiProviderConfig } from '@tiny-schedule/shared';
import type { ProviderDef } from './providers';

export type ChatModel = Model<'openai-completions'>;

// 直调 pi-ai API 而非注册 provider：我们已有自己的 provider 配置与 key
// 加密体系，pi 的 auth 层是多余的一层。
export function buildChatModel(cfg: AiProviderConfig, def: ProviderDef | undefined): ChatModel {
  return {
    id: cfg.model,
    name: cfg.model,
    api: 'openai-completions',
    provider: cfg.registryId,
    baseUrl: cfg.baseUrl ?? def?.baseUrl ?? '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

export function createChatStreamFn(apiKey: string) {
  return (
    model: ChatModel,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => streamSimple(model, context, { ...options, apiKey });
}
