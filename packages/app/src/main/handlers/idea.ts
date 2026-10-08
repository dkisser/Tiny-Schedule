import type { IdeaEdit } from '@tiny-schedule/shared';
import type { HandlerDeps } from './deps';
import { masked } from './deps';

/**
 * 想法的 handler：写契约是意图命令集，所以这里的方法名就是领域语言。
 * 守卫（终态规则）全在 ideaService 里，handler 不复述任何一条。
 */
export function ideaHandlers({ ideas }: HandlerDeps) {
  return {
    /** 字段编辑：请求只带非状态字段，合并由 service 完成。 */
    ideaUpsert: (patch: IdeaEdit) => masked(ideas.edit(patch)),

    ideaDelete: ({ id }: { id: string }) => masked(ideas.remove(id)),

    ideaComplete: ({ id }: { id: string }) => ideas.complete(id),

    ideaDiscard: ({ id }: { id: string }) => ideas.discard(id),

    ideaReopen: ({ id }: { id: string }) => ideas.reopen(id),

    ideaConvertToTask: ({ id, title }: { id: string; title?: string }) => {
      const result = ideas.convertToTask(id, title);
      if (!result.ok) return result;
      return { ok: true as const, data: masked(result.data), taskId: result.taskId };
    },

    /**
     * 升级为项目：建项目与转状态在 service 内一次 store.update 完成，
     * 因此这里不存在"项目建好了但想法没转"的中间态。
     */
    ideaUpgradeToProject: (req: {
      id: string;
      title: string;
      icon?: string;
      primaryColor?: string;
      validationGoal?: string;
    }) => {
      const result = ideas.upgradeToProject(req.id, req);
      if (!result.ok) return result;
      return { ok: true as const, data: masked(result.data), projectId: result.projectId };
    },

    ideaCloseWithVerdict: ({
      id,
      result,
      text,
    }: {
      id: string;
      result: 'validated' | 'invalidated' | 'partial';
      text?: string;
    }) => ideas.closeWithVerdict(id, result, text),
  };
}
