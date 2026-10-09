import { type FileSystemAdapter, joinPath } from './fsAdapter';

/**
 * Port of packages/app/src/main/keys.ts.
 *
 * The on-disk format is reproduced exactly so an existing `.key` and existing
 * `apiKeyEncrypted` values keep working — that is the whole point of the
 * zero-migration requirement. Only the crypto primitive moved: node:crypto's
 * `createCipheriv` has no webview equivalent, so this uses WebCrypto
 * (`crypto.subtle`), which is the same AES-256-GCM the original used.
 *
 * Format parity with the original, field by field:
 *   algorithm    AES-256-GCM            (subtle.importKey/raw + encrypt/decrypt)
 *   IV length    12 bytes, random       (original: randomBytes(IV_BYTES))
 *   key          32 raw bytes, random on first launch
 *   key storage  <dataDir>/.key, mode 0600
 *   payload      `v2:` + base64(iv) + '.' + base64(tag) + '.' + base64(ciphertext)
 *   legacy       no `v2:` prefix → treated as base64 plaintext, decoded as-is
 *
 * WebCrypto appends the auth tag to the ciphertext, so `encrypt` returns
 * ciphertext||tag and `decrypt` expects the same — the tag is split off here to
 * keep the stored string identical to the original's iv.tag.enc ordering.
 */
const KEY_FILENAME = '.key';
const ALGO = 'AES-GCM';
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** Marker for entries written by this version. Anything without this prefix
 *  is treated as a legacy base64 plaintext and decoded as such. */
const FORMAT_PREFIX = 'v2:';

let cachedKey: CryptoKey | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Load (or generate on first launch) the AES-256-GCM key that protects API
 * keys on disk. Called once at app startup; the result is cached for the
 * rest of the session so `encryptKey` / `decryptKey` stay sync.
 *
 * The key lives next to `data.json` with owner-only permissions. This
 * deliberately avoids the Keychain, whose macOS backend prompts the user on
 * every access.
 */
export async function initKeyStore(dataDir: string, fs: FileSystemAdapter): Promise<void> {
  if (cachedKey) return;
  const keyPath = joinPath(dataDir, KEY_FILENAME);
  try {
    if (await fs.exists(keyPath)) {
      const existing = await fs.readBytes(keyPath);
      if (existing.length === KEY_BYTES) {
        cachedKey = await importAesKey(existing);
        // Rewrite the key through tmp+rename so its permissions are 0600 even
        // if an earlier build wrote it with the umask default. `mode` is
        // `open(2)`'s `O_CREAT` mode, so writing over an existing file leaves
        // that file's mode alone — but `rename` carries the *source* file's
        // mode onto the destination, so a freshly created 0600 tmp does fix it.
        // Cheap enough to be unconditional: 32 bytes, once per launch. Both
        // paths are in the fs capability (`.key` and `.key.tmp`).
        await rewritePrivate(fs, keyPath, existing);
        return;
      }
    }
  } catch {
    // missing or unreadable → fall through to regeneration
  }
  const fresh = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  await fs.writePrivate(keyPath, fresh);
  cachedKey = await importAesKey(fresh);
}

/**
 * Re-writes `path` with owner-only permissions without ever leaving it absent.
 *
 * delete-then-write would lose the key to any interruption between the two, and
 * the key is unrecoverable — losing it means every `apiKeyEncrypted` in
 * `data.json` becomes undecryptable. Writing a sibling tmp first and renaming
 * over the original is atomic, so the path always holds a complete key.
 */
async function rewritePrivate(
  fs: FileSystemAdapter,
  path: string,
  contents: Uint8Array,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writePrivate(tmp, contents);
  await fs.rename(tmp, path);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: ALGO }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Test-only: drop the cached key so the next {@link initKeyStore} reads
 *  (or regenerates) from disk. Never call this in production code. */
export function _resetKeyCacheForTest(): void {
  cachedKey = null;
}

function requireKey(): CryptoKey {
  if (!cachedKey) throw new Error('key store not initialized');
  return cachedKey;
}

/**
 * AES-256-GCM encrypt `plain` and return a self-describing `v2:` payload.
 * Async because WebCrypto is promise-based; the call sites are already async.
 */
export async function encryptKey(plain: string): Promise<string> {
  if (!cachedKey) {
    // initKeyStore not yet (or never) ran — keep parity with the old
    // no-encryption fallback so a misconfigured app still saves *something*.
    return toBase64(new TextEncoder().encode(plain));
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  // WebCrypto appends the tag to the ciphertext; the original stored it as a
  // separate field, so split it back out to keep the payload byte-identical.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv }, cachedKey, new TextEncoder().encode(plain)),
  );
  const tag = sealed.slice(-16);
  const enc = sealed.slice(0, -16);
  return FORMAT_PREFIX + [iv, tag, enc].map((bytes) => toBase64(bytes)).join('.');
}

/** Decrypt a value produced by {@link encryptKey}. Legacy base64 entries
 *  (no `v2:` prefix) round-trip as-is. */
export async function decryptKey(stored: string): Promise<string> {
  if (!stored.startsWith(FORMAT_PREFIX)) {
    return new TextDecoder().decode(fromBase64(stored));
  }
  const parts = stored.slice(FORMAT_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('malformed encrypted key');
  const [ivB64, tagB64, encB64] = parts as [string, string, string];
  const iv = fromBase64(ivB64);
  const tag = fromBase64(tagB64);
  const enc = fromBase64(encB64);
  // Re-attach the tag so WebCrypto sees the layout it produces itself.
  const sealed = new Uint8Array(enc.length + tag.length);
  sealed.set(enc, 0);
  sealed.set(tag, enc.length);
  const plain = await crypto.subtle.decrypt(
    { name: ALGO, iv: iv as BufferSource },
    requireKey(),
    sealed as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
