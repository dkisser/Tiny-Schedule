import {
  type AppData,
  AppDataSchema,
  emptyAppData,
  type Idea,
  IdeaSchema,
  INBOX_PROJECT_ID,
  SYSTEM_TAG_IDS,
} from '@tiny-schedule/shared';
import { type AiLogger, consoleLogger } from '../ai/logger';
import { type FileSystemAdapter, joinPath } from './fsAdapter';

/**
 * Port of packages/app/src/main/infra/dataStore.ts, moved into the webview.
 *
 * Every observable behaviour is preserved because this file *is* the migration
 * surface: a Tauri build has to read the exact `data.json` the Electron build
 * wrote, byte for byte, or "zero migration" is a fiction. The changes are
 * mechanical only — synchronous `node:fs` calls become awaited
 * {@link FileSystemAdapter} calls, `path.join` is replaced by {@link joinPath}
 * because tauri-plugin-fs takes plain path strings, and pino is replaced by
 * the webview's {@link AiLogger}.
 *
 * The asynchrony is not cosmetic. Where the Electron original did its whole
 * read-modify-write inside one tick, every read and every write here is an IPC
 * round trip, so the *ordering* the original got for free has to be rebuilt
 * out of two explicit queues — see {@link DataStore.update}. The recovery and
 * rotation reasoning in the comments below is unchanged from the original; it
 * is the reasoning, not the syntax, that has to survive the port.
 */

/**
 * The outcome of one write attempt.
 *
 * `persisted: false` means the mutation was computed and thrown away: the
 * caller got back the degraded fallback dataset that is on screen, but nothing
 * reached the disk. Without this flag every caller reads the returned dataset
 * as "my write happened" and reports success for a user action that was
 * silently discarded — the refusal was logged, but the user-facing result
 * still said it worked.
 */
export interface WriteResult {
  /** The dataset now in effect. Equals what was passed to update() on success. */
  data: AppData;
  /** False when the write was refused and nothing was written. */
  persisted: boolean;
}

/**
 * How many backup generations to keep beside data.json.
 *
 * The cost is disk, and it is the whole cost: every generation is a full copy
 * of the document, so 2 means three copies on disk where there used to be two.
 * That is what buys the property that no content comparison can — a backup is
 * kept for being *older*, not for holding more records, so the emptied-library
 * case that defeated the count guard needs no special case at all.
 *
 * Two rather than one because one generation is the situation that already
 * went wrong: a backup that a single unlucky write can overwrite is not a
 * backup. Two is enough that the copy being displaced is always one the user
 * has already seen survive. Halve the footprint by setting this to 1; nothing
 * else in the store has to change.
 */
const BACKUP_GENERATIONS = 2;

/** What {@link DataStore.ensureRecovered} found, before the mutation runs. */
type RecoveryOutcome = 'recovered' | 'already-writable' | 'still-unreadable';

/** Told whenever the store enters or leaves the read-only mode. */
type ModeListener = (writable: boolean, reason: string | null) => void;

/**
 * Runs once each time a refusal clears and the store becomes writable.
 *
 * Async here where the original's was not: a listener is the deferred startup
 * migration, and in this port a migration writes *through this store*, so it
 * returns a promise that {@link DataStore.notifyRecovered} has to await.
 */
type RecoveryListener = () => void | Promise<void>;

export class DataStore {
  private cache: AppData | null = null;
  /**
   * Set when data.json exists but will not parse, with the reason. While it is
   * set, save() refuses to write: the loaded cache is a fallback (the backup,
   * or empty), and persisting it would replace the only surviving copy of the
   * user's data with a degraded one — the failure mode where an ordinary
   * settings change or a 30s heartbeat destroys everything.
   */
  private primaryUnreadable: string | null = null;
  /** Latch on the refusal log, so one incident reports once, not per write. */
  private refusalReported = false;
  /** Runs once each time a refusal clears and the store becomes writable. */
  private recoveryListeners: RecoveryListener[] = [];
  /** Told whenever the store enters or leaves the read-only mode. */
  private modeListeners: ModeListener[] = [];
  /** Records generation 1 holds; invalidated on every rotation. null = not read yet. */
  private cachedBackupRecords: number | null = null;

  constructor(
    private readonly dir: string,
    private readonly fs: FileSystemAdapter,
    private readonly logger: AiLogger = consoleLogger,
  ) {
    // No mkdir here, unlike the Electron original: tauri-plugin-fs's mkdir is a
    // promise, and a constructor cannot await. open() does it instead, and every
    // construction goes through it.
  }

  /**
   * The only supported construction. Creates the data directory first, because
   * every later write assumes it exists.
   */
  static async open(
    dir: string,
    fs: FileSystemAdapter,
    logger: AiLogger = consoleLogger,
  ): Promise<DataStore> {
    await fs.mkdir(dir);
    return new DataStore(dir, fs, logger);
  }

  private get filePath(): string {
    return joinPath(this.dir, 'data.json');
  }

  /**
   * The pre-generations backup name.
   *
   * Kept as a path and not as a policy: it is only ever read once, folded into
   * generation 1, and never written again. See adoptLegacyBackup().
   */
  private get legacyBackupPath(): string {
    return joinPath(this.dir, 'data.backup.json');
  }

  /** Generation 1 is the newest backup; N the oldest one still kept. */
  private backupPath(generation: number): string {
    return joinPath(this.dir, `data.backup.${generation}.json`);
  }

  /**
   * Sequential on purpose: each fallback is only consulted once the previous
   * one has actually resolved. Chaining these with `??` would compare promises
   * against null and silently discard the primary file.
   */
  async load(): Promise<AppData> {
    // Before anything reads a backup. Adopting it first is what lets every
    // later fallback simply look at the generations.
    await this.adoptLegacyBackup();
    // Each fallback is announced. Landing on emptyAppData() after the primary
    // and every generation have failed to parse means the user is looking at an
    // empty app and a data.json that still looks fine on disk; without a record
    // of why, that is indistinguishable from a fresh install.
    const problems: string[] = [];
    const primary = await this.readValidated(this.filePath, (r) => problems.push(r));
    // Latch only when the primary genuinely failed to yield a dataset. A file
    // that recovered via quarantine also pushes a problem — and latching on
    // that made every save refuse, leaving the app permanently read-only,
    // which is a worse failure than the one it was guarding against.
    this.primaryUnreadable = primary ? null : (problems[0] ?? null);
    if (primary) {
      this.cache = primary;
    } else {
      const backup = await this.readNewestBackup((r) => problems.push(r));
      if (backup) {
        this.cache = backup;
        this.logger.warn({
          action: 'dataStore:load:backup',
          reason: problems[0] ?? 'missing',
        });
      } else {
        this.cache = emptyAppData();
        if (problems.length > 0) {
          this.logger.error({
            action: 'dataStore:load:empty',
            problems,
            note: 'files left untouched on disk',
          });
        }
      }
    }
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
   *
   * The Electron original needed no queue — its read-modify-write was
   * synchronous inside one tick — but here `save()` alone is four awaited IPC
   * round trips, so two callers that both read before either writes would each
   * persist a stale snapshot and the second would silently erase the first.
   * That is reachable in normal use: a settings save awaits WebCrypto inside
   * the callback while the 30s timer heartbeat fires `timerSync` against the
   * same dataset.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  /**
   * The same idea for the recovery probe, kept separate from the write queue
   * for a reason that only exists because of the asynchrony: a recovery
   * listener writes through this store, so the listener has to be able to run
   * while the update that triggered the recovery is still in progress. Two
   * queues, so neither waits on the other.
   */
  private recoveryChain: Promise<unknown> = Promise.resolve();

  /**
   * Apply `fn` to the current dataset and persist the result.
   *
   * `fn` is re-applied to the *recovered* dataset when a write finds that
   * data.json has become readable since the last load. Re-running it is what
   * makes the repair safe: persisting the value computed from the stale
   * fallback cache would write that cache over the file the user just fixed —
   * the very destruction the refusal exists to prevent, reached by another
   * door. One re-entry only, so a file that is still unreadable cannot loop.
   *
   * The callback may return a promise: WebCrypto-backed key encryption is
   * async, so a settings write has to await inside the mutation before the
   * result can be validated and persisted.
   *
   * Returns `persisted: false` when the write was refused. Callers that report
   * a user-visible result (stopTiming, syncTimer, settings) must check it:
   * the returned dataset is the degraded fallback, so reading it as "what I
   * just wrote" is how a dropped write gets reported as a success.
   */
  async update(fn: (current: AppData) => AppData | Promise<AppData>): Promise<WriteResult> {
    // Recovery runs *outside* the write queue, and that is the whole reason
    // the two queues exist. tryRecover() notifies the recovery listeners, and
    // a listener's first act is to call update() again — inside the store's own
    // API. Holding the write queue across that notification would be a
    // self-deadlock: the outer write would be waiting for a queued job that is
    // waiting for the outer write to finish. Everything the source did inside
    // one synchronous tick therefore has to happen before the mutation is
    // enqueued, not inside it.
    const outcome = await this.ensureRecovered();
    if (outcome === 'still-unreadable') {
      // get() here is the degraded cache; do not run the mutation against it.
      const fallback = await this.get();
      this.refuse();
      return { data: fallback, persisted: false };
    }
    return this.enqueue(() => this.applyMutation(fn));
  }

  private async applyMutation(
    fn: (current: AppData) => AppData | Promise<AppData>,
  ): Promise<WriteResult> {
    // The base is read here, inside the queue and *after* any recovery
    // listeners have run: they may have migrated the recovered dataset, and the
    // pending mutation has to apply to what is now on record rather than to the
    // pre-migration object update() originally re-read.
    const base = await this.get();
    const next = await fn(base);
    // A mutation that changed nothing must not rewrite the file: the 30s
    // heartbeat hits this path constantly, and each write costs a full schema
    // validation, a backup copy and a temp+rename. Note that this only fires
    // for a caller that returns the identical reference — the heartbeat's
    // real saving comes from taskService.syncTimer's value comparison.
    if (next === base) return { data: base, persisted: true };
    const persisted = await this.persist(next);
    return { data: persisted ? next : (this.cache ?? next), persisted };
  }

  /**
   * Make the store writable if it has become writable, and say what happened.
   *
   * Serialised on its own queue so two updates racing into a broken store do
   * not both fire the recovery listeners, but released *before* those listeners
   * are notified — see the note on the field.
   */
  private async ensureRecovered(): Promise<RecoveryOutcome> {
    if (!this.primaryUnreadable) return 'already-writable';
    // Held in an object rather than a `let` because the write happens inside a
    // callback the compiler cannot see through; reading it back into a widened
    // local keeps the result honest instead of narrowing to the initial value.
    const observed: { outcome: RecoveryOutcome } = { outcome: 'already-writable' };
    const attempt = this.recoveryChain.then(async () => {
      // Re-checked inside the queue: a concurrent update may have recovered the
      // store while this one was still waiting its turn, and re-running the
      // migrations would be the wrong answer to a question already answered.
      if (!this.primaryUnreadable) return;
      observed.outcome = (await this.tryRecover()) ? 'recovered' : 'still-unreadable';
    });
    this.recoveryChain = attempt.catch(() => undefined);
    await attempt;
    const outcome: RecoveryOutcome = observed.outcome;
    if (outcome === 'recovered') {
      // Deferred work (the startup migrations) runs here, between recovery and
      // the pending mutation. It has to be exactly here in both directions:
      // inside tryRecover() the listener's save was overwritten by the write
      // that triggered the recovery, and after the save the listener's own
      // write clobbered the user's. Neither order survives the round trip, so
      // the migrations ran and were erased — on the first recovery, which is
      // the only case they were deferred for.
      await this.notifyRecovered();
    }
    return outcome;
  }

  /** Awaited, so a listener's own write is durable before the mutation runs. */
  private async notifyRecovered(): Promise<void> {
    for (const listener of this.recoveryListeners) await listener();
  }

  /**
   * False while data.json cannot be written. Recovery is `update`'s job — it
   * re-runs the mutation against the recovered base — so a direct `save` of a
   * value derived from the stale fallback has no way to be safe, and callers
   * that hold an absolute result (the load-time migrations) must check this.
   */
  get isWritable(): boolean {
    return this.primaryUnreadable === null;
  }

  /**
   * Why data.json will not parse, or null while it does.
   *
   * Public because the banner needs it: "save failed, try again" asks the user
   * to retry something that cannot succeed until they repair the file by hand,
   * and the parse error is the only thing that tells them which file and why.
   */
  get unreadableReason(): string | null {
    return this.primaryUnreadable;
  }

  /**
   * Observe the store's read-only mode (ADR-0004).
   *
   * The refusal is not a property of any one write — it is a *mode* the store
   * is in for as long as data.json will not parse. That is why it should not
   * ride along with every channel's return value: doing so made each new
   * channel one more place to forget, and forgetting is invisible (it
   * type-checks, passes tests, and shows the user a save that never happened).
   *
   * The listener fires on subscription, once, with the state as it is right
   * now: the renderer needs the current state, and a store that has already
   * latched by the time it subscribes would otherwise look writable.
   */
  onModeChanged(listener: ModeListener): () => void {
    listener(this.isWritable, this.primaryUnreadable);
    this.modeListeners = [...this.modeListeners, listener];
    // Returning an unsubscribe: a renderer reload re-runs the effect, and a
    // list that only grows would keep notifying a window that is gone.
    return () => {
      this.modeListeners = this.modeListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Report that a write was dropped. Once per incident: a refused store
   * refuses every heartbeat for the rest of the process, and an operator
   * needs the one line, not thousands.
   *
   * This lived only in save() until a review caught that update() returns
   * before reaching it — so the dominant write path discarded every user
   * write with no signal at all.
   */
  private refuse(): void {
    if (this.refusalReported) return;
    this.refusalReported = true;
    // Latched with the log, on purpose. The renderer shows this as a banner
    // rather than a toast precisely so it cannot stack: firing per write is
    // what buried the one real signal under ten identical ones during the
    // debounced title edits.
    for (const listener of this.modeListeners) listener(false, this.primaryUnreadable);
    this.logger.error({
      action: 'dataStore:save:refused',
      reason: this.primaryUnreadable,
      file: this.filePath,
      note: 'writes are being dropped; the unreadable data.json has been left in place',
    });
  }

  /**
   * Try to re-read data.json after a load-time failure.
   *
   * Returns the recovered dataset and adopts it as the cache, or null when
   * the file still will not parse — in which case the refusal stands.
   */
  private async tryRecover(): Promise<AppData | null> {
    if (!(await this.fs.exists(this.filePath))) {
      // The user deleted the unreadable file, which is a resolution and not a
      // refusal. Treating it as still-broken left the latch armed forever,
      // with the stored reason still describing a file that is not there.
      //
      // Fall back to the backup the same way load() did. Handing back
      // emptyAppData() instead looked like a resolution but was its own
      // destruction: the next write persisted that empty set to data.json, and
      // the one after that rotated it over the still-intact backup, so
      // deleting one corrupt file lost everything.
      const previousReason = this.primaryUnreadable;
      // Collect why, so adopting `empty` is never an unexplained outcome: the
      // one place the fallback chain used to end without naming a cause.
      const backupProblems: string[] = [];
      const backup = await this.readNewestBackup((r) => backupProblems.push(r));
      this.cache = backup ?? emptyAppData();
      this.primaryUnreadable = null;
      this.refusalReported = false;
      this.logger.warn({
        action: 'dataStore:save:file-removed',
        previousReason,
        file: this.filePath,
        adopted: backup ? 'backup' : 'empty',
        // Name the backup's own state rather than leaving it to be inferred.
        // `adopted: 'empty'` alone cannot distinguish "there was no backup" from
        // "the backup was there and unreadable" — two very different incidents
        // for whoever has to restore this by hand, and the previousReason above
        // describes the *deleted* file, so it says nothing about the backup.
        backupState: (await this.hasAnyBackup()) ? 'present' : 'missing',
        ...(backupProblems.length > 0 ? { backupProblems } : {}),
      });
      this.notifyModeWritable();
      return this.cache;
    }
    // Collect the reasons rather than discarding them: a re-read that succeeds
    // only after quarantining records has still dropped data, and reporting
    // that as a plain `recovered` told the operator nothing was lost.
    const problems: string[] = [];
    const recovered = await this.readValidated(this.filePath, (r) => problems.push(r));
    if (!recovered) return null;
    // Adopt it. Clearing the latch while leaving the stale fallback in `cache`
    // is what made the next write overwrite the repaired file. No recursion
    // guard is needed: nothing on this path can reach persist().
    this.cache = recovered;
    this.primaryUnreadable = null;
    this.refusalReported = false;
    const payload = {
      action: 'dataStore:save:recovered',
      file: this.filePath,
      ...(problems.length > 0 ? { quarantined: problems } : {}),
    };
    // Warn, not info, when records were dropped on the way in.
    if (problems.length > 0) this.logger.warn(payload);
    else this.logger.info(payload);
    this.notifyModeWritable();
    return recovered;
  }

  private notifyModeWritable(): void {
    for (const listener of this.modeListeners) listener(true, null);
  }

  /**
   * Run `listener` once each time the store recovers from a refusal.
   *
   * The load-time migrations run once at startup and cannot be replayed: they
   * are absolute results computed from the loaded dataset, not mutations of it.
   * When startup found the store read-only they were skipped — and silently,
   * because "the store is not writable" was the same as "nothing to do". A
   * session that later recovered therefore stayed unmigrated for good, with no
   * record that it had been skipped. Subscribing here is what lets the
   * migration run at the moment the store becomes writable again.
   */
  onRecovered(listener: RecoveryListener): void {
    this.recoveryListeners = [...this.recoveryListeners, listener];
  }

  /**
   * A whole-dataset write, queued behind any update already in flight. Startup
   * migrations use this, and they run against the same store the renderer then
   * writes through — a migration landing in the middle of a heartbeat's
   * read-modify-write would drop one of them.
   *
   * Returns false when the write was refused. The refusal is also logged (once
   * per incident), but a caller that has to report a user-visible result cannot
   * afford to wait for a log line it will never read.
   */
  save(data: AppData): Promise<boolean> {
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

  /**
   * Persist `data`, rotating the generations down first.
   *
   * The refusal check happens here rather than at the call site so it is
   * evaluated at write time rather than enqueue time.
   */
  private async persist(data: AppData): Promise<boolean> {
    if (this.primaryUnreadable) {
      // Refuse rather than persist a degraded cache over the only good copy.
      // Without this, the first ordinary write — a settings change,
      // finishDay, the 30s heartbeat — rewrites data.json from a fallback
      // load and the second overwrites the backup, leaving nothing
      // recoverable. The data stays on disk exactly as the user left it.
      this.refuse();
      return false;
    }
    // Cast: zod infers z.unknown() fields as optional in the parsed output type.
    const validated = AppDataSchema.parse(data) as AppData;
    if ((await this.fs.exists(this.filePath)) && (await this.rotationIsSafe())) {
      await this.rotateBackup();
    }
    const tmp = `${this.filePath}.tmp`;
    await this.fs.writeText(tmp, JSON.stringify(validated));
    await this.fs.rename(tmp, this.filePath); // atomic on POSIX
    this.cache = validated;
    return true;
  }

  /**
   * Demote every generation one slot and make data.json generation 1.
   *
   * The primary write is tmp+rename, so a crash mid-write cannot truncate it.
   * A plain copy straight into a backup had no such protection: a crash (or
   * a full disk) during the copy left a half-written backup, and the next
   * start then had two damaged files instead of one recoverable one. Copy to a
   * temp name and rename, so each generation is always either the file it
   * replaced or the new one — never a partial one.
   *
   * The shift is renames only, which are atomic in their own right: a
   * generation is never rewritten in place, so an interrupted rotation leaves
   * the generations that did move intact and simply stops.
   */
  private async rotateBackup(): Promise<void> {
    const tmp = `${this.backupPath(1)}.tmp`;
    try {
      await this.demoteGenerations();
      await this.fs.copy(this.filePath, tmp);
      await this.fs.rename(tmp, this.backupPath(1));
      // Generation 1 now holds exactly what this.cache held a moment ago, so
      // the count is known without re-reading it. Nulling it instead meant the
      // cache filled and was cleared on every save that rotates — which is
      // the common path — so it only ever helped when rotation was suppressed,
      // the exact case it was not written for.
      this.cachedBackupRecords = this.cache ? countRecords(this.cache) : 0;
    } catch (err) {
      // A backup that cannot be rotated is not a reason to drop the user's
      // write: data.json is still the newer copy and is written atomically.
      try {
        if (await this.fs.exists(tmp)) await this.fs.remove(tmp);
      } catch {
        // best effort
      }
      this.logger.warn({
        action: 'dataStore:backup:rotateFailed',
        file: this.backupPath(1),
        generations: BACKUP_GENERATIONS,
        reason: err instanceof Error ? err.message : String(err),
        note: 'continuing with the primary write',
      });
    }
  }

  /**
   * Move each generation down one slot, dropping the oldest.
   *
   * Oldest first, on purpose. Dropping generation N before shifting means an
   * interrupted shift can only ever lose the generation that was about to be
   * lost anyway; going the other way would leave two files holding the same
   * copy and, if the crash landed between the shift and the new write, a
   * chain whose head is a duplicate of its tail.
   */
  private async demoteGenerations(): Promise<void> {
    const oldest = this.backupPath(BACKUP_GENERATIONS);
    if (await this.fs.exists(oldest)) await this.fs.remove(oldest);
    for (let generation = BACKUP_GENERATIONS - 1; generation >= 1; generation -= 1) {
      const from = this.backupPath(generation);
      if (await this.fs.exists(from)) await this.fs.rename(from, this.backupPath(generation + 1));
    }
  }

  /**
   * Fold a pre-generations `data.backup.json` into generation 1.
   *
   * Lazy, on load, rather than in a one-shot migration: that file is the
   * user's data, and a migration that only runs on the next release's first
   * launch is one that can be skipped by an update rollback, or never reached
   * at all if the user quits first. Every code path that can read or write a
   * backup goes through load(), so doing it here means there is no path that
   * can leave the old name behind.
   *
   * Whatever generation 1 holds is demoted rather than overwritten. That case
   * is only reachable by running an older build in between (it writes the old
   * name again), and even then it costs nothing: both files are kept, the
   * older one moves down a slot it would have held anyway.
   */
  private async adoptLegacyBackup(): Promise<void> {
    if (!(await this.fs.exists(this.legacyBackupPath))) return;
    try {
      await this.demoteGenerations();
      await this.fs.rename(this.legacyBackupPath, this.backupPath(1));
      // Generation 1 now holds different bytes than the count cached against
      // the old one, and load() can run more than once on a live store.
      this.cachedBackupRecords = null;
      this.logger.info({
        action: 'dataStore:backup:legacyAdopted',
        file: this.legacyBackupPath,
        generation: 1,
      });
    } catch (err) {
      // Leave the file where it is. A failed adoption that deleted the user's
      // backup to report the failure would be the failure.
      this.logger.warn({
        action: 'dataStore:backup:legacyAdoptFailed',
        file: this.legacyBackupPath,
        reason: err instanceof Error ? err.message : String(err),
        note: 'left in place',
      });
    }
  }

  /** Whether any generation exists, readable or not. */
  private async hasAnyBackup(): Promise<boolean> {
    for (let generation = 1; generation <= BACKUP_GENERATIONS; generation += 1) {
      if (await this.fs.exists(this.backupPath(generation))) return true;
    }
    return false;
  }

  /**
   * The newest generation that parses, or null.
   *
   * Newest first, because generations are ordered by write time — an older
   * one is a poorer recovery point regardless of what either of them holds.
   * Reading them in the other order would let a stale file beat the current
   * one, which is the same class of mistake as demoting a poorer copy.
   *
   * Sequential awaits, not `??`: each generation is only consulted once the
   * previous one has actually been read and rejected.
   */
  private async readNewestBackup(onUnreadable: (reason: string) => void): Promise<AppData | null> {
    for (let generation = 1; generation <= BACKUP_GENERATIONS; generation += 1) {
      const data = await this.readValidated(this.backupPath(generation), onUnreadable);
      if (data) return data;
    }
    return null;
  }

  /**
   * Whether the outgoing data.json may become the backup.
   *
   * The generations are the guarantee; this is the cheaper second layer under
   * them. A backup is never replaced by a poorer copy of the library, which is
   * a rule about *content*, and content is the one thing the generations
   * cannot see — they know a copy is older, not that it holds more.
   *
   * A plain "don't rotate an empty dataset" check is not that. It buys exactly
   * one write — the user clears their tasks, the backup is spared, and then the
   * first new task they create rotates the emptiness over that backup anyway,
   * losing both generations exactly as before. Comparing against what the
   * backup actually holds holds the line until the library is genuinely rebuilt
   * to at least that size.
   *
   * Counting records is a proxy, not a proof: it cannot tell a user who
   * deliberately deleted 40 of 50 tasks from one who lost them, and it cannot
   * see a whole record type replaced by another of the same size — which is
   * why generation 2 exists rather than this check standing alone. Keeping
   * the richer copy is the right side to err on — the cost is a stale backup,
   * the alternative is an unrecoverable one.
   */
  private async rotationIsSafe(): Promise<boolean> {
    // The dataset *on disk* — this.cache — not the one about to replace it.
    // rotateBackup copies data.json, so it is this.cache that becomes the
    // backup; `data` is what would be written afterwards and never reaches the
    // backup at all. Comparing the incoming dataset instead let an import of
    // 200 tasks pass the check and then demote a 2-task file over a
    // 10-task backup — the generation this guard exists to protect, gone.
    const outgoing = this.cache ? countRecords(this.cache) : 0;
    const backedUp = await this.backupRecordCount();
    // -1 means there is no readable backup, so there is nothing to protect.
    if (backedUp < 0 || outgoing >= backedUp) return true;
    this.logger.warn({
      action: 'dataStore:backup:kept',
      note: 'the outgoing dataset holds fewer records than the backup it would replace',
      file: this.backupPath(1),
      outgoing,
      backedUp,
    });
    return false;
  }

  /**
   * How many user records generation 1 holds, or -1 when it is missing or
   * unreadable.
   *
   * Cached, and refreshed whenever the generations are rotated. The
   * alternative — re-reading and re-parsing a file that cannot have changed
   * since the last write — put a second full schema parse on every save while
   * the dataset was empty, which is the hot path this guard itself created.
   * Safe to cache without a lock because only the write queue reads it.
   */
  private async backupRecordCount(): Promise<number> {
    if (this.cachedBackupRecords === null) {
      const backup = await this.readValidated(this.backupPath(1), () => {});
      this.cachedBackupRecords = backup ? countRecords(backup) : -1;
    }
    return this.cachedBackupRecords;
  }

  /**
   * Parse a data file, or report why it could not be read.
   *
   * The caller falls back from data.json to the backup to emptyAppData(), and
   * the last of those renders an empty app. That is total, silent data
   * invisibility, so each fallback is named rather than swallowed: a dataset
   * that used to have ideas and now has none needs an explanation on disk.
   */
  private async readValidated(
    path: string,
    onUnreadable: (reason: string) => void,
  ): Promise<AppData | null> {
    if (!(await this.fs.exists(path))) return null;
    let raw: string;
    try {
      raw = await this.fs.readText(path);
    } catch (err) {
      onUnreadable(`unreadable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      onUnreadable(`invalid json: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const result = AppDataSchema.safeParse(json);
    if (result.success) return result.data as AppData;

    // A strict parse rejects the whole document for one bad record, so a single
    // idea written by a newer build used to cost the user every task, project
    // and follow-up on disk. Retry after quarantining the individual records
    // that fail: one unreadable idea now costs one idea, and the rest of the
    // library loads. The drop is reported, never silent — the alternative
    // (tolerating the field) is what silently revived closed ideas.
    const recovered = quarantineBadIdeas(json, (id, why) =>
      onUnreadable(`quarantined idea ${id}: ${why}`),
    );
    if (recovered) return recovered;
    onUnreadable(`schema mismatch: ${result.error.issues[0]?.path.join('.') ?? '(unknown)'}`);
    return null;
  }
}

/**
 * Drop the idea records that will not parse and re-validate the rest.
 *
 * Returns null when the failure is not confined to `ideas` — only then is the
 * whole document genuinely unreadable, and only then may the caller fall back
 * to the backup. Quarantine, not repair: the offending record is reported and
 * left out rather than coerced into something that parses, because a coerced
 * value is how a terminal state quietly becomes an open one.
 */
function quarantineBadIdeas(
  json: unknown,
  onQuarantined: (id: string, why: string) => void,
): AppData | null {
  if (typeof json !== 'object' || json === null) return null;
  const ideas = (json as { ideas?: unknown }).ideas;
  if (typeof ideas !== 'object' || ideas === null) return null;

  const kept: Record<string, Idea> = {};
  for (const [id, value] of Object.entries(ideas as Record<string, unknown>)) {
    const parsed = IdeaSchema.safeParse(value);
    if (parsed.success) {
      kept[id] = parsed.data;
    } else {
      const issue = parsed.error.issues[0];
      onQuarantined(id, `${issue?.path.join('.') ?? '(root)'}: ${issue?.message ?? 'invalid'}`);
    }
  }
  const result = AppDataSchema.safeParse({ ...(json as object), ideas: kept });
  return result.success ? (result.data as AppData) : null;
}

const SYSTEM_TAGS = new Set<string>(Object.values(SYSTEM_TAG_IDS));

/**
 * How many user records a dataset holds.
 *
 * System entities are excluded: emptyAppData() always ships INBOX_PROJECT and
 * the two system tags, and counting them made an empty library look occupied —
 * which is what made the original guard unreachable and got it deleted.
 */
function countRecords(data: AppData): number {
  return (
    Object.keys(data.tasks).length +
    Object.keys(data.ideas).length +
    Object.keys(data.followUps).length +
    Object.keys(data.projects).filter((id) => id !== INBOX_PROJECT_ID).length +
    Object.keys(data.tags).filter((id) => !SYSTEM_TAGS.has(id)).length +
    // Chat sessions are the one record type that is not a keyed map, so
    // skipping them made the count blind to a whole library's worth of user
    // data: a user with 200 tasks and 3 chats and a user whose 3 chats had
    // just been wiped scored the same, and the guard waved the loss through.
    countChatSessions(data)
  );
}

/**
 * Sessions in `misc.chatSessions`, or 0 when there are none.
 *
 * Counted defensively because `misc` is `Record<string, unknown>` — a raw
 * section this package does not model, and one an importer can write as
 * anything at all. A guard that threw on a shape it did not recognise would be
 * a guard that takes the primary write down with it.
 */
function countChatSessions(data: AppData): number {
  const sessions = data.misc.chatSessions;
  return Array.isArray(sessions) ? sessions.length : 0;
}
