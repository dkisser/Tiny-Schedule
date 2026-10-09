import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { AiProviderConfig } from '@tiny-schedule/shared';
import { sseFetch } from '@/bridge/sseFetch';
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

// The `openai` SDK that pi-ai's openai-completions adapter drives would
// otherwise call `globalThis.fetch`, which WKWebView refuses for a third-party
// origin. `ProviderRequestOptions.fetch` is the documented injection point and
// is threaded all the way down to the `new OpenAI({ fetch })` client, so this
// one option is what routes the whole chat agent through the Rust SSE bridge.
export function createChatStreamFn(apiKey: string) {
  return (
    model: ChatModel,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream =>
    streamSimple(model, context, {
      ...options,
      apiKey,
      fetch: sseFetch as unknown as typeof fetch,
    });
}
