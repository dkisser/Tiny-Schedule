import type { ProviderInfo } from '@tiny-schedule/shared';

export interface ProviderDef extends ProviderInfo {
  baseUrl: string;
}

// 新增 Provider 只需在此数组加一条（OpenAI 兼容协议）
export const PROVIDER_REGISTRY: ProviderDef[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    icon: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    icon: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    icon: 'custom',
    baseUrl: '',
    models: [],
  },
];

export function getProviderDef(id: string): ProviderDef | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id);
}

export function toProviderInfo(def: ProviderDef): ProviderInfo {
  return { id: def.id, name: def.name, icon: def.icon, models: def.models };
}
