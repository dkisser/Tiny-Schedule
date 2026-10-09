import type { SettingsService, SettingsUpdatePatch } from '../services/settingsService';
import { masked } from './deps';

/**
 * 设置的 handler。设置不属于四个聚合中的任何一个，但它有自己的写规则
 * （api key 明文入、密文落盘），所以给它自己的 service 而不是硬塞进某个聚合。
 * 那条 encryptKey 规则是 handler 层的裸 store 写法唯一能守住的东西：绕过
 * DI 就没有下一个写路径可以被结构性地检查到。
 */
export function settingsHandlers({ settings }: { settings: SettingsService }) {
  return {
    // Bare AppData: the renderer only refreshes state from this, and "is the app
    // still saving" is pushed as a store mode instead (ADR-0004).
    settingsUpdate: (patch: Partial<SettingsUpdatePatch>) => masked(settings.update(patch)),
  };
}
