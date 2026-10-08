import type { FollowUp } from '@tiny-schedule/shared';
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
    followUpResolve: ({ id }: { id: string }) => {
      const next = followUps.resolve(id);
      return next ? masked(next) : null;
    },
    followUpReopen: ({ id }: { id: string }) => {
      const next = followUps.reopen(id);
      return next ? masked(next) : null;
    },
  };
}
