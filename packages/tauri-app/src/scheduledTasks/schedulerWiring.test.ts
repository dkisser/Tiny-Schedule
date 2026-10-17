import { afterEach, describe, expect, test } from 'bun:test';
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import { type AppData, emptyAppData, type ScheduledTask } from '@tiny-schedule/shared';
import { silentLogger } from '@/ai/logger';
import { DataStore } from '@/bridge/dataStore';
import { MemoryFs } from '@/bridge/fsAdapter';
import { installTauriMocks } from '@/test/tauriMocks';
import { _resetInFlightForTest } from './runtime';
import { _resetSchedulerForTest, startScheduler } from './scheduler';

/**
 * 这个文件只测一件事：**接线**。
 *
 * `scheduler.test.ts` 用的是注入的 `run` 桩和自己的账本——它测的是调度算法，
 * 而算法是对的。真正坏掉的是 `startScheduler` 把真实 runtime 接上去的那几行：
 *
 *   - `run` 接成 `runGuarded`，而 `dispatch` 已经先把 task.id 记进了同一本账本，
 *     于是每一次定时触发都走进跳过分支，Agent 从未被创建；
 *   - 调度表只在启动时建一次，新建的 / 删掉的任务永远不进表。
 *
 * 这两类缺陷在单元测试里**结构性地不可见**：它们只存在于两个真实组件的接缝上。
 * 所以这里不注入任何桩——真的 store、真的调度器、真的 runtime，跑一次触发。
 */
installTauriMocks({
  notification: {
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
    sendNotification: async () => undefined,
  },
});

const PROVIDER = {
  id: 'p1',
  registryId: 'openai',
  apiKeyEncrypted: '',
  model: 'gpt-4o-mini',
  isDefault: true,
};

function task(id: string, time: string): ScheduledTask {
  return {
    id,
    name: `任务 ${id}`,
    prompt: '汇总今天的提交',
    schedule: { kind: 'daily', time },
    workingDirectory: '/repo',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** An agent that answers immediately, so a triggered run is observable. */
const FINISHED_AGENT = {
  state: {
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
    ] as unknown as AgentMessage[],
    isStreaming: false,
    errorMessage: undefined,
  },
  subscribe: () => () => undefined,
  prompt: async () => undefined,
  abort: () => undefined,
} as unknown as Agent;

async function openStore(tasks: ScheduledTask[]): Promise<DataStore> {
  const fs = new MemoryFs();
  const store = await DataStore.open('/data', fs);
  const base = emptyAppData();
  await store.save({
    ...base,
    scheduledTasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    settings: { ...base.settings, aiProviders: [PROVIDER] },
  } as AppData);
  await store.load();
  return store;
}

afterEach(() => {
  _resetSchedulerForTest();
  _resetInFlightForTest();
});

describe('startScheduler 的真实接线', () => {
  test('到点的任务真的会跑，而不是被记成已跳过', async () => {
    // 这条断言在接线正确之前是失败的：run 接成 runGuarded，dispatch 已经把
    // task.id 记进账本，runGuarded 第一行就查这本账，于是每次触发都记一条
    // skipped。界面看起来"配置好了、启用中"，Agent 从未被创建。
    const store = await openStore([task('st1', '00:01')]);
    const scheduler = await startScheduler(store, silentLogger, {
      invoke: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runner: {
        createAgent: () => FINISHED_AGENT,
        timeouts: { firstTokenMs: 60_000, idleMs: 60_000 },
      },
    });

    // 让它立刻到期：把下一次算到过去，tick 就会派发。
    await store.update((d) => ({
      ...d,
      scheduledTasks: {
        st1: { ...d.scheduledTasks.st1!, schedule: { kind: 'daily', time: '00:01' } },
      },
    }));

    // 直接驱动一次 tick：不等真实时钟。
    const entries = scheduler.peek();
    expect(entries).toHaveLength(1);
    for (const entry of entries) {
      entry.nextAt = 0;
    }
    await scheduler.tick();
    await scheduler.settled();

    const runs = Object.values((await store.get()).runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('success');
    expect(runs[0]?.output).toBe('done');
    // `skipped` is the symptom: the wiring bug made every trigger record a skip.
    expect(runs[0]?.status).not.toBe('skipped');
  });

  test('运行期新建的任务会进调度表', async () => {
    // 没有数据订阅时，表只在启动时建一次：新建的任务排在表外，永不触发，
    // 而界面照常显示「下次触发 明天 09:00」。
    const store = await openStore([]);
    const scheduler = await startScheduler(store, silentLogger);
    expect(scheduler.peek()).toHaveLength(0);

    await store.update((d) => ({
      ...d,
      scheduledTasks: { st1: task('st1', '09:00') },
    }));
    // 订阅回调是异步 refresh，给它一轮。
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(scheduler.peek()).toHaveLength(1);
    expect(scheduler.peek()[0]?.task.id).toBe('st1');
  });

  test('删掉的任务会离开调度表', async () => {
    // 反方向同样坏：留在表里的条目继续触发，而运行记录又会被 appendRun 拒收
    // （它拒绝为已不存在的任务补记录），于是白烧一次调度并留下一条错误日志。
    const store = await openStore([task('st1', '09:00')]);
    const scheduler = await startScheduler(store, silentLogger);
    expect(scheduler.peek()).toHaveLength(1);

    await store.update((d) => ({ ...d, scheduledTasks: {} }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(scheduler.peek()).toHaveLength(0);
  });

  test('改时刻之后调度表跟着改', async () => {
    const store = await openStore([task('st1', '09:00')]);
    const scheduler = await startScheduler(store, silentLogger);
    const before = scheduler.peek()[0]?.nextAt ?? 0;

    await store.update((d) => ({
      ...d,
      scheduledTasks: {
        st1: { ...d.scheduledTasks.st1!, schedule: { kind: 'daily', time: '21:30' } },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(scheduler.peek()[0]?.task.schedule).toEqual({ kind: 'daily', time: '21:30' });
    expect(scheduler.peek()[0]?.nextAt).not.toBe(before);
  });
});
