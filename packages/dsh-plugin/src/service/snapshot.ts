/**
 * The shape the browser renders.
 *
 * Kept in its own module so the browser half can import the types without
 * pulling the host's runtime (the domain spec, the service) into the browser
 * bundle.
 */
import type {
  ActiveTimerRecord,
  FollowUpRecord,
  IdeaRecord,
  ProjectRecord,
  SettingsRecord,
  TagRecord,
} from '../domain/schema.ts';
import type { TaskView } from '../domain/types.ts';

export interface TrackerSnapshot {
  settings: SettingsRecord;
  activeTimer: ActiveTimerRecord | null;
  tasks: TaskView[];
  projects: ProjectRecord[];
  tags: TagRecord[];
  ideas: IdeaRecord[];
  followUps: FollowUpRecord[];
  orders: Record<string, string[]>;
}
