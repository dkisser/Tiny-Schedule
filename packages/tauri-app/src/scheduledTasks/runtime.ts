import { invoke } from '@tauri-apps/api/core';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { ScheduledTask, ScheduledTaskRun } from '@tiny-schedule/shared';
import { type AiLogger, consoleLogger } from '@/ai/logger';
import type { DataStore } from '@/bridge/dataStore';
import { decryptKey } from '@/bridge/keys';
import { createScheduledTaskService } from '@/bridge/scheduledTaskService';
import { createScheduledTaskRunner, type ScheduledRunnerDeps } from './runner';
import { type InvokeFn } from './tools';

/**
 * 定时任务运行时：runner 的组装 + 那份 in-flight 账本。
 *
 * 这一层存在的理由是一句话：CONTEXT.md 的重叠规则按**定时任务**算，不按触发
 * 来源算。手动「立即运行」和定时触发落在同一个 in-flight 集合里，于是两个并行
 * 的 Agent——各自握着全部工具——不会踩同一个目录。两处各守各的 `inFlight` 时，
 * 规则看着还在，实现已经不成立。
 *
 * 账本是**模块级**的，不是 `createScheduledRuntime` 的局部变量，因为生产代码里
 * 这个工厂被调用了两次：`startScheduler` 一次，`createScheduledTaskRunApi` 一次。
 * 账本若跟着实例走，两个实例就各有一把锁，而撞车恰好发生在它们之间——09:00 到点
 * 调度器开跑，09:00:30 用户按下「立即运行」。
 *
 * 为什么是进程级而不是按 store 分：这条规则要防的事发生在**文件系统**上——两个
 * Agent 在同一个执行目录里各自 writeFile、runCommand。那件事与谁持有哪个 store
 * 实例无关，所以锁的粒度就应该是"这个进程里这个任务 id 正不正在跑"。
 */

/**
 * 正在跑的定时任务，**所有**触发来源、所有 runtime 实例共用这一份。
 *
 * 进程级单例，理由见模块头。
 */
const inFlight = new Set<string>();

/** 测试用：清空账本，让下一个用例从干净状态开始。 */
export function _resetInFlightForTest(): void {
  inFlight.clear();
}

/**
 * 那本账本身，交给调度器用。
 *
 * 调度器派发前也要判一次重叠，而它判的那一次必须和 {@link runGuarded} 判的是同一
 * 次——两份账本可以同时答"在跑"和"没在跑"，于是 `scheduler.isRunning()` 在手动运行
 * 期间返回 false，恰好在这个人最想看"正在运行"的时刻撒谎。
 */
export function taskInFlight(): Set<string> {
  return inFlight;
}

/**
 * 通知权限，与 api/timer.ts 同一套：macOS 的授权提示是一次性的，缓存住免得一次
 * 突发触发弹一串。
 */
let permissionOnce: Promise<boolean> | null = null;

async function ensureNotificationPermission(): Promise<boolean> {
  permissionOnce ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === 'granted';
  })();
  return permissionOnce;
}

/**
 * 运行结束后的系统通知。
 *
 * 权限被拒时只警告不抛出：运行记录已经落库了，一条横幅发不出去不构成"这次运行
 * 没发生"——把两者混起来会让调用方以为该重跑一次。
 */
export async function notifyScheduledTask(payload: { title: string; body: string }): Promise<void> {
  if (!(await ensureNotificationPermission())) {
    console.warn('scheduledTask: 通知权限被拒，运行记录仍然已保存');
    return;
  }
  sendNotification(payload);
}

export interface ScheduledRuntimeDeps {
  store: DataStore;
  logger?: AiLogger;
  /** 测试注入点：默认走 Tauri invoke。 */
  invoke?: InvokeFn;
  /** 其余 runner 选项，测试可覆盖超时与 Agent 注入点。 */
  runner?: Partial<
    Omit<
      ScheduledRunnerDeps,
      'getData' | 'getProviders' | 'decryptKey' | 'saveRunStart' | 'saveRunEnd'
    >
  >;
}

/** Tauri 的 invoke 签名比这里需要的宽；收窄一次，换来注入点只有一个。 */
function defaultInvoke(): InvokeFn {
  return invoke as unknown as InvokeFn;
}

/** 一次受保护运行的结局。`ok` 说的是运行本身成不成功，与是否被跳过分开。 */
export interface GuardedRun {
  skipped: boolean;
  ok: boolean;
  run: ScheduledTaskRun;
  error?: string;
}

export function createScheduledRuntime(deps: ScheduledRuntimeDeps) {
  const logger = deps.logger ?? consoleLogger;
  const service = createScheduledTaskService({ store: deps.store, logger });
  const runner = createScheduledTaskRunner({
    getData: () => deps.store.get(),
    getProviders: async () => (await deps.store.get()).settings.aiProviders,
    decryptKey,
    // 两个写通道对应运行的两个时刻：开始落一条 running，结束时改写为终态。
    // 只有 running 允许被改写，所以审计仍然只朝一个方向走（见 service）。
    saveRunStart: (run) => service.appendRun(run),
    saveRunEnd: (run) => service.finalizeRun(run),
    logger,
    notify: notifyScheduledTask,
    invoke: deps.invoke ?? defaultInvoke(),
    ...deps.runner,
  });

  /**
   * 跑一次，带重叠保护。
   *
   * 只有一种含义：同一个定时任务此刻已经在跑，那么这次新触发就被跳过，并如实记
   * 一条 skipped——开始即结束、output 为空（CONTEXT.md）。被跳过不是失败，所以
   * 它返回 `ok: true`，调用方不必把它当异常处理。
   *
   * 两个入口（手动、调度）都走这里，且共用模块级账本，这是规则唯一成立的地方。
   */
  const runGuarded = async (
    task: ScheduledTask,
    trigger: 'scheduled' | 'manual',
  ): Promise<GuardedRun> => {
    if (inFlight.has(task.id)) {
      const { run } = await runner.recordSkipped(task, trigger);
      return { skipped: true, ok: true, run };
    }
    inFlight.add(task.id);
    try {
      const { run, ok, error } = await runner.runScheduledTask(task, trigger);
      return { skipped: false, ok, run, ...(error !== undefined ? { error } : {}) };
    } finally {
      inFlight.delete(task.id);
    }
  };

  return {
    runner,
    service,
    runGuarded,
    isRunning: (taskId: string): boolean => inFlight.has(taskId),
  };
}

export type ScheduledRuntime = ReturnType<typeof createScheduledRuntime>;
