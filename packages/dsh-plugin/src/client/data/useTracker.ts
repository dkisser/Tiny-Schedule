/**
 * The browser's view of the tracker state.
 *
 * One fetch per mount, one refetch after every action. The host owns the
 * projections; the browser only renders what it is given.
 */
import { useCallback, useEffect, useState } from 'react';
import type { TrackerSnapshot } from '../../service/snapshot.ts';
import { fetchState, sendAction } from './clientPort.ts';

export interface TrackerView {
  state: TrackerSnapshot | null;
  error: string | null;
  busy: boolean;
  /** Run an action and refresh the snapshot. */
  act: (action: Record<string, unknown>) => Promise<void>;
  refresh: () => Promise<void>;
}

export interface TrackerOptions {
  /** Re-read the snapshot on this interval, in milliseconds; omitted means no polling. */
  pollMs?: number;
}

export function useTracker(options: TrackerOptions = {}): TrackerView {
  const [state, setState] = useState<TrackerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchState());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pollMs = options.pollMs;
  useEffect(() => {
    if (pollMs === undefined) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, refresh]);

  const act = useCallback(
    async (action: Record<string, unknown>) => {
      setBusy(true);
      try {
        await sendAction(action);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { state, error, busy, act, refresh };
}
