import type { HandlerDeps } from './deps';
import { masked, REFUSED, written } from './deps';

/**
 * 项目/标签/排序的 handler：只转调 projectService。
 *
 * 除 create 外全部返回裸 AppData —— 它们的结果只用来刷新界面，"这个应用现在
 * 还在保存吗"由 store 模式推送（ADR-0004），不需要逐次携带。create 多返回一个
 * id，调用方要用它，所以它必须能说清这次写入到底有没有发生。
 */
export function projectHandlers({ projects }: HandlerDeps) {
  return {
    projectCreate: (req: { title: string; icon?: string; primaryColor?: string }) => {
      const { data, projectId, persisted } = projects.create(req);
      // A refused create must not hand back the id of a project that was never
      // written: the caller navigates to whatever this returns.
      if (!persisted) return REFUSED;
      return { ...written(data), projectId };
    },

    projectUpdate: (req: {
      id: string;
      title?: string;
      primaryColor?: string | null;
      isArchived?: boolean;
    }) => masked(projects.update(req)),

    projectDelete: (req: { id: string }) => masked(projects.remove(req.id)),

    // Control flow for the same reason create is: the sidebar clears the
    // draft only once this lands, so a refused create must not consume the
    // name the user just typed. Same UI, same rule — the tag path being a
    // bare AppData while the project path was not would have made "create a
    // group" quietly behave two different ways.
    tagCreate: (req: { title: string; color?: string }) => {
      const { data, persisted } = projects.createTagWithOutcome(req);
      if (!persisted) return REFUSED;
      return written(data);
    },

    tagUpdate: (req: { id: string; title?: string; color?: string }) =>
      masked(projects.updateTag(req)),

    tagDelete: (req: { id: string }) => masked(projects.removeTag(req.id)),

    orderSet: ({ viewKey, ids }: { viewKey: string; ids: string[] }) => {
      projects.setOrder(viewKey, ids);
    },
  };
}
