import {
  type AppData,
  IpcInvokeContract,
  type IpcInvokeFn,
  type IpcInvokeKey,
  maskDataForRenderer,
  type ScheduledTaskRunAddReq,
  type ScheduledTaskRunFinishReq,
  type ScheduledTaskRunsListReq,
  type ScheduledTaskUpsertReq,
} from '@tiny-schedule/shared';
import { consoleLogger } from '@/ai/logger';
import type { DataStore } from '@/bridge/dataStore';
import { createScheduledTaskService } from '@/bridge/scheduledTaskService';

/**
 * 定时任务的 slice：5 个 invoke（字段编辑、删除、落一条运行、终结一条运行、按任务
 * 查运行）。
 *
 * 刻意不做 `dataLoad` 之外的全量刷新替代品——定时任务本身在 AppData 里，界面的
 * 渲染与其它实体一致。单独存在的只有运行查询，因为运行记录会一直增长，全量塞进
 * AppData 只是把一个列表页的数据量推给每一个客户端。
 *
 * 校验与 data slice 同源：每个请求都先过 `IpcInvokeContract` 里的 zod schema。
 */
export type ScheduledTaskApi = {
  [K in ScheduledTaskInvokeKey]: IpcInvokeFn<K>;
};

/** The contract keys this slice owns. */
export type ScheduledTaskInvokeKey = Extract<
  IpcInvokeKey,
  | 'scheduledTaskUpsert'
  | 'scheduledTaskDelete'
  | 'scheduledTaskRunAdd'
  | 'scheduledTaskRunFinish'
  | 'scheduledTaskRunsList'
>;

/**
 * Applies the contract's zod schema before the handler runs — the same guarantee
 * ipcHandlers.ts gave centrally, now that the IPC layer is gone.
 */
function parse<K extends ScheduledTaskInvokeKey>(key: K, raw: unknown): unknown {
  const entry = IpcInvokeContract[key] as { req?: { parse(value: unknown): unknown } };
  return entry.req ? entry.req.parse(raw) : raw;
}

export function createScheduledTaskApi(store: DataStore): ScheduledTaskApi {
  const service = createScheduledTaskService({ store, logger: consoleLogger });
  const masked = (data: AppData): AppData => maskDataForRenderer(data);

  const handlers: Record<ScheduledTaskInvokeKey, (raw: unknown) => Promise<unknown>> = {
    scheduledTaskUpsert: async (raw) => {
      const req = parse('scheduledTaskUpsert', raw) as ScheduledTaskUpsertReq;
      return masked(await service.upsert(req));
    },

    /** Cascades the task's runs in the same write; see the service. */
    scheduledTaskDelete: async (raw) => {
      const { id } = parse('scheduledTaskDelete', raw) as { id: string };
      return masked(await service.remove(id));
    },

    scheduledTaskRunAdd: async (raw) => {
      const { run } = parse('scheduledTaskRunAdd', raw) as ScheduledTaskRunAddReq;
      return masked(await service.appendRun(run));
    },

    /**
     * 收尾：把那条 running 改写为终态。契约里的 schema 已经拒掉了非终态的请求，所以
     * 这个 handler 拿到的必然是一次运行的结局，不是又一次开始。
     */
    scheduledTaskRunFinish: async (raw) => {
      const { run } = parse('scheduledTaskRunFinish', raw) as ScheduledTaskRunFinishReq;
      return masked(await service.finalizeRun(run));
    },

    /** Newest first, so the run history reads top-down without the caller sorting. */
    scheduledTaskRunsList: async (raw) => {
      const { scheduledTaskId } = parse('scheduledTaskRunsList', raw) as ScheduledTaskRunsListReq;
      return service.listRuns(scheduledTaskId);
    },
  };

  return handlers as unknown as ScheduledTaskApi;
}
