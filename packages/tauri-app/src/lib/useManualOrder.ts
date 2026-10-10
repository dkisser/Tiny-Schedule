import type { Task } from '@tiny-schedule/shared';
import { useEffect, useRef, useState } from 'react';
import { useDataStore } from '../stores/data';

export interface ManualOrder {
  ordered: Task[];
  onReorder: (ids: string[]) => void;
}

/**
 * Manual drag order for one view, persisted per viewKey.
 *
 * Reconciles when membership changes (task added/completed/deleted): keeps the
 * current manual order for remaining items, appends new ones at the end.
 */
export function useManualOrder(tasks: Task[], viewKey: string): ManualOrder {
  const [ids, setIds] = useState<string[]>(() => tasks.map((t) => t.id));
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const membershipKey = tasks
    .map((t) => t.id)
    .sort()
    .join(',');
  useEffect(() => {
    setIds((prev) => {
      const current = tasksRef.current.map((t) => t.id);
      const currentSet = new Set(current);
      const kept = prev.filter((id) => currentSet.has(id));
      const keptSet = new Set(kept);
      return [...kept, ...current.filter((id) => !keptSet.has(id))];
    });
  }, [membershipKey]);

  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    ordered: ids.map((id) => byId.get(id)).filter((t): t is Task => Boolean(t)),
    onReorder: (next) => {
      setIds(next);
      useDataStore.getState().setTaskOrder(viewKey, next);
    },
  };
}
