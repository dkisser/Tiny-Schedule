import type { AppData, AppSettings } from '@tiny-schedule/shared';
import type { ServiceDeps } from './taskService';

/**
 * 设置的写侧唯一入口（ADR-0003）。
 *
 * 设置不属于四个聚合中的任何一个，却有自己的写规则：api key 明文入、密文落盘。
 * 规则住在 handler 层就意味着每条新写路径都得重新记得 encryptKey——任何新的
 * 设置通道、agent 工具或自动流程漏一次，就是把明文 key 写进 data.json。放进
 * service 之后，这条规则只剩一处可以审。
 *
 * encryptKey 由组装点注入，与 store / logger 同级。此前它仍是按路径 import 的，
 * 于是这条约束只做了一半：约束的是"要审的地方只有一处"，而不是"新调用方无法绕
 * 过"。注入之后，换掉加密实现（safeStorage、测试替身）不必改这个文件，而这条
 * 规则依赖的形状也由类型摆在这里，而不是藏在一个 import 里。
 */

export interface SettingsDeps extends ServiceDeps {
  encryptKey: (plain: string) => string;
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

export function createSettingsService({ store, logger, encryptKey }: SettingsDeps) {
  return {
    update(patch: SettingsUpdatePatch): AppData {
      const { data: next, persisted } = store.update((d) => {
        const settings = { ...d.settings };
        if (patch.userName !== undefined) settings.userName = patch.userName;
        if (patch.avatar !== undefined) settings.avatar = patch.avatar;
        if (patch.theme !== undefined) settings.theme = patch.theme;
        if (patch.aiPrompt !== undefined) settings.aiPrompt = patch.aiPrompt;
        if (patch.autoAiAnalyzeOnFinishDay !== undefined) {
          settings.autoAiAnalyzeOnFinishDay = patch.autoAiAnalyzeOnFinishDay;
        }
        if (patch.idlePauseEnabled !== undefined) {
          settings.idlePauseEnabled = patch.idlePauseEnabled;
        }
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
              // '<unchanged>' is the renderer's "I did not touch this key"
              // sentinel. Encrypting it verbatim would destroy the stored
              // ciphertext, so an untouched provider keeps what it had.
              apiKeyEncrypted:
                p.apiKey === '<unchanged>' && prev ? prev.apiKeyEncrypted : encryptKey(p.apiKey),
              model: p.model,
              isDefault: p.isDefault,
            };
          });
        }
        return { ...d, settings };
      });
      // persisted stays in the log even though it no longer rides the return
      // value: an operator asking "did this user's setting change land?" reads
      // the logs, and a line indistinguishable from a successful save is the
      // only record left of a refused one.
      logger.info({ action: 'settings:update', keys: Object.keys(patch), persisted });
      return next;
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
