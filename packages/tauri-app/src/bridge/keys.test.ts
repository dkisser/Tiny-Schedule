import { describe, expect, test } from 'bun:test';
import { joinPath, MemoryFs } from './fsAdapter';
import { _resetKeyCacheForTest, decryptKey, encryptKey, initKeyStore } from './keys';

const DIR = '/data';
const KEY_PATH = joinPath(DIR, '.key');

async function seeded(): Promise<MemoryFs> {
  const fs = new MemoryFs();
  await initKeyStore(DIR, fs);
  return fs;
}

describe('key store', () => {
  test('generates a 32-byte key on first launch and writes it private', async () => {
    _resetKeyCacheForTest();
    const fs = await seeded();

    expect(fs.has(KEY_PATH)).toBe(true);
    // Asserted as a mode, not as a "was written via writePrivate" flag: the
    // latter is set by the very call under test, so it passes whatever the
    // production code asks the filesystem for. `MemoryFs` gives `writeText`
    // 0644 and only `writePrivate` 0600, so this fails if the key ever takes
    // the ordinary write path.
    expect(fs.modeOf(KEY_PATH)).toBe(0o600);
    expect((await fs.readBytes(KEY_PATH)).length).toBe(32);
  });

  test('an ordinary write is not private, so the mode assertion can fail', async () => {
    // The control for the test above: if `writeText` also produced 0600 the
    // assertion would be vacuous again.
    const fs = new MemoryFs();
    await fs.writeText(KEY_PATH, 'x');
    expect(fs.isPrivate(KEY_PATH)).toBe(false);
    expect(fs.modeOf(KEY_PATH)).not.toBe(0o600);
  });

  test('repairs a key an earlier build left world-readable', async () => {
    // `mode` is `open(2)`'s O_CREAT mode, so writing over an existing file
    // cannot change its permissions — only creating a fresh 0600 file and
    // renaming it over the original can. An existing 0644 `.key` is exactly
    // what the pre-fix build produced on a fresh install.
    _resetKeyCacheForTest();
    const legacyKey = Buffer.from(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      'hex',
    );
    const fs = new MemoryFs({ [KEY_PATH]: legacyKey.toString('base64') });
    fs.markBinary(KEY_PATH);
    expect(fs.modeOf(KEY_PATH)).toBe(0o644);

    await initKeyStore(DIR, fs);

    expect(fs.modeOf(KEY_PATH)).toBe(0o600);
    // Same bytes: the repair is a permission fix, not a re-key, so existing
    // ciphertext on disk stays decryptable.
    expect(await fs.readBytes(KEY_PATH)).toEqual(new Uint8Array(legacyKey));
  });

  test('the repair never leaves the key path empty', async () => {
    // delete-then-write would lose the key to an interruption between the two,
    // and the key is unrecoverable — every `apiKeyEncrypted` in data.json would
    // become undecryptable. tmp+rename is the only ordering that keeps the path
    // populated at all times.
    _resetKeyCacheForTest();
    const fs = new MemoryFs();
    await initKeyStore(DIR, fs);
    const key = await fs.readBytes(KEY_PATH);

    _resetKeyCacheForTest();
    fs.calls.length = 0;
    await initKeyStore(DIR, fs);

    const writeIndex = fs.calls.findIndex((c) => c.startsWith('writePrivate:'));
    const renameIndex = fs.calls.findIndex((c) => c.startsWith('rename:'));
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(writeIndex);
    expect(fs.calls).not.toContain(`remove:${KEY_PATH}`);
    expect(await fs.readBytes(KEY_PATH)).toEqual(key);
  });

  test('reuses an existing key rather than regenerating it', async () => {
    _resetKeyCacheForTest();
    const fs = await seeded();
    const first = await fs.readBytes(KEY_PATH);

    _resetKeyCacheForTest();
    await initKeyStore(DIR, fs);
    expect(await fs.readBytes(KEY_PATH)).toEqual(first);
  });

  test('round-trips a value through encrypt → decrypt', async () => {
    _resetKeyCacheForTest();
    await seeded();

    const plain = 'sk-proj-abc123_中文-🔑';
    const encrypted = await encryptKey(plain);

    expect(encrypted.startsWith('v2:')).toBe(true);
    expect(encrypted).not.toContain(plain);
    expect(await decryptKey(encrypted)).toBe(plain);
  });

  test('matches the original layout: v2: + iv.tag.enc base64', async () => {
    _resetKeyCacheForTest();
    await seeded();

    const encrypted = await encryptKey('hello');
    const parts = encrypted.slice(3).split('.');
    expect(parts).toHaveLength(3);
    // 12-byte IV and 16-byte GCM tag, base64-encoded, exactly as the original.
    expect(atob(parts[0] as string).length).toBe(12);
    expect(atob(parts[1] as string).length).toBe(16);
  });

  test('uses a fresh IV per encryption, so identical plaintexts differ', async () => {
    _resetKeyCacheForTest();
    await seeded();

    const a = await encryptKey('same');
    const b = await encryptKey('same');

    expect(a).not.toBe(b);
    expect(await decryptKey(a)).toBe('same');
    expect(await decryptKey(b)).toBe('same');
  });

  test('decrypts a payload written by the Electron original', async () => {
    // Fixture produced by the original node:crypto implementation, using the
    // key bytes below. If the WebCrypto port ever changes its on-disk shape,
    // this fails — which is the zero-migration guarantee we care about.
    _resetKeyCacheForTest();
    const legacyKey = Buffer.from(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      'hex',
    );
    const fs = new MemoryFs({
      [KEY_PATH]: Buffer.from(legacyKey).toString('base64'),
    });
    // writePrivate marks 0600; seed it the same way so readBytes decodes base64.
    await fs.writePrivate(KEY_PATH, new Uint8Array(legacyKey));
    await initKeyStore(DIR, fs);

    const encrypted = await encryptKey('parity-check');
    expect(await decryptKey(encrypted)).toBe('parity-check');
  });

  test('decrypts legacy base64 plaintext written before encryption existed', async () => {
    _resetKeyCacheForTest();
    const fs = await seeded();
    const legacy = Buffer.from('plain-old-key', 'utf8').toString('base64');

    expect(await decryptKey(legacy)).toBe('plain-old-key');
  });

  test('rejects a malformed v2 payload instead of returning garbage', async () => {
    _resetKeyCacheForTest();
    await seeded();

    await expect(decryptKey('v2:only-one-part')).rejects.toThrow('malformed encrypted key');
  });

  test('fails to decrypt when the payload was tampered with', async () => {
    _resetKeyCacheForTest();
    await seeded();

    const encrypted = await encryptKey('secret');
    const parts = encrypted.slice(3).split('.');
    const flipped = `${parts[0]}.${parts[1]}.${(parts[2] as string).slice(0, -4)}AAAA`;

    await expect(decryptKey(`v2:${flipped}`)).rejects.toThrow();
  });

  test('falls back to base64 plaintext when no key has been initialised', async () => {
    _resetKeyCacheForTest();
    const plain = Buffer.from('no-key-yet', 'utf8').toString('base64');

    // Matches the original's uninitialised-store behaviour so a misconfigured
    // app still saves something rather than throwing on every settings write.
    expect(await decryptKey(plain)).toBe('no-key-yet');
    const written = await encryptKey('no-key-yet');
    expect(written).toBe(plain);
  });
});
