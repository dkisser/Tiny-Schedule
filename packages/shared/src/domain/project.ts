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
  primaryColor: z.string().optional(),
});

export const TagSchema = z.object({
  id: z.string(),
  title: z.string(),
  color: z.string().optional(),
});
