import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { decryptKey, encryptKey, initKeyStore, _resetKeyCacheForTest } = await import(
  '../src/main/keys'
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'keys-test-'));
  _resetKeyCacheForTest();
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const keyPath = () => join(tmpDir, '.key');

describe('encryptKey / decryptKey', () => {
  test('round-trips arbitrary unicode', async () => {
    await initKeyStore(tmpDir);
    const plaintext = 'sk-密钥-🔑-with spaces';
    const enc = encryptKey(plaintext);
    expect(enc.startsWith('v2:')).toBe(true);
    expect(decryptKey(enc)).toBe(plaintext);
  });

  test('uses a fresh IV every call so equal plaintexts differ on disk', async () => {
    await initKeyStore(tmpDir);
    const a = encryptKey('same');
    const b = encryptKey('same');
    expect(a).not.toBe(b);
    expect(decryptKey(a)).toBe('same');
    expect(decryptKey(b)).toBe('same');
  });

  test('legacy base64 entries without v2: prefix decode as plaintext', async () => {
    await initKeyStore(tmpDir);
    const legacy = Buffer.from('legacy-key-value', 'utf8').toString('base64');
    expect(decryptKey(legacy)).toBe('legacy-key-value');
  });

  test('decoding a v2 blob with a tampered tag throws', async () => {
    await initKeyStore(tmpDir);
    const enc = encryptKey('secret');
    const parts = enc.split('.');
    // parts: ['v2:<iv>', '<tag>', '<payload>']
    const tag = parts[1] as string;
    const flipped = tag.charAt(0) === 'A' ? `B${tag.slice(1)}` : `A${tag.slice(1)}`;
    parts[1] = flipped;
    expect(() => decryptKey(parts.join('.'))).toThrow();
  });

  test('decoding a v2 blob with a tampered payload throws', async () => {
    await initKeyStore(tmpDir);
    const enc = encryptKey('secret');
    const parts = enc.split('.');
    const payload = parts[2] as string;
    const flipped = payload.charAt(0) === 'A' ? `B${payload.slice(1)}` : `A${payload.slice(1)}`;
    parts[2] = flipped;
    expect(() => decryptKey(parts.join('.'))).toThrow();
  });

  test('malformed v2 payload (wrong number of segments) throws', async () => {
    await initKeyStore(tmpDir);
    expect(() => decryptKey('v2:abc.def')).toThrow(/malformed/);
  });
});

describe('initKeyStore', () => {
  test('first call writes a 32-byte key with 0600 perms', async () => {
    await initKeyStore(tmpDir);
    const buf = readFileSync(keyPath());
    expect(buf.length).toBe(32);
    if (process.platform !== 'win32') {
      expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
    }
  });

  test('second call (after cache reset) reuses the existing file bytes', async () => {
    await initKeyStore(tmpDir);
    const before = readFileSync(keyPath());

    _resetKeyCacheForTest();
    await initKeyStore(tmpDir);
    const after = readFileSync(keyPath());
    expect(after.equals(before)).toBe(true);
  });

  test('regenerates when the on-disk file is the wrong size', async () => {
    writeFileSync(keyPath(), Buffer.alloc(8, 1), { mode: 0o600 });
    await initKeyStore(tmpDir);
    expect(readFileSync(keyPath()).length).toBe(32);
  });
});
