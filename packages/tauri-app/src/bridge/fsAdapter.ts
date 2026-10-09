/**
 * Filesystem seam for the data layer.
 *
 * The store's semantics — atomic tmp+rename, backup-before-overwrite, schema
 * validation on both read and write — are the part that must not drift, so
 * they live in `dataStore.ts` against this narrow interface rather than against
 * a concrete filesystem. Production binds it to tauri-plugin-fs; tests bind it
 * to an in-memory implementation and run under plain `bun test`, with no Tauri
 * runtime present.
 */
export interface FileSystemAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** Reads UTF-8 text. Rejects when the file is missing. */
  readText(path: string): Promise<string>;
  /** Writes UTF-8 text, replacing any existing file. */
  writeText(path: string, contents: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Writes text to a fresh path with owner-only permissions (0600). */
  writePrivate(path: string, contents: Uint8Array): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
}

/** Owner-only, the mode `.key` has to carry on disk. */
export const PRIVATE_MODE = 0o600;
/** Owner-only directory, the mode the data directory has to carry on disk. */
export const PRIVATE_DIR_MODE = 0o700;

/**
 * In-memory adapter for tests. Records call order so the atomic-write
 * sequence can be asserted directly rather than inferred from the result.
 *
 * Modes are modelled, not just flagged: `writePrivate` records 0600 the way the
 * real adapter now asks for it, `writeText` records 0644 the way an umask would
 * leave it, and `rename` carries the source's mode onto the destination the way
 * POSIX does. That is what makes a permissions test falsifiable — an earlier
 * version recorded a bare "this path was written privately" flag that
 * `writePrivate` set unconditionally, so every such assertion passed no matter
 * what the production code asked the filesystem for.
 *
 * `binaryPaths` is kept separate from the modes on purpose. Whether a file is
 * stored base64 in this map is an artefact of holding bytes in a
 * `Map<string, string>`, not a fact about permissions — conflating the two
 * made a legitimately loose-but-correct `.key` unreadable.
 */
export class MemoryFs implements FileSystemAdapter {
  private readonly files = new Map<string, string>();
  private readonly modes = new Map<string, number>();
  private readonly binaryPaths = new Set<string>();
  readonly calls: string[] = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [path, contents] of Object.entries(seed)) {
      this.files.set(path, contents);
      this.modes.set(path, 0o644);
    }
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** The permission bits this path was last written with, or null if absent. */
  modeOf(path: string): number | null {
    return this.modes.get(path) ?? null;
  }

  /** True only if the path exists *and* is owner-only. Falsifiable. */
  isPrivate(path: string): boolean {
    const mode = this.modes.get(path);
    return mode !== undefined && mode === PRIVATE_MODE;
  }

  async exists(path: string): Promise<boolean> {
    this.calls.push(`exists:${path}`);
    return this.files.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
  }

  async readText(path: string): Promise<string> {
    this.calls.push(`readText:${path}`);
    const contents = this.files.get(path);
    if (contents === undefined) throw new Error(`ENOENT: ${path}`);
    return contents;
  }

  async writeText(path: string, contents: string): Promise<void> {
    this.calls.push(`writeText:${path}`);
    this.files.set(path, contents);
    // 0644: what an ordinary write leaves behind under a 022 umask.
    this.modes.set(path, 0o644);
    this.binaryPaths.delete(path);
  }

  async copy(from: string, to: string): Promise<void> {
    this.calls.push(`copy:${from}->${to}`);
    const contents = this.files.get(from);
    if (contents === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, contents);
    this.modes.set(to, this.modes.get(from) ?? 0o644);
    if (this.binaryPaths.has(from)) this.binaryPaths.add(to);
    else this.binaryPaths.delete(to);
  }

  async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename:${from}->${to}`);
    const contents = this.files.get(from);
    if (contents === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, contents);
    // POSIX rename carries the source inode's mode onto the destination name,
    // which is exactly why rewriting through a 0600 tmp repairs a loose file.
    this.modes.set(to, this.modes.get(from) ?? 0o644);
    if (this.binaryPaths.has(from)) this.binaryPaths.add(to);
    this.files.delete(from);
    this.modes.delete(from);
    this.binaryPaths.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
    this.files.delete(path);
    this.modes.delete(path);
    this.binaryPaths.delete(path);
  }

  async writePrivate(path: string, contents: Uint8Array): Promise<void> {
    this.calls.push(`writePrivate:${path}`);
    // Stored base64 so binary keys survive the `Map<string, string>` without a
    // lossy string cast.
    this.files.set(path, Buffer.from(contents).toString('base64'));
    this.modes.set(path, PRIVATE_MODE);
    this.binaryPaths.add(path);
  }

  /** Marks a seeded path as holding base64-encoded bytes rather than text. */
  markBinary(path: string): void {
    this.binaryPaths.add(path);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    this.calls.push(`readBytes:${path}`);
    const contents = this.files.get(path);
    if (contents === undefined) throw new Error(`ENOENT: ${path}`);
    if (this.binaryPaths.has(path)) return new Uint8Array(Buffer.from(contents, 'base64'));
    return new TextEncoder().encode(contents);
  }
}

/** Joins path segments the way the Electron original's `path.join` did. */
export function joinPath(...segments: string[]): string {
  const joined = segments
    .filter((segment) => segment.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}
