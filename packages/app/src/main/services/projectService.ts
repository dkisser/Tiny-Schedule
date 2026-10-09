import { randomUUID } from 'node:crypto';
import {
  type AppData,
  INBOX_PROJECT_ID,
  newProject,
  PROJECT_TITLE_MAX_LENGTH,
} from '@tiny-schedule/shared';
import { listMeta, type MetaResult } from './projectQueries';
import type { ServiceDeps } from './taskService';

/**
 * 项目与标签的写侧唯一入口（ADR-0003）。Inbox 是系统项目，任何写路径都不能
 * 改它——守卫在这里，handler 不再重复这个判断。
 */

export interface ProjectCreateInput {
  title: string;
  icon?: string;
  primaryColor?: string;
}

export interface ProjectUpdateInput {
  id: string;
  title?: string;
  primaryColor?: string | null;
  isArchived?: boolean;
}

export function createProjectService({ store, logger }: ServiceDeps) {
  return {
    // create is a control-flow channel: the renderer navigates to the id, so
    // it must be able to tell whether the project was actually written.
    create(req: ProjectCreateInput): { data: AppData; projectId: string; persisted: boolean } {
      const project = newProject(req);
      const projectId = project.id;
      const { data: next, persisted } = store.update((d) => ({
        ...d,
        projects: {
          ...d.projects,
          [projectId]: project,
        },
      }));
      logger.info({ action: 'project:create', title: project.title });
      return { data: next, projectId, persisted };
    },

    update(req: ProjectUpdateInput): AppData {
      const { data: next } = store.update((d) => {
        const prev = d.projects[req.id];
        // Inbox is a system project: never accept updates through the IPC.
        if (!prev || req.id === INBOX_PROJECT_ID) return d;
        // Partial-merge: only apply fields that are explicitly present in the
        // request. `null` clears (e.g. clearing a project color); `undefined`
        // leaves the existing value untouched. Mirrors `tagUpdate`.
        const patch: Partial<typeof prev> = {};
        if (req.title !== undefined) patch.title = req.title.slice(0, PROJECT_TITLE_MAX_LENGTH);
        if (req.primaryColor !== undefined) patch.primaryColor = req.primaryColor;
        if (req.isArchived !== undefined) patch.isArchived = req.isArchived;
        if (Object.keys(patch).length === 0) return d;
        return {
          ...d,
          projects: { ...d.projects, [req.id]: { ...prev, ...patch } },
        };
      });
      logger.info({
        action: 'project:update',
        id: req.id,
        keys: Object.keys(req).filter((k) => k !== 'id'),
      });
      return next;
    },

    /**
     * Delete a project. Tasks keep their projectTitle snapshot; only the
     * grouping moves to Inbox. Inbox itself is never deletable.
     */
    remove(id: string): AppData {
      if (id === INBOX_PROJECT_ID) return store.get();
      const { data: next } = store.update((d) => {
        if (!d.projects[id]) return d;
        const projects = { ...d.projects };
        delete projects[id];
        const tasks = { ...d.tasks };
        for (const t of Object.values(tasks)) {
          if (t.projectId === id) tasks[t.id] = { ...t, projectId: INBOX_PROJECT_ID };
        }
        return { ...d, projects, tasks };
      });
      logger.info({ action: 'project:delete', id });
      return next;
    },

    createTag(req: { title: string; color?: string }): AppData {
      return this.createTagWithOutcome(req).data;
    },

    /** Same write, plus whether it landed — see tagCreate in the handler. */
    createTagWithOutcome(req: { title: string; color?: string }): {
      data: AppData;
      persisted: boolean;
    } {
      const { data: next, persisted } = store.update((d) => {
        const id = `tag_${randomUUID()}`;
        return { ...d, tags: { ...d.tags, [id]: { id, title: req.title, color: req.color } } };
      });
      logger.info({ action: 'tag:create', title: req.title, persisted });
      return { data: next, persisted };
    },

    updateTag(req: { id: string; title?: string; color?: string }): AppData {
      const { data: next } = store.update((d) => {
        const prev = d.tags[req.id];
        if (!prev) return d;
        const updated = {
          ...prev,
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.color !== undefined ? { color: req.color } : {}),
        };
        return { ...d, tags: { ...d.tags, [req.id]: updated } };
      });
      logger.info({ action: 'tag:update', id: req.id, title: req.title });
      return next;
    },

    removeTag(id: string): AppData {
      const { data: next } = store.update((d) => {
        if (!d.tags[id]) return d;
        const tags = { ...d.tags };
        delete tags[id];
        // Tasks keep tagIds + snapshot labels so their chips stay visible.
        return { ...d, tags };
      });
      logger.info({ action: 'tag:delete', id });
      return next;
    },

    /** Manual ordering lives in misc.taskOrder; keyed per view. */
    setOrder(viewKey: string, ids: string[]): AppData {
      const next = store.update((d) => {
        const taskOrder = (d.misc.taskOrder ?? {}) as Record<string, string[]>;
        return { ...d, misc: { ...d.misc, taskOrder: { ...taskOrder, [viewKey]: ids } } };
      }).data;
      logger.info({ action: 'order:set', viewKey, count: ids.length });
      return next;
    },

    /** 读侧查询：AI agent 的 listProjects 工具经由这里取数。 */
    listMeta(): MetaResult {
      return listMeta(store.get());
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
