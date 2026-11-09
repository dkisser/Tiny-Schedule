/**
 * The browser's data port.
 *
 * One snapshot endpoint and one action endpoint. The browser never computes a
 * projection: the host does, so the view and the agent always agree.
 */
import type { TrackerSnapshot } from '../../service/snapshot.ts';

const BASE = '/ts/api';

/** Read the whole tracker state. */
export async function fetchState(signal?: AbortSignal): Promise<TrackerSnapshot> {
  const response = await fetch(`${BASE}/state`, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`state request failed: ${response.status}`);
  return (await response.json()) as TrackerSnapshot;
}

/** Send one action to the host. */
export async function sendAction(action: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${BASE}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail === '' ? `action failed: ${response.status}` : detail);
  }
}
