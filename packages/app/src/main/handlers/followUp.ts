import type { FollowUpCommandResult, FollowUpEdit } from '@tiny-schedule/shared';
import type { HandlerDeps } from './deps';
import { masked, maskedResult } from './deps';

/**
 * 跟进的 handler：upsert 只带编辑器字段（不含 isResolved/resolvedAt），状态推进
 * 走 service 的 resolve/reopen —— 办结时刻由主进程盖，渲染进程不再自己拼
 * isResolved，也不会带着陈旧快照把它撤销。
 */
export function followUpHandlers({ followUps }: HandlerDeps) {
  return {
    followUpUpsert: (patch: FollowUpEdit) => masked(followUps.edit(patch)),
    followUpDelete: ({ id }: { id: string }) => masked(followUps.remove(id)),
    // A rejection is a { ok, error } envelope, never a bare null: the renderer
    // adopts this value as its entire dataset, so a null here blanked the app
    // with no code to distinguish "gone" from "loaded nothing yet".
    followUpResolve: ({ id }: { id: string }): FollowUpCommandResult =>
      maskedResult(followUps.resolve(id)),
    followUpReopen: ({ id }: { id: string }): FollowUpCommandResult =>
      maskedResult(followUps.reopen(id)),
  };
}
