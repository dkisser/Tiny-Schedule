import { describe, expect, test } from 'bun:test';
import type { BrowserWindow } from 'electron';
import type { Logger } from 'pino';
import { checkForUpdate, type FetchImpl, startupUpdateCheck } from '../src/main/updater';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

  test('truncates long release notes to 4000 chars', async () => {
    const body = 'x'.repeat(5000);
    const fetchImpl: FetchImpl = async () => jsonResponse({ tag_name: 'v0.2.0', body });
    const result = await checkForUpdate('0.1.1', { fetchImpl });
    expect(result.notes?.length).toBe(4000);
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
  function windowWithSend(send: (channel: string, payload: unknown) => void): BrowserWindow {
    return { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  }

  const logger = { info: () => {}, error: () => {}, warn: () => {} } as unknown as Logger;

  test('pushes uiUpdateAvailable when an update exists', async () => {
    const sent: { channel: string; payload: unknown }[] = [];
    const win = windowWithSend((channel, payload) => sent.push({ channel, payload }));
    const fetchImpl: FetchImpl = async () => jsonResponse({ tag_name: 'v9.9.9' });
    await startupUpdateCheck({
      getVersion: () => '0.1.1',
      getWindow: () => win,
      logger,
      fetchImpl,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe('ui:updateAvailable');
    expect((sent[0]?.payload as { hasUpdate: boolean }).hasUpdate).toBe(true);
  });

  test('silent when up to date', async () => {
    const sent: { channel: string }[] = [];
    const win = windowWithSend((channel) => sent.push({ channel }));
    const fetchImpl: FetchImpl = async () => jsonResponse({ tag_name: 'v0.1.1' });
    await startupUpdateCheck({
      getVersion: () => '0.1.1',
      getWindow: () => win,
      logger,
      fetchImpl,
    });
    expect(sent).toHaveLength(0);
  });

  test('logs and stays silent on failure', async () => {
    const info = { calls: 0 };
    const log = { info: () => info.calls++, error: () => {} } as unknown as Logger;
    const fetchImpl: FetchImpl = async () => {
      throw new Error('offline');
    };
    await startupUpdateCheck({
      getVersion: () => '0.1.1',
      getWindow: () => windowWithSend(() => {}),
      logger: log,
      fetchImpl,
    });
    expect(info.calls).toBe(1);
  });
});
