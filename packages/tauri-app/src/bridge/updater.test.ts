import { describe, expect, test } from 'bun:test';
import type { CheckUpdateResult } from '@tiny-schedule/shared';
import {
  checkForUpdate,
  type FetchImpl,
  startupUpdateCheck,
  subscribeUpdateAvailable,
} from './updater';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function releaseResponse(tag: string | undefined, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ tag_name: tag, ...extra });
}

describe('checkForUpdate', () => {
  test('reports update when latest tag is newer', async () => {
    const fetchImpl: FetchImpl = async () =>
      jsonResponse({ tag_name: 'v0.2.0', html_url: 'https://example.com/r', body: 'notes' });
    const result = await checkForUpdate('0.1.1', { fetchImpl });
    expect(result.hasUpdate).toBe(true);
    expect(result.latest).toBe('0.2.0'); // v prefix stripped
    expect(result.url).toBe('https://example.com/r');
    expect(result.notes).toBe('notes');
    expect(result.error).toBeUndefined();
  });

  test('numeric segment comparison: 0.1.10 beats 0.1.9', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ tag_name: 'v0.1.10' });
    const result = await checkForUpdate('0.1.9', { fetchImpl });
    expect(result.hasUpdate).toBe(true);
  });

  test('no update when current is equal or newer', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ tag_name: 'v0.1.1' });
    expect((await checkForUpdate('0.1.1', { fetchImpl })).hasUpdate).toBe(false);
    expect((await checkForUpdate('0.2.0', { fetchImpl })).hasUpdate).toBe(false);
  });

  /**
   * The version matrix as a table, because the two rules that make it pass are
   * easy to break independently: a string comparison gets 0.1.10 < 0.1.9 wrong,
   * and dropping the segment-length branch flips 1.0 vs 1.0.1.
   */
  const matrix: { current: string; tag: string; hasUpdate: boolean }[] = [
    { current: '0.1.9', tag: 'v0.1.10', hasUpdate: true },
    { current: '0.1.10', tag: 'v0.1.9', hasUpdate: false },
    { current: '0.1.10', tag: 'v0.1.10', hasUpdate: false },
    { current: '0.1.0', tag: 'v0.2.0', hasUpdate: true },
    { current: '0.2.0', tag: 'v0.1.99', hasUpdate: false },
    { current: '1.0', tag: 'v1.0.1', hasUpdate: true },
    { current: '1.0.1', tag: 'v1.0', hasUpdate: false },
    { current: '0.1.1', tag: '0.2.0', hasUpdate: true }, // tag without v prefix
    { current: '0.1.1', tag: 'V0.2.0', hasUpdate: true }, // uppercase v
    { current: '10.0.0', tag: 'v9.9.9', hasUpdate: false },
  ];
  for (const { current, tag, hasUpdate } of matrix) {
    test(`current ${current} vs tag ${tag} -> hasUpdate=${hasUpdate}`, async () => {
      const fetchImpl: FetchImpl = async () => releaseResponse(tag);
      const result = await checkForUpdate(current, { fetchImpl });
      expect(result.hasUpdate).toBe(hasUpdate);
      expect(result.error).toBeUndefined();
    });
  }

  test('truncates long release notes to 4000 chars', async () => {
    const body = 'x'.repeat(5000);
    const fetchImpl: FetchImpl = async () => jsonResponse({ tag_name: 'v0.2.0', body });
    const result = await checkForUpdate('0.1.1', { fetchImpl });
    expect(result.notes?.length).toBe(4000);
  });

  test('empty release body becomes null notes, not an empty string', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ tag_name: 'v0.2.0', body: '' });
    expect((await checkForUpdate('0.1.1', { fetchImpl })).notes).toBeNull();
  });

  test('fetch rejection becomes error result, never throws', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await checkForUpdate('0.1.1', { fetchImpl });
    expect(result.hasUpdate).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
    expect(result.latest).toBeNull();
  });

  test('non-ok HTTP status becomes error result', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ message: 'rate limited' }, 403);
    const result = await checkForUpdate('0.1.1', { fetchImpl });
    expect(result.hasUpdate).toBe(false);
    expect(result.error).toBe('HTTP 403');
  });

  test('release without tag becomes error result', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ body: 'draft' });
    const result = await checkForUpdate('0.1.1', { fetchImpl });
    expect(result.hasUpdate).toBe(false);
    expect(result.error).toBe('NO_TAG');
  });

  test('current version is present even on failure', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('offline');
    };
    const result = await checkForUpdate('0.1.1', { fetchImpl });
    expect(result.current).toBe('0.1.1');
  });
});

describe('startupUpdateCheck', () => {
  test('pushes only when an update exists', async () => {
    const seen: CheckUpdateResult[] = [];
    const off = subscribeUpdateAvailable((r) => seen.push(r));
    try {
      await startupUpdateCheck('0.1.1', { fetchImpl: async () => releaseResponse('v0.2.0') });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.latest).toBe('0.2.0');
    } finally {
      off();
    }
  });

  test('stays silent when up to date or when the check failed', async () => {
    const seen: CheckUpdateResult[] = [];
    const off = subscribeUpdateAvailable((r) => seen.push(r));
    try {
      await startupUpdateCheck('0.1.1', { fetchImpl: async () => releaseResponse('v0.1.1') });
      await startupUpdateCheck('0.1.1', {
        fetchImpl: async () => {
          throw new Error('offline');
        },
      });
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });

  test('unsubscribing stops delivery', async () => {
    const seen: CheckUpdateResult[] = [];
    const off = subscribeUpdateAvailable((r) => seen.push(r));
    off();
    await startupUpdateCheck('0.1.1', { fetchImpl: async () => releaseResponse('v0.2.0') });
    expect(seen).toHaveLength(0);
  });
});
