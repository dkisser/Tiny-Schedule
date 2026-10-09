import { type AppData, dropStaleTiming } from '@tiny-schedule/shared';
import { mergeImport } from '../infra/importer';
import { migrateRemoveTodayTag } from '../infra/migrations';
import type { ServiceDeps } from './taskService';

/**
 * 导入的写侧唯一入口（ADR-0003）。
 *
 * 导入不属于任何一个聚合，但它是唯一一条能一次性塞进一整批任务的写路径——因此
 * 它必须自己承担不变量，而不是把 store.update 留在 handler 里：那里没有 service
 * 可以复用，dropStaleTiming 也就只能内联一份。下一个加自动导入/撤销栈的人照着
 * deps.ts 的规则写，却拿不到这份内联清扫。
 */
export interface ImportMergeResult {
  data: AppData;
  /** 这次合并清掉了一个仍然在计时的已完成任务。 */
  droppedTimer: boolean;
}

export function createImportService({ store, logger }: ServiceDeps) {
  return {
    mergeImported(imported: AppData): ImportMergeResult {
      // The merge keeps the current activeTimer while letting an imported task
      // win an id collision, so it can hand us a done task that is still being
      // timed. Sweep it here rather than leaving the state for a later write to
      // clean up; the caller announces the drop to the renderer.
      const hadTimer = !!store.get().activeTimer;
      const { data } = store.update((d) =>
        dropStaleTiming(migrateRemoveTodayTag(mergeImport(d, imported))),
      );
      const droppedTimer = hadTimer && !data.activeTimer;
      if (droppedTimer) logger.info({ action: 'timer:drop:import' });
      return { data, droppedTimer };
    },
  };
}

export type ImportService = ReturnType<typeof createImportService>;
