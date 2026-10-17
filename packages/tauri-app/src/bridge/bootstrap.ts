import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import type { RendererApi } from '@tiny-schedule/shared';
import { consoleLogger } from '@/ai/logger';
import { createApi, installApi } from '@/api';
import { dataDirFor } from '@/bridge/dataDir';
import { DataStore } from '@/bridge/dataStore';
import { initKeyStore } from '@/bridge/keys';
import {
  migrateActiveTimerPomodoroFocus,
  migrateImportanceTagsToField,
  migrateRemoveTodayTag,
} from '@/bridge/migrations';
import { reconcileScheduledTaskRuns } from '@/bridge/scheduledTaskService';
import { startSystemEvents } from '@/bridge/systemEvents';
import { TauriFs } from '@/bridge/tauriFs';
import { startupUpdateCheck } from '@/bridge/updater';
import { onRunsChanged } from '@/scheduledTasks/runEvents';
import { startScheduler } from '@/scheduledTasks/scheduler';
import { useUiStore } from '@/stores/ui';
import { useUpdateStore } from '@/stores/update';

/**
 * How long after startup the automatic update check runs. Inherited from the
 * Electron original's `setTimeout(..., 5000)`: long enough that cold-start
 * network traffic never competes with the first render, and short enough that
 * a user who leaves the app open still hears about a new release.
 */
const STARTUP_UPDATE_CHECK_DELAY_MS = 5_000;

/**
 * Startup sequence, mirroring packages/app/src/main/main.ts:140-155.
 *
 * Order matters and is inherited from the original: the key store has to be
 * ready before any settings write, the store has to be open before migrations
 * can run, and migrations have to run before the first `dataLoad` so the
 * renderer never observes a pre-migration shape.
 */
let resolvedDir: string | null = null;

/** The data directory this session opened, for tooling and probes. */
export function dataDir(): string {
  if (!resolvedDir) throw new Error('bootstrap() has not run yet');
  return resolvedDir;
}

export async function bootstrap(): Promise<RendererApi> {
  const home = await invoke<string>('home_dir');
  const dir = dataDirFor({ dev: import.meta.env.DEV, home });
  resolvedDir = dir;
  const fs = new TauriFs();

  // The key store writes `<dir>/.key` before anything else, so the directory
  // has to exist first. `DataStore.open` is what creates it, so the store is
  // opened first here — reversing the Electron order, where the key store
  // created the directory itself.
  //
  // Known wart, carried over from wave 3a and left in place deliberately: the
  // Electron original initialised the key store *before* opening the data
  // store, and this inverts that because only `DataStore.open` creates the
  // directory. It is safe only because nothing between the two lines reads or
  // writes a key — the first settings write happens after both. If a
  // migration is ever added above `initKeyStore`, it has to move below it.
  const store = await DataStore.open(dir, fs);
  await initKeyStore(dir, fs);

  // Same guard as the original: each migration returns the identical reference
  // when it has nothing to do, so a no-op migration does not rewrite the file.
  const migrated = migrateRemoveTodayTag(await store.get());
  if (migrated !== (await store.get())) await store.save(migrated);
  const migrated2 = migrateActiveTimerPomodoroFocus(await store.get());
  if (migrated2 !== (await store.get())) await store.save(migrated2);
  const migrated3 = migrateImportanceTagsToField(await store.get());
  if (migrated3 !== (await store.get())) await store.save(migrated3);

  // 启动对账，在调度器起跑之前：上次进程是在某次运行途中死的，磁盘上留着一条
  // running 记录。留着它，界面会永远显示一个"运行中"的标记，而那个进程早已不在。
  // 仿 timer 的 isOfflineResume——跨进程活不下去的东西回到界面上时先被改成它真实的
  // 样子（计时是 paused，运行是 interrupted）。幂等，没有残留时一次盘都不写。
  await reconcileScheduledTaskRuns(store, consoleLogger);

  // Every slice closes over the store, so assembly happens here rather than at
  // module scope. `src/api.ts` owns the composition and the cross-slice wiring;
  // this file's remaining job is the ordering around it.
  const combined = createApi({ store });
  installApi(combined);

  // 运行记录变了就把运行历史推一下重查。运行记录不进 AppData 的推送链路，所以没有
  // 别的信号能驱动详情面板与列表页刷新（`stores/ui.ts` 的 runsRevision 说明了这件事）。
  // 接在这里而不是每个运行入口，是因为订阅要覆盖**两种**触发：定时触发与「立即运行」
  // 各自组装了一份 runtime，漏掉一个就是无人值守时界面永远停在"运行中"。
  onRunsChanged(() => useUiStore.getState().bumpRunsRevision());

  // After installApi, because the bridge writes through api() — an auto-pause
  // that lands before the API is installed would have no data slice to write
  // through and would lose the timer state it just computed. Idempotent, so a
  // second call (a hot reload, a future re-bootstrap) cannot double the
  // listeners.
  startSystemEvents(store);

  // The scheduler runs in the renderer, like every other decision that used to
  // live in Electron's main process (ADR-0003): the schedule table, the data
  // store and the runner are all here. It does not survive a restart by design —
  // the table is rebuilt from each task's schedule, so nothing has to be
  // reconciled against a stale "last fired" marker on disk (CONTEXT.md: 进程未运行
  // 期间错过的触发不补跑). Started after `installApi` because its runner reaches
  // the store through the same assembled services.
  void startScheduler(store);

  // The version read is local (the string baked into the bundle), so it runs
  // immediately — the settings page shows it without waiting for any network
  // check. The startup update check keeps the Electron original's wiring
  // (`main.ts`: `did-finish-load` then a 5s timeout): the delay keeps a
  // network call off the startup path, and it runs after `installApi`, so the
  // `ui:updateAvailable` push has a subscriber by the time it can fire.
  // `App.tsx` owns that subscription.
  void getVersion()
    .then((version) => {
      useUpdateStore.getState().setCurrentVersion(version);
      setTimeout(() => void startupUpdateCheck(version), STARTUP_UPDATE_CHECK_DELAY_MS);
    })
    .catch(() => {
      // A failed check is the same outcome as no update: the user still has
      // the manual "检查更新" action, so there is nothing to report.
    });

  return combined;
}
