import { describe, expect, test } from 'bun:test';
import type { AiProviderConfig } from '@tiny-schedule/shared';
import { buildChatModel } from '../src/main/ai/chatProvider';

const cfg: AiProviderConfig = {
  id: 'c1',
  registryId: 'deepseek',
  apiKeyEncrypted: '',
  model: 'deepseek-chat',
  isDefault: true,
};

describe('buildChatModel', () => {
  test('uses config baseUrl when present', () => {
    const m = buildChatModel({ ...cfg, baseUrl: 'https://my.proxy/v1' }, undefined);
    expect(m.baseUrl).toBe('https://my.proxy/v1');
    expect(m.id).toBe('deepseek-chat');
    expect(m.api).toBe('openai-completions');
  });
  test('falls back to registry baseUrl', () => {
    const m = buildChatModel(cfg, {
      id: 'deepseek',
      name: 'DeepSeek',
      icon: 'deepseek',
      models: [],
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(m.baseUrl).toBe('https://api.deepseek.com/v1');
  });
  test('sane defaults for context and tokens', () => {
    const m = buildChatModel(cfg, undefined);
    expect(m.contextWindow).toBeGreaterThan(0);
    expect(m.maxTokens).toBeGreaterThan(0);
  });
});
