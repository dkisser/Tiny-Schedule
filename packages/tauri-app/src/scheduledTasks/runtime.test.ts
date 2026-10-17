import { describe, expect, test } from 'bun:test';
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import { type AppData, emptyAppData, type ScheduledTask } from '@tiny-schedule/shared';
import { silentLogger } from '@/ai/logger';
import { DataStore } from '@/bridge/dataStore';
import { MemoryFs } from '@/bridge/fsAdapter';
import { createScheduledTaskService } from '@/bridge/scheduledTaskService';
import { installTauriMocks } from '@/test/tauriMocks';
import { createScheduledRuntime } from './runtime';

/**
 * 这个文件只测一件事：**一把锁**。
 *
 * CONTEXT.md 的重叠规则按定时任务算、不按触发来源算，所以手动「立即运行」与定时
 * 触发必须看见同一份 in-flight。两处各守各的集合时规则看着还在，实现已经不成立
 * ——而失效的样子是两个并行 Agent 各自握着全部工具。
 */
installTauriMocks();

const TASK: ScheduledTask = {
  id: 'st1',
  name: '每日汇总',
  prompt: '汇总今天的提交',
  schedule: { kind: 'daily', time: '09:00' },
  workingDirectory: '/repo',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const PROVIDER = {
  id: 'p1',
  registryId: 'openai',
  apiKeyEncrypted: '',
  model: 'gpt-4o-mini',
  isDefault: true,
};

/** An agent whose prompt never resolves, so the run stays in flight. */
const HANGING_AGENT = {
  state: { messages: [] as AgentMessage[], isStreaming: false, errorMessage: undefined },
  subscribe: () => () => undefined,
  prompt: () => new Promise<void>(() => undefined),
  abort: () => undefined,
} as unknown as Agent;

/** An agent that ends immediately with a successful assistant message. */
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

async function openRuntime(agent: Agent) {
  const base = emptyAppData();
  const seed: AppData = {
    ...base,
    scheduledTasks: { st1: TASK },
    settings: { ...base.settings, aiProviders: [PROVIDER] },
  } as AppData;
  const fs = new MemoryFs();
  const store = await DataStore.open('/data', fs);
  await store.save(seed);
  await store.load();
  const runtime = createScheduledRuntime({
    store,
    logger: silentLogger,
    invoke: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runner: { createAgent: () => agent, timeouts: { firstTokenMs: 60_000, idleMs: 60_000 } },
  });
  return { store, runtime };
}

describe('运行时 — 手动与调度共用一把 in-flight 锁', () => {
  test('手动运行在跑时，定时触发被跳过', async () => {
    const { store, runtime } = await openRuntime(HANGING_AGENT);

    // Fire and forget: the manual run is now in flight and will stay there.
    const manual = runtime.runGuarded(TASK, 'manual');
    // Give the ledger a turn to record it, as the real call site would.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.isRunning('st1')).toBe(true);

    const scheduled = await runtime.runGuarded(TASK, 'scheduled');

    expect(scheduled.skipped).toBe(true);
    expect(scheduled.run.status).toBe('skipped');
    expect(scheduled.run.trigger).toBe('scheduled');
    expect(scheduled.run.output).toBe('');
    expect(scheduled.run.toolCalls).toEqual([]);
    // 开始即结束。
    expect(scheduled.run.finishedAt).toBe(scheduled.run.startedAt);
    // 跳过的记录照常落库。
    expect(Object.keys((await store.get()).runs)).toContain(scheduled.run.id);

    void manual;
  });

  test('定时触发在跑时，手动运行同样被跳过', async () => {
    const { runtime } = await openRuntime(HANGING_AGENT);

    const scheduled = runtime.runGuarded(TASK, 'scheduled');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const manual = await runtime.runGuarded(TASK, 'manual');

    expect(manual.skipped).toBe(true);
    expect(manual.run.trigger).toBe('manual');
    expect(manual.run.status).toBe('skipped');

    void scheduled;
  });

  test('跑完之后锁释放，两个入口都恢复正常', async () => {
    const { runtime } = await openRuntime(FINISHED_AGENT);

    const first = await runtime.runGuarded(TASK, 'manual');
    expect(first.skipped).toBe(false);
    expect(first.ok).toBe(true);
    expect(first.run.status).toBe('success');
    expect(runtime.isRunning('st1')).toBe(false);

    const second = await runtime.runGuarded(TASK, 'scheduled');
    expect(second.skipped).toBe(false);
    expect(second.run.trigger).toBe('scheduled');
  });

  test('不同定时任务各有一把锁', async () => {
    const { runtime } = await openRuntime(HANGING_AGENT);
    const other = { ...TASK, id: 'st2', name: '另一个' };

    void runtime.runGuarded(TASK, 'manual');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.isRunning('st1')).toBe(true);
    expect(runtime.isRunning('st2')).toBe(false);
  });
});

describe('运行记录 — 从开始就落库，结束时改写为终态', () => {
  test('运行中历史里就有那条 running，结束时同一条变成终态', async () => {
    // 这一段是界面「运行中」标记的全部依据：运行记录在跑的时候就在库里，而不是等到
    // 结束才一次性写出来——否则无人值守的运行在整个执行期间对界面是不存在的。
    const { store, runtime } = await openRuntime(HANGING_AGENT);

    const manual = runtime.runGuarded(TASK, 'manual');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const during = Object.values((await store.get()).runs);
    expect(during).toHaveLength(1);
    expect(during[0]?.status).toBe('running');
    expect(during[0]?.finishedAt).toBeUndefined();
    expect(during[0]?.toolCalls).toEqual([]);

    void manual;
  });

  test('进程死在运行途中时，那条 running 被启动对账记成 interrupted', async () => {
    // 完整的"消失的运行"链路：跑一半死掉 → 库里留下 running → 下次启动把它记成
    // 已中断。审计（ADR-0008）因此不会连同进程一起消失。
    const { store, runtime } = await openRuntime(HANGING_AGENT);

    const manual = runtime.runGuarded(TASK, 'manual');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const data = await createScheduledTaskService({
      store,
      logger: silentLogger,
    }).reconcileInterruptedRuns(4_242);

    const stranded = Object.values(data.runs);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]?.status).toBe('interrupted');
    expect(stranded[0]?.finishedAt).toBe(4_242);
    expect(stranded[0]?.error).toContain('进程在运行中结束');

    void manual;
  });

  test('一次跑完的运行从 running 走到终态，历史里仍然只有一条', async () => {
    const { store, runtime } = await openRuntime(FINISHED_AGENT);

    const result = await runtime.runGuarded(TASK, 'manual');

    const runs = Object.values((await store.get()).runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(result.run.id);
    expect(runs[0]?.status).toBe('success');
    expect(runs[0]?.output).toBe('done');
    expect(runs[0]?.finishedAt).toBeGreaterThanOrEqual(runs[0]?.startedAt ?? 0);
  });
});
