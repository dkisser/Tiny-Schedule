import type { FollowUp, FollowUpCommandResult } from '@tiny-schedule/shared';
import type { HandlerDeps } from './deps';
import { masked } from './deps';

/**
 * 跟进的 handler：upsert 保持现状（编辑器字段），状态推进走 service 的
 * resolve/reopen —— 办结时刻由主进程盖，渲染进程不再自己拼 isResolved。
 */
export function followUpHandlers({ followUps }: HandlerDeps) {
  return {
    followUpUpsert: (followUp: FollowUp) => masked(followUps.upsert(followUp)),
    followUpDelete: ({ id }: { id: string }) => masked(followUps.remove(id)),
    // A rejection is a { ok, error } envelope, never a bare null: the renderer
    // adopts this value as its entire dataset, so a null here blanked the app
    // with no code to distinguish "gone" from "loaded nothing yet".
    followUpResolve: ({ id }: { id: string }): FollowUpCommandResult => {
      const result = followUps.resolve(id);
      return result.ok ? { ...result, data: masked(result.data) } : result;
    },
    followUpReopen: ({ id }: { id: string }): FollowUpCommandResult => {
      const result = followUps.reopen(id);
      return result.ok ? { ...result, data: masked(result.data) } : result;
    },
  };
}
