/**
 * The storage domain declaration.
 *
 * One domain, one file (`<root>/task_tracker.json` under the json backend's
 * root), seven tables plus a global slot. The names must match the storage
 * hub's unit-name rule: lowercase, snake_case.
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import {
  ActiveTimerRecordSchema,
  DEFAULT_SETTINGS,
  FollowUpRecordSchema,
  GlobalStateSchema,
  IdeaRecordSchema,
  ProjectRecordSchema,
  TagRecordSchema,
  TaskOrderRecordSchema,
  TaskRecordSchema,
  TimeEntryRecordSchema,
} from '../domain/schema.ts';

export const taskTrackerDomainSpec = defineDomain({
  name: 'task_tracker',
  version: 1,
  global: {
    schema: GlobalStateSchema,
    initial: { settings: DEFAULT_SETTINGS, activeTimer: null },
  },
  tables: {
    tasks: domainTable(TaskRecordSchema),
    projects: domainTable(ProjectRecordSchema),
    tags: domainTable(TagRecordSchema),
    time_entries: domainTable(TimeEntryRecordSchema),
    ideas: domainTable(IdeaRecordSchema),
    follow_ups: domainTable(FollowUpRecordSchema),
    task_order: domainTable(TaskOrderRecordSchema),
  },
});

export type TaskTrackerDomainSpec = typeof taskTrackerDomainSpec;
