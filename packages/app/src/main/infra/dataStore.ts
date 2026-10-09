import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type AppData,
  AppDataSchema,
  emptyAppData,
  type Idea,
  IdeaSchema,
  INBOX_PROJECT_ID,
} from '@tiny-schedule/shared';
import type { Logger } from 'pino';

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
  private recoveryListeners: (() => void)[] = [];

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private get filePath(): string {
    return join(this.dir, 'data.json');
  }

  private get backupPath(): string {
    return join(this.dir, 'data.backup.json');
  }

  load(): AppData {
    // Each fallback is announced. Landing on emptyAppData() after two failed
    // parses means the user is looking at an empty app and a data.json that
    // still looks fine on disk; without a record of why, that is
    // indistinguishable from a fresh install.
    const problems: string[] = [];
    const read = (path: string) => this.readValidated(path, (r) => problems.push(r));
    const primary = read(this.filePath);
    // Latch only when the primary genuinely failed to yield a dataset. A file
    // that recovered via quarantine also pushes a problem — and latching on
    // that made every save refuse, leaving the app permanently read-only,
    // which is a worse failure than the one it was guarding against.
    this.primaryUnreadable = primary ? null : (problems[0] ?? null);
    if (primary) {
      this.cache = primary;
    } else {
      const backup = read(this.backupPath);
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

  get(): AppData {
    if (!this.cache) return this.load();
    return this.cache;
  }

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
   * Returns `persisted: false` when the write was refused. Callers that report
   * a user-visible result (stopTiming, syncTimer, settings) must check it:
   * the returned dataset is the degraded fallback, so reading it as "what I
   * just wrote" is how a dropped write gets reported as a success.
   */
  update(fn: (current: AppData) => AppData): WriteResult {
    let base = this.get();
    if (this.primaryUnreadable) {
      const recovered = this.tryRecover();
      if (!recovered) {
        // get() here is the degraded cache; do not run the mutation against it.
        this.refuse();
        return { data: base, persisted: false };
      }
      base = recovered;
    }
    const next = fn(base);
    // A mutation that changed nothing must not rewrite the file: the 30s
    // heartbeat hits this path constantly, and each write costs a full schema
    // validation, a backup copy and a temp+rename. Skipping the no-op is the
    // difference between one write per real change and ~120 writes an hour.
    if (next === base) return { data: base, persisted: true };
    const persisted = this.save(next);
    return { data: persisted ? next : (this.cache ?? next), persisted };
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
  private tryRecover(): AppData | null {
    if (!existsSync(this.filePath)) {
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
      const backup = this.readValidated(this.backupPath, (r) => backupProblems.push(r));
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
        backupState: existsSync(this.backupPath) ? 'present' : 'missing',
        ...(backupProblems.length > 0 ? { backupProblems } : {}),
      });
      for (const listener of this.recoveryListeners) listener();
      return this.cache;
    }
    // Collect the reasons rather than discarding them: a re-read that succeeds
    // only after quarantining records has still dropped data, and reporting
    // that as a plain `recovered` told the operator nothing was lost.
    const problems: string[] = [];
    const recovered = this.readValidated(this.filePath, (r) => problems.push(r));
    if (!recovered) return null;
    // Adopt it. Clearing the latch while leaving the stale fallback in `cache`
    // is what made the next write overwrite the repaired file. No recursion
    // guard is needed: nothing on this path can reach save().
    this.cache = recovered;
    this.primaryUnreadable = null;
    this.refusalReported = false;
    const log =
      problems.length > 0 ? this.logger.warn.bind(this.logger) : this.logger.info.bind(this.logger);
    log({
      action: 'dataStore:save:recovered',
      file: this.filePath,
      ...(problems.length > 0 ? { quarantined: problems } : {}),
    });
    for (const listener of this.recoveryListeners) listener();
    return recovered;
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
  onRecovered(listener: () => void): void {
    this.recoveryListeners.push(listener);
  }

  /**
   * Persist `data`, rotating the outgoing file to the backup first.
   *
   * Returns false when the write was refused. The refusal is also logged (once
   * per incident), but a caller that has to report a user-visible result cannot
   * afford to wait for a log line it will never read.
   */
  save(data: AppData): boolean {
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
    if (existsSync(this.filePath) && this.rotationIsSafe(validated)) {
      this.rotateBackup();
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(validated), 'utf8');
    renameSync(tmp, this.filePath); // atomic on POSIX
    this.cache = validated;
    return true;
  }

  /**
   * Demote data.json to the backup, atomically.
   *
   * The primary write is tmp+rename, so a crash mid-write cannot truncate it.
   * copyFileSync straight into the backup had no such protection: a crash (or
   * a full disk) during the copy left a half-written backup, and the next
   * start then had two damaged files instead of one recoverable one. Copy to a
   * temp name and rename, so the backup is always either the old file or the
   * new one — never a partial one.
   */
  private rotateBackup(): void {
    const tmp = `${this.backupPath}.tmp`;
    try {
      copyFileSync(this.filePath, tmp);
      renameSync(tmp, this.backupPath);
    } catch (err) {
      // A backup that cannot be rotated is not a reason to drop the user's
      // write: data.json is still the newer copy and is written atomically.
      try {
        existsSync(tmp) && unlinkSync(tmp);
      } catch {
        // best effort
      }
      this.logger.warn({
        action: 'dataStore:backup:rotateFailed',
        file: this.backupPath,
        reason: err instanceof Error ? err.message : String(err),
        note: 'continuing with the primary write',
      });
    }
  }

  /**
   * Whether the outgoing data.json may become the backup.
   *
   * The rotation is what makes a corrupt primary survivable, so it is also the
   * single step that can destroy the last good copy. The case where it must
   * not run is a dataset with no user content: once the user deletes every
   * task, an ordinary write rotates that emptiness over a backup that still
   * holds their library, and both generations are gone. The previous guard
   * tested `projects` for emptiness too, which made it unreachable —
   * emptyAppData() always ships INBOX_PROJECT — so INBOX is excluded here.
   *
   * The guard never freezes the backup: it only suppresses the rotation while
   * the dataset is empty, and the first write that carries content rotates
   * normally.
   */
  private rotationIsSafe(next: AppData): boolean {
    const hasContent =
      Object.keys(next.tasks).length > 0 ||
      Object.keys(next.ideas).length > 0 ||
      Object.keys(next.followUps).length > 0 ||
      Object.keys(next.projects).some((id) => id !== INBOX_PROJECT_ID);
    if (hasContent) return true;
    if (!existsSync(this.backupPath)) return true;
    if (!this.readValidated(this.backupPath, () => {})) return true;
    this.logger.warn({
      action: 'dataStore:backup:kept',
      note: 'an empty dataset will not replace a readable backup',
    });
    return false;
  }

  /**
   * Parse a data file, or report why it could not be read.
   *
   * The caller falls back from data.json to the backup to emptyAppData(), and
   * the last of those renders an empty app. That is total, silent data
   * invisibility, so each fallback is named rather than swallowed: a dataset
   * that used to have ideas and now has none needs an explanation on disk.
   */
  private readValidated(path: string, onUnreadable: (reason: string) => void): AppData | null {
    if (!existsSync(path)) return null;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
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
