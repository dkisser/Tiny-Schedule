import {
  IpcInvokeContract,
  type ScheduledTask,
  type ScheduledTaskRunNowReq,
  type ScheduledTaskRunNowResult,
} from '@tiny-schedule/shared';
import { type AiLogger } from '@/ai/logger';
import type { DataStore } from '@/bridge/dataStore';
import { createScheduledRuntime } from '@/scheduledTasks/runtime';
import { type InvokeFn } from '@/scheduledTasks/tools';

/**
 * 「立即运行」：UI 唯一的手动入口。
 *
 * 它不是"另一种触发"，而是同一条执行路径的第二个调用点——runner 收到
 * `trigger: 'manual'`，其余全部同构（CONTEXT.md）。所以这个 slice 只做一件事：
 * 找到定时任务，把它交给运行时。
 *
 * 重叠保护不在这里，而在 `scheduledTasks/runtime.ts` 的那份 in-flight 账本里，与
 * 调度触发共用同一把锁。手动连点与定时到点撞在一起时看到的是同一个账本——这才
 * 是 CONTEXT.md 那条规则按任务算、不分触发来源的形状；两处各守各的 `inFlight`
 * 时规则看着还在，实现已经不成立。
 *
 * 返回类型直接取契约里的 {@link ScheduledTaskRunNowResult} 而不是本地再写一份：
 * 两个形状一旦分叉，UI 拿到的类型就与它实际会收到的值对不上，而那正是这份契约
 * 存在的理由。
 */

export interface ScheduledTaskRunApiDeps {
  store: DataStore;
  /** 测试注入点：默认走 consoleLogger。 */
  logger?: AiLogger;
  /** 测试注入点：默认走 Tauri invoke。 */
  invoke?: InvokeFn;
}

/**
 * Named for the contract key, not for the action: the renderer types its API
 * against `RendererApi`, so a slice whose method were called `runNow` would be a
 * member nothing could call.
 */
export type ScheduledTaskRunApi = {
  /** 「立即运行」：手动触发一次，产物与定时触发完全同构。 */
  scheduledTaskRunNow(req: ScheduledTaskRunNowReq): Promise<ScheduledTaskRunNowResult>;
};

export function createScheduledTaskRunApi(deps: ScheduledTaskRunApiDeps): ScheduledTaskRunApi {
  const runtime = createScheduledRuntime({
    store: deps.store,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.invoke ? { invoke: deps.invoke } : {}),
  });

  const scheduledTaskRunNow = async (
    raw: ScheduledTaskRunNowReq,
  ): Promise<ScheduledTaskRunNowResult> => {
    // Parsed for the same reason `api/data.ts` parses per call: with the
    // ipcMain loop gone, the zod guard has to live at the call site.
    const { taskId } = IpcInvokeContract.scheduledTaskRunNow.req.parse(raw);
    const task: ScheduledTask | undefined = (await deps.store.get()).scheduledTasks[taskId];
    if (!task) return { ok: false, error: 'TASK_NOT_FOUND' };

    // A disabled task is still runnable by hand: 停用 means "no longer
    // triggers", and pressing the button is not a trigger — it is the user
    // asking. Scheduled triggers check `enabled`; this path deliberately does
    // not.
    const { ok, run, error } = await runtime.runGuarded(task, 'manual');
    // Three branches per the contract. A failed run still carries its record,
    // because that record is the evidence the user is about to ask for; a
    // skipped one is not a failure at all, so it lands in the ok branch.
    return ok ? { ok: true, run } : { ok: false, run, error: error ?? '执行失败' };
  };

  return { scheduledTaskRunNow };
}
