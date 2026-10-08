import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const KEY_FILENAME = '.key';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** Marker for entries written by this version. Anything without this prefix
 *  is treated as a legacy base64 plaintext and decoded as such. */
const FORMAT_PREFIX = 'v2:';

let cachedKey: Buffer | null = null;

/**
 * Load (or generate on first launch) the AES-256-GCM key that protects API
 * keys on disk. Called once at app startup; the result is cached for the
 * rest of the process lifetime so `encryptKey` / `decryptKey` stay sync.
 *
 * The key lives next to `data.json` in `userDataDir` with mode 0600. This
 * deliberately avoids `electron.safeStorage`, whose macOS backend (Keychain)
 * prompts the user on every access.
 */
export async function initKeyStore(userDataDir: string): Promise<void> {
  if (cachedKey) return;
  const keyPath = path.join(userDataDir, KEY_FILENAME);
  try {
    const existing = await fs.readFile(keyPath);
    if (existing.length === KEY_BYTES) {
      cachedKey = existing;
      return;
    }
  } catch {
    // missing or unreadable → fall through to regeneration
  }
  const fresh = randomBytes(KEY_BYTES);
  await fs.writeFile(keyPath, fresh, { mode: 0o600 });
  cachedKey = fresh;
}

/** Test-only: drop the cached key so the next {@link initKeyStore} reads
 *  (or regenerates) from disk. Never call this in production code. */
export function _resetKeyCacheForTest(): void {
  cachedKey = null;
}

/** AES-256-GCM encrypt `plain` and return a self-describing `v2:` payload. */
export function encryptKey(plain: string): string {
  if (!cachedKey) {
    // initKeyStore not yet (or never) ran — keep parity with the old
    // no-encryption fallback so a misconfigured app still saves *something*.
    return Buffer.from(plain, 'utf8').toString('base64');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, cachedKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return FORMAT_PREFIX + [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

/** Decrypt a value produced by {@link encryptKey}. Legacy base64 entries
 *  (no `v2:` prefix) round-trip as-is. */
export function decryptKey(stored: string): string {
  if (!stored.startsWith(FORMAT_PREFIX)) {
    return Buffer.from(stored, 'base64').toString('utf8');
  }
  if (!cachedKey) throw new Error('key store not initialized');
  const parts = stored.slice(FORMAT_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('malformed encrypted key');
  const [ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64 as string, 'base64');
  const tag = Buffer.from(tagB64 as string, 'base64');
  const enc = Buffer.from(encB64 as string, 'base64');
  const decipher = createDecipheriv(ALGO, cachedKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
