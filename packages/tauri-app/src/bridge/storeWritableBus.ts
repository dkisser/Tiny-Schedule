import type { StoreWritablePayload } from '@tiny-schedule/shared';
import type { DataStore } from '@/bridge/dataStore';

/**
 * The renderer's half of ADR-0004: a refused write is a *mode*, not an absent
 * result, so it travels on one channel instead of twenty.
 *
 * In Electron the main process pushed `Ipc.storeWritable` on a window it
 * owned. There is no second process in this port — the store lives in the
 * webview — so the same guarantee is rebuilt from two pieces:
 *
 *  1. **The push**, {@link createStoreWritableBus} below: a fan-out over
 *     `DataStore.onModeChanged`, for the transitions that happen while the
 *     app is open (the file is repaired, the corrupt file is deleted).
 *  2. **The pull**, {@link readStoreWritable}: what `Ipc.storeWritable`
 *     answers, for a renderer that mounts into a store that has been
 *     read-only since launch. That latch is set during the first `load()`,
 *     long before anything subscribes, and a store that never changes again
 *     produces no transition to push. Push alone would leave the banner
 *     absent for exactly the case it exists for.
 *
 * Both are wired into the renderer API by `src/api.ts`, which assembles this
 * bus the way it already assembles its timer-changed bus.
 */

/** Fan-out over the store's read-only mode. */
export interface StoreWritableBus {
  /**
   * Subscribe to mode changes. Fires the listener *immediately*, with the
   * state as it is right now, before returning the unsubscribe.
   *
   * The immediate fire is the whole point and is not a convenience: a
   * corrupt `data.json` latches the store read-only during startup, and a
   * listener that only reported later transitions would show nothing for a
   * store that has been unwritable since launch.
   */
  subscribe: (cb: (payload: StoreWritablePayload) => void) => () => void;
  /** The current mode, without subscribing. */
  current: () => StoreWritablePayload;
  /**
   * Detach from the store. Idempotent; the bus stops announcing and
   * `current()` keeps answering from the state it last saw.
   */
  dispose: () => void;
}

/**
 * The current mode, read straight off the store.
 *
 * The pull half of the pair described above. Named separately rather than
 * folded into the bus because it is the only thing the `storeWritable`
 * invoke needs: a handler that wants one answer must not leave a permanent
 * listener behind on the store to get it.
 */
export function readStoreWritable(store: DataStore): StoreWritablePayload {
  return { writable: store.isWritable, reason: store.unreadableReason };
}

/**
 * Build the mode bus for one store.
 *
 * Mirrors `createTimerChangedBus()` in `src/api.ts` — a `Set` of listeners,
 * snapshotted before iteration so a listener that unsubscribes (or
 * subscribes) mid-emit cannot corrupt the walk, and per-callback try/catch so
 * one throwing subscriber does not stop the others from being told the store
 * changed mode. That containment is not defensive decoration: a subscriber
 * here is a React render, and a render that throws is one component's bug,
 * not a reason to leave the user unaware that their writes are being dropped.
 *
 * Two differences from the timer bus, both forced by the store's own
 * signature: this bus attaches to its producer at construction (there is only
 * ever one producer, and it exists before any subscriber), and it caches the
 * latest payload so a *late* subscriber still gets the immediate fire the
 * store would have given it had it subscribed then.
 */
export function createStoreWritableBus(store: DataStore): StoreWritableBus {
  const listeners = new Set<(payload: StoreWritablePayload) => void>();
  // Seeded from the store before anything can change it, so `current()` is
  // honest even between construction and the first emission.
  let latest: StoreWritablePayload = readStoreWritable(store);

  const deliver = (cb: (payload: StoreWritablePayload) => void): void => {
    try {
      cb(latest);
    } catch (error) {
      console.error('store: onStoreWritable listener threw', error);
    }
  };

  const detachFromStore = store.onModeChanged((writable, reason) => {
    latest = { writable, reason };
    for (const cb of [...listeners]) deliver(cb);
  });

  let disposed = false;
  return {
    subscribe(cb) {
      // A bus that has been disposed answers nobody: adding to the listener
      // set would leave a component holding a subscription that can never
      // fire and never looks broken.
      if (disposed) return () => undefined;
      listeners.add(cb);
      // Fires immediately, and *before* the unsubscribe is handed back, so
      // the state a subscriber sees on its first render is the real one.
      deliver(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    current: () => latest,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      detachFromStore();
    },
  };
}
