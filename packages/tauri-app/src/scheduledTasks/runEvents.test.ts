import { describe, expect, test } from 'bun:test';
import { emptyAppData } from '@tiny-schedule/shared';
import { silentLogger } from '@/ai/logger';
import { installTauriMocks } from '@/test/tauriMocks';
import { onRunsChanged } from './runEvents';
import { createScheduledTaskRunner } from './runner';

// The runner pulls in the Tauri modules through its tool layer.
installTauriMocks();

/**
 * 这个信号存在的全部理由：运行记录不进 AppData 的推送链路，所以界面只能靠"有人喊一
 * 声"去重查。这里测的就是那一声的时机——运行开始一次、结束一次——以及它不会把界面
 * 弄坏。
 */
describe('运行记录变化信号', () => {
  test('a run announces itself when it starts and again when it ends', async () => {
    let count = 0;
    const off = onRunsChanged(() => {
      count += 1;
    });

    await runOnce();
    off();

    // 两次：一条 running 落库、一次改写为终态。少一次界面就停在"运行中"，多一次只是
    // 白查一遍——所以这个数字是被钉住的。
    expect(count).toBe(2);
  });

  test('a skipped run announces itself once — it never had a running phase', async () => {
    let count = 0;
    const off = onRunsChanged(() => {
      count += 1;
    });

    const runner = createScheduledTaskRunner(deps());
    await runner.recordSkipped(TASK, 'scheduled');
    off();

    expect(count).toBe(1);
  });

  test('unsubscribing stops the announcements', async () => {
    let count = 0;
    const off = onRunsChanged(() => {
      count += 1;
    });
    off();
    await runOnce();
    expect(count).toBe(0);
  });

  test('a throwing listener does not stop the others', async () => {
    let reached = 0;
    const bad = onRunsChanged(() => {
      throw new Error('renderer bug');
    });
    const good = onRunsChanged(() => {
      reached += 1;
    });

    await runOnce();

    bad();
    good();
    // A renderer bug in one subscriber must not cost the others their refresh —
    // that failure mode reads as "the app silently stopped updating".
    expect(reached).toBe(2);
  });
});

/** 跑一次最简单的运行。 */
async function runOnce(): Promise<void> {
  const runner = createScheduledTaskRunner(deps());
  await runner.runScheduledTask(TASK, 'scheduled');
}

const PROVIDER = {
  id: 'p1',
  registryId: 'openai',
  apiKeyEncrypted: 'enc',
  model: 'gpt-4o-mini',
  isDefault: true,
};

const TASK = {
  id: 'st1',
  name: '每日汇总',
  prompt: '汇总',
  schedule: { kind: 'daily' as const, time: '09:00' },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

/**
 * 一个不碰宿主的 runner：与 `runner.test.ts` 用的是同一套装配方式（Agent 由
 * `buildAgent` 建，工具与 provider 全是替身）。这里要测的是信号时机，所以不重复测
 * 生命周期。
 */
function deps(): Parameters<typeof createScheduledTaskRunner>[0] {
  return {
    getData: () => emptyAppData(),
    getProviders: () => [PROVIDER],
    decryptKey: () => 'sk-test',
    saveRunStart: async (run) => run,
    saveRunEnd: async (run) => run,
    logger: silentLogger,
    notify: () => undefined,
    invoke: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    createAgent: ({ buildAgent }) => buildAgent({}, {} as never),
  };
}
