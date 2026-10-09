import { describe, expect, test } from 'bun:test';
import { emptyAppData, type StoreWritablePayload } from '@tiny-schedule/shared';
import { silentLogger } from '@/ai/logger';
import { DataStore } from '@/bridge/dataStore';
import { joinPath, MemoryFs } from '@/bridge/fsAdapter';
import { createStoreWritableBus, readStoreWritable } from './storeWritableBus';

const DIR = '/data';

function dataPath(): string {
  return joinPath(DIR, 'data.json');
}

/** A `data.json` the schema accepts, so the store loads writable. */
function healthyJson(): string {
  return JSON.stringify(emptyAppData());
}

/**
 * The rescue scenario's other half: a file that exists and is not JSON. Half a
 * document is what an interrupted write or a full disk leaves behind, and it
 * is the case where latching read-only is the whole point — the store must not
 * overwrite the only surviving copy of the user's data with `emptyAppData()`.
 */
const TRUNCATED = '{"version":1,"tasks":{"t1":{"titl';

/** The only supported construction: `open` is what creates the directory. */
async function openStore(fs: MemoryFs): Promise<DataStore> {
  return DataStore.open(DIR, fs, silentLogger);
}

describe('storeWritableBus', () => {
  test('fires immediately on subscribe, before returning the unsubscribe', async () => {
    const store = await openStore(new MemoryFs({ [dataPath()]: healthyJson() }));
    await store.get();
    const bus = createStoreWritableBus(store);
    const seen: StoreWritablePayload[] = [];

    // Synchronously, with no await in between: a subscriber that has to wait
    // a tick for its first answer renders one frame believing it can save.
    bus.subscribe((payload) => seen.push(payload));

    expect(seen).toHaveLength(1);
    bus.dispose();
  });

  test('a healthy store is reported writable with no reason', async () => {
    const store = await openStore(new MemoryFs({ [dataPath()]: healthyJson() }));
    await store.get();
    const bus = createStoreWritableBus(store);
    const seen: StoreWritablePayload[] = [];

    bus.subscribe((payload) => seen.push(payload));

    expect(seen[0]).toEqual({ writable: true, reason: null });
    expect(readStoreWritable(store)).toEqual({ writable: true, reason: null });
    expect(bus.current()).toEqual({ writable: true, reason: null });
    bus.dispose();
  });

  test('a truncated data.json is reported unwritable, with a reason', async () => {
    // No backup beside it, so the store falls all the way through to
    // emptyAppData() and latches: exactly the state that must not be written
    // back over the corrupt file.
    const store = await openStore(new MemoryFs({ [dataPath()]: TRUNCATED }));
    await store.get();
    const bus = createStoreWritableBus(store);
    const seen: StoreWritablePayload[] = [];

    bus.subscribe((payload) => seen.push(payload));

    expect(seen[0]?.writable).toBe(false);
    // The banner's whole argument is that "save failed, try again" asks the
    // user to retry something that cannot succeed until they repair the file
    // by hand — so a refusal with no reason would be a worse message than none.
    expect(seen[0]?.reason).toContain('invalid json');
    expect(readStoreWritable(store).writable).toBe(false);
    bus.dispose();
  });

  test('a store latched before the bus existed still reports on subscribe', async () => {
    // The startup ordering this file exists for: the store opens and latches
    // during the first load(), long before any renderer subscribes. Push
    // alone would never fire for a store that does not change again.
    const store = await openStore(new MemoryFs({ [dataPath()]: TRUNCATED }));
    await store.get();
    expect(store.isWritable).toBe(false);

    const bus = createStoreWritableBus(store);
    const seen: StoreWritablePayload[] = [];
    bus.subscribe((payload) => seen.push(payload));

    expect(seen[0]?.writable).toBe(false);
    bus.dispose();
  });

  test('repairing the file reaches an existing subscriber as writable', async () => {
    const fs = new MemoryFs({ [dataPath()]: TRUNCATED });
    const store = await openStore(fs);
    await store.get();
    const bus = createStoreWritableBus(store);
    const seen: StoreWritablePayload[] = [];
    bus.subscribe((payload) => seen.push(payload));

    // The user repairs data.json by hand; the next write's recovery probe
    // finds it and announces the mode change to whoever is still listening.
    await fs.writeText(dataPath(), healthyJson());
    await store.update((current) => current);

    expect(seen.map((p) => p.writable)).toEqual([false, true]);
    bus.dispose();
  });

  test('unsubscribes cleanly', async () => {
    const fs = new MemoryFs({ [dataPath()]: TRUNCATED });
    const store = await openStore(fs);
    await store.get();
    const bus = createStoreWritableBus(store);
    const seen: StoreWritablePayload[] = [];
    const off = bus.subscribe((payload) => seen.push(payload));
    expect(seen).toHaveLength(1);

    off();
    await fs.writeText(dataPath(), healthyJson());
    await store.update((current) => current);

    // A list that only grows would keep notifying a window that is gone — a
    // renderer reload re-runs the effect, so this is reachable in normal use.
    expect(seen).toHaveLength(1);
    bus.dispose();
  });

  test('one throwing subscriber does not stop the others', async () => {
    const fs = new MemoryFs({ [dataPath()]: TRUNCATED });
    const store = await openStore(fs);
    await store.get();
    const bus = createStoreWritableBus(store);
    const seen: string[] = [];
    const originalError = console.error;
    console.error = () => undefined;
    try {
      bus.subscribe(() => {
        throw new Error('renderer bug');
      });
      bus.subscribe((payload) => seen.push(String(payload.writable)));

      await fs.writeText(dataPath(), healthyJson());
      await store.update((current) => current);
    } finally {
      console.error = originalError;
      bus.dispose();
    }
    // The second subscriber was told the store recovered. A banner that stops
    // rendering because an unrelated component threw is a bug that hides the
    // one signal the user needs.
    expect(seen).toEqual(['false', 'true']);
  });

  test('dispose detaches from the store and refuses new subscribers', async () => {
    const fs = new MemoryFs({ [dataPath()]: TRUNCATED });
    const store = await openStore(fs);
    await store.get();
    const bus = createStoreWritableBus(store);
    bus.dispose();

    const seen: StoreWritablePayload[] = [];
    const off = bus.subscribe((payload) => seen.push(payload));
    await fs.writeText(dataPath(), healthyJson());
    await store.update((current) => current);

    // Nothing to fire, and nothing that looks like a live subscription.
    expect(seen).toEqual([]);
    expect(() => off()).not.toThrow();
    // Idempotent: the teardown path may run twice under StrictMode.
    expect(() => bus.dispose()).not.toThrow();
  });
});
