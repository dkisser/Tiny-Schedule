import { z } from 'zod';

export const PROJECT_TITLE_MAX_LENGTH = 32;

export interface Project {
  id: string;
  title: string;
  icon?: string;
  isArchived: boolean;
  // `null` is a legitimate "unset" value (cleared via the color picker);
  // `undefined` is the legacy "never set" state from older backups.
  primaryColor?: string | null;
}

export interface Tag {
  id: string;
  title: string;
  color?: string;
}

export const SYSTEM_TAG_IDS = {
  today: 'TODAY',
  important: 'EM_IMPORTANT',
  urgent: 'EM_URGENT',
} as const;

export const INBOX_PROJECT_ID = 'INBOX_PROJECT';

export const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string().optional(),
  isArchived: z.boolean(),
  // Nullable, not merely optional: `null` is what "the user cleared the color
  // in the picker" persists as, and the schema rejected it. Every save runs
  // through AppDataSchema, so clearing a project color threw and the whole
  // write failed — the user could set a color but never remove one.
  primaryColor: z.string().nullable().optional(),
});

export const TagSchema = z.object({
  id: z.string(),
  title: z.string(),
  color: z.string().optional(),
});

/**
 * The single place a Project record is built.
 *
 * Both projectService.create and ideaService.upgradeToProject minted their own
 * id and their own literal. Every Project field is optional, so adding one
 * with a default produced a type-clean divergence: sidebar-created projects
 * got the field and 升级为项目 ones did not, and switching the id scheme meant
 * finding both by grep.
 */
export function newProject(input: {
  title: string;
  icon?: string;
  primaryColor?: string | null;
}): Project {
  return {
    id: newProjectId(),
    title: input.title.slice(0, PROJECT_TITLE_MAX_LENGTH),
    icon: input.icon,
    isArchived: false,
    primaryColor: input.primaryColor ?? undefined,
  };
}

/**
 * Same shape as newTaskId / newIdeaId / newFollowUpId, and for the same
 * reason: `shared` is imported by the renderer, so it cannot reach for
 * node:crypto.
 */
export function newProjectId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
