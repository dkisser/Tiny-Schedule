import type { HandlerDeps } from './deps';
import { masked, written } from './deps';

/** 项目/标签/排序的 handler：只转调 projectService。 */
export function projectHandlers({ projects }: HandlerDeps) {
  return {
    projectCreate: (req: { title: string; icon?: string; primaryColor?: string }) => {
      const { data, projectId, persisted } = projects.create(req);
      return { ...written({ data, persisted }), projectId };
    },

    projectUpdate: (req: {
      id: string;
      title?: string;
      primaryColor?: string | null;
      isArchived?: boolean;
    }) => written(projects.update(req)),

    projectDelete: (req: { id: string }) => written(projects.remove(req.id)),

    tagCreate: (req: { title: string; color?: string }) => written(projects.createTag(req)),

    tagUpdate: (req: { id: string; title?: string; color?: string }) =>
      written(projects.updateTag(req)),

    tagDelete: (req: { id: string }) => written(projects.removeTag(req.id)),

    orderSet: ({ viewKey, ids }: { viewKey: string; ids: string[] }) => {
      projects.setOrder(viewKey, ids);
    },
  };
}
