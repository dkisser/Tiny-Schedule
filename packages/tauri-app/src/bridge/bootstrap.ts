import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import type { RendererApi } from '@tiny-schedule/shared';
import { createApi, installApi } from '@/api';
import { dataDirFor } from '@/bridge/dataDir';
import { DataStore } from '@/bridge/dataStore';
import { initKeyStore } from '@/bridge/keys';
import { migrateActiveTimerPomodoroFocus, migrateRemoveTodayTag } from '@/bridge/migrations';
import { startSystemEvents } from '@/bridge/systemEvents';
import { TauriFs } from '@/bridge/tauriFs';
import { startupUpdateCheck } from '@/bridge/updater';

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

  // Every slice closes over the store, so assembly happens here rather than at
  // module scope. `src/api.ts` owns the composition and the cross-slice wiring;
  // this file's remaining job is the ordering around it.
  const combined = createApi({ store });
  installApi(combined);

  // After installApi, because the bridge writes through api() — an auto-pause
  // that lands before the API is installed would have no data slice to write
  // through and would lose the timer state it just computed. Idempotent, so a
  // second call (a hot reload, a future re-bootstrap) cannot double the
  // listeners.
  startSystemEvents(store);

  // The startup update check, wired where the Electron original wired it
  // (`main.ts`: `did-finish-load` then a 5s timeout). Two details are inherited
  // deliberately: the delay keeps a network call off the startup path, and it
  // runs after `installApi`, so the `ui:updateAvailable` push has a subscriber
  // by the time it can fire. `App.tsx` owns that subscription.
  setTimeout(() => {
    void getVersion()
      .then((version) => startupUpdateCheck(version))
      .catch(() => {
        // A failed check is the same outcome as no update: the user still has
        // the manual "检查更新" action, so there is nothing to report.
      });
  }, STARTUP_UPDATE_CHECK_DELAY_MS);

  return combined;
}
