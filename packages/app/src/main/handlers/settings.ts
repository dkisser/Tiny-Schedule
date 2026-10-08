import type { AppSettings } from '@tiny-schedule/shared';
import type { DataStore } from '../infra/dataStore';
import { encryptKey } from '../infra/keys';
import { masked } from './deps';

/**
 * 设置的 handler。设置不属于四个聚合中的任何一个，但它有自己的写规则
 * （api key 明文入、密文落盘），所以留在 handler 层而不是硬塞进某个 service。
 */
export function settingsHandlers({
  store,
  logger,
}: {
  store: DataStore;
  logger: { info: (o: object) => void };
}) {
  return {
    settingsUpdate: (patch: Partial<SettingsUpdatePatch>) => {
      const next = store.update((d) => {
        const settings = { ...d.settings };
        if (patch.userName !== undefined) settings.userName = patch.userName;
        if (patch.avatar !== undefined) settings.avatar = patch.avatar;
        if (patch.theme !== undefined) settings.theme = patch.theme;
        if (patch.aiPrompt !== undefined) settings.aiPrompt = patch.aiPrompt;
        if (patch.autoAiAnalyzeOnFinishDay !== undefined) {
          settings.autoAiAnalyzeOnFinishDay = patch.autoAiAnalyzeOnFinishDay;
        }
        if (patch.idlePauseEnabled !== undefined)
          settings.idlePauseEnabled = patch.idlePauseEnabled;
        if (patch.idlePauseMinutes !== undefined) {
          settings.idlePauseMinutes = patch.idlePauseMinutes;
        }
        if (patch.aiProviders !== undefined) {
          settings.aiProviders = patch.aiProviders.map((p) => {
            const prev = d.settings.aiProviders.find((x) => x.id === p.id);
            return {
              id: p.id,
              registryId: p.registryId,
              baseUrl: p.baseUrl,
              apiKeyEncrypted:
                p.apiKey === '<unchanged>' && prev ? prev.apiKeyEncrypted : encryptKey(p.apiKey),
              model: p.model,
              isDefault: p.isDefault,
            };
          });
        }
        return { ...d, settings };
      });
      logger.info({ action: 'settings:update', keys: Object.keys(patch) });
      return masked(next);
    },
  };
}

export interface SettingsUpdatePatch {
  userName?: AppSettings['userName'];
  avatar?: AppSettings['avatar'];
  theme?: AppSettings['theme'];
  aiPrompt?: AppSettings['aiPrompt'];
  autoAiAnalyzeOnFinishDay?: AppSettings['autoAiAnalyzeOnFinishDay'];
  idlePauseEnabled?: AppSettings['idlePauseEnabled'];
  idlePauseMinutes?: AppSettings['idlePauseMinutes'];
  aiProviders?: {
    id: string;
    registryId: string;
    apiKey: string;
    baseUrl?: string;
    model: string;
    isDefault: boolean;
  }[];
}
