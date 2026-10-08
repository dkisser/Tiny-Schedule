import type { HandlerDeps } from './deps';
import { masked } from './deps';

/** 项目/标签/排序的 handler：只转调 projectService。 */
export function projectHandlers({ projects }: HandlerDeps) {
  return {
    projectCreate: (req: { title: string; icon?: string; primaryColor?: string }) =>
      masked(projects.create(req).data),

    projectUpdate: (req: {
      id: string;
      title?: string;
      primaryColor?: string | null;
      isArchived?: boolean;
    }) => masked(projects.update(req)),

    projectDelete: (req: { id: string }) => masked(projects.remove(req.id)),

    tagCreate: (req: { title: string; color?: string }) => masked(projects.createTag(req)),

    tagUpdate: (req: { id: string; title?: string; color?: string }) =>
      masked(projects.updateTag(req)),

    tagDelete: (req: { id: string }) => masked(projects.removeTag(req.id)),

    orderSet: ({ viewKey, ids }: { viewKey: string; ids: string[] }) => {
      projects.setOrder(viewKey, ids);
    },
  };
}
