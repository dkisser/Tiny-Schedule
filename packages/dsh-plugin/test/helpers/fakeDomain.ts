/**
 * An in-memory stand-in for the storage domain.
 *
 * The service only touches `domain.table(name)` and `domain.global`, so a
 * faithful fake is enough to test the write path without a medium.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { taskTrackerDomainSpec } from '../../src/service/spec.ts';

type Table = Map<string, unknown>;

export interface FakeDomain {
  domain: Domain<typeof taskTrackerDomainSpec>;
  tables: Record<string, Table>;
  globalValue: Record<string, unknown>;
}

const TABLE_NAMES = [
  'tasks',
  'projects',
  'tags',
  'time_entries',
  'ideas',
  'follow_ups',
  'task_order',
] as const;

/**
 * Build a fake domain.
 * @param global - the initial global value.
 * @returns the fake domain and its tables.
 */
export function createFakeDomain(
  global: Record<string, unknown> = {
    settings: { urgencyThresholdDays: 2, longTermHorizonDays: 14 },
    activeTimer: null,
  },
): FakeDomain {
  const tables: Record<string, Table> = {};
  for (const name of TABLE_NAMES) tables[name] = new Map();
  const fake: FakeDomain = { domain: undefined as never, tables, globalValue: { ...global } };

  const table = (name: string) => {
    const rows = tables[name] ?? new Map();
    tables[name] = rows;
    return {
      get: (key: string) => rows.get(key),
      entries: () => rows.entries(),
      keys: () => rows.keys(),
      get size() {
        return rows.size;
      },
      put: async (key: string, value: unknown) => {
        rows.set(key, value);
      },
      delete: async (key: string) => rows.delete(key),
      update: async (key: string, fn: (current: unknown) => unknown) => {
        const next = fn(rows.get(key));
        rows.set(key, next);
        return next;
      },
    };
  };

  fake.domain = {
    name: 'task_tracker',
    global: {
      get: () => fake.globalValue,
      set: async (value: Record<string, unknown>) => {
        fake.globalValue = { ...value };
      },
    },
    table: (name: never) => table(name),
    close: async () => {},
  } as unknown as Domain<typeof taskTrackerDomainSpec>;

  return fake;
}
