import { type AppData, AppDataSchema, emptyAppData } from '@tiny-schedule/shared';
import { type FileSystemAdapter, joinPath } from './fsAdapter';

/**
 * Port of packages/app/src/main/dataStore.ts, moved into the webview.
 *
 * Every observable behaviour is preserved because this file *is* the migration
 * surface: a Tauri build has to read the exact `data.json` the Electron build
 * wrote, byte for byte, or "zero migration" is a fiction. The changes are
 * mechanical only — async filesystem calls behind {@link FileSystemAdapter},
 * and `path.join` replaced by {@link joinPath} because tauri-plugin-fs takes
 * plain path strings.
 */
export class DataStore {
  private cache: AppData | null = null;

  constructor(
    private readonly dir: string,
    private readonly fs: FileSystemAdapter,
  ) {}

  static async open(dir: string, fs: FileSystemAdapter): Promise<DataStore> {
    await fs.mkdir(dir);
    return new DataStore(dir, fs);
  }

  private get filePath(): string {
    return joinPath(this.dir, 'data.json');
  }

  private get backupPath(): string {
    return joinPath(this.dir, 'data.backup.json');
  }

  /**
   * Sequential on purpose: each fallback is only consulted once the previous
   * one has actually resolved. Chaining these with `??` would compare promises
   * against null and silently discard the primary file.
   *
   * The resolved dataset is published as the cache, exactly as the Electron
   * original's `load()` did. This is load-bearing twice over, not an
   * optimisation: `get()` never misses the cache, and — more importantly — the
   * startup migrations compare `migrated !== store.get()` by reference to
   * decide whether anything changed. Without the cache each `get()` returns a
   * freshly parsed object, that comparison is always true, and startup saves on
   * every launch. In the corrupt-primary case that save is destructive: it
   * copies the truncated `data.json` over `data.backup.json`, destroying the
   * only intact copy before the recovered data is ever written.
   */
  async load(): Promise<AppData> {
    const primary = await this.readValidated(this.filePath);
    this.cache = primary ?? (await this.readValidated(this.backupPath)) ?? emptyAppData();
    return this.cache;
  }

  async get(): Promise<AppData> {
    if (!this.cache) return this.load();
    return this.cache;
  }

  /**
   * The tail of the write queue. Every mutation runs through it, so two
   * overlapping updates read their snapshot one after the other rather than
   * both reading the same one.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  /**
   * The callback may return a promise: WebCrypto-backed key encryption is
   * async, so a settings write has to await inside the mutation before the
   * result can be validated and persisted.
   *
   * Serialised on a promise chain. The Electron original needed no queue — its
   * read-modify-write was synchronous inside one tick — but here `save()` alone
   * is four awaited IPC round trips, so two callers that both read before
   * either writes would each persist a stale snapshot and the second would
   * silently erase the first. That is reachable in normal use: a settings save
   * awaits WebCrypto inside the callback while the 30s timer heartbeat fires
   * `timerSync` against the same dataset.
   */
  update(fn: (current: AppData) => AppData | Promise<AppData>): Promise<AppData> {
    return this.enqueue(async () => {
      const next = await fn(await this.get());
      await this.persist(next);
      return next;
    });
  }

  /**
   * A whole-dataset write, queued behind any update already in flight. Startup
   * migrations use this, and they run against the same store the renderer then
   * writes through — a migration landing in the middle of a heartbeat's
   * read-modify-write would drop one of them.
   */
  save(data: AppData): Promise<void> {
    return this.enqueue(() => this.persist(data));
  }

  /** Runs `job` after every previously queued write has settled. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(job);
    // Swallow the rejection on the chain itself so one failed write does not
    // poison every write queued behind it; `run` still rejects for its caller.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async persist(data: AppData): Promise<void> {
    // Cast: zod infers z.unknown() fields as optional in the parsed output type.
    const validated = AppDataSchema.parse(data) as AppData;
    if (await this.fs.exists(this.filePath)) {
      await this.fs.copy(this.filePath, this.backupPath);
    }
    const tmp = `${this.filePath}.tmp`;
    await this.fs.writeText(tmp, JSON.stringify(validated));
    await this.fs.rename(tmp, this.filePath); // atomic on POSIX
    this.cache = validated;
  }

  private async readValidated(path: string): Promise<AppData | null> {
    if (!(await this.fs.exists(path))) return null;
    try {
      return AppDataSchema.parse(JSON.parse(await this.fs.readText(path))) as AppData;
    } catch {
      // A truncated or hand-edited file must not take the app down: fall
      // through so load() can try the backup, then the empty seed.
      return null;
    }
  }
}
