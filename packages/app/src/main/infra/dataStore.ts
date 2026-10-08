import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type AppData,
  AppDataSchema,
  emptyAppData,
  type Idea,
  IdeaSchema,
} from '@tiny-schedule/shared';
import type { Logger } from 'pino';

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
   */
  update(fn: (current: AppData) => AppData): AppData {
    let base = this.get();
    if (this.primaryUnreadable) {
      const recovered = this.tryRecover();
      if (!recovered) {
        // get() here is the degraded cache; do not run the mutation against it.
        this.refuse();
        return base;
      }
      base = recovered;
    }
    const next = fn(base);
    this.save(next);
    return next;
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
      const backup = this.readValidated(this.backupPath, () => {});
      this.cache = backup ?? emptyAppData();
      this.primaryUnreadable = null;
      this.refusalReported = false;
      this.logger.warn({
        action: 'dataStore:save:file-removed',
        previousReason,
        file: this.filePath,
        adopted: backup ? 'backup' : 'empty',
      });
      return this.cache;
    }
    const recovered = this.readValidated(this.filePath, () => {});
    if (!recovered) return null;
    // Adopt it. Clearing the latch while leaving the stale fallback in `cache`
    // is what made the next write overwrite the repaired file. No recursion
    // guard is needed: nothing on this path can reach save().
    this.cache = recovered;
    this.primaryUnreadable = null;
    this.refusalReported = false;
    this.logger.info({ action: 'dataStore:save:recovered', file: this.filePath });
    return recovered;
  }

  /**
   * Whether the outgoing data.json may become the backup.
   *
   * The rotation is what makes a corrupt file survivable, so it is also the
   * step that can destroy the last good copy. An empty dataset is the one case
   * where rotating is never a gain: an app that is about to write nothing must
   * not demote a backup that still holds the user's tasks.
   */
  private safeToRotate(next: AppData): boolean {
    const isEmpty =
      Object.keys(next.tasks).length === 0 &&
      Object.keys(next.projects).length === 0 &&
      Object.keys(next.followUps).length === 0 &&
      Object.keys(next.ideas).length === 0;
    if (!isEmpty) return true;
    if (!existsSync(this.backupPath)) return true;
    if (!this.readValidated(this.backupPath, () => {})) return true;
    this.logger.warn({
      action: 'dataStore:backup:kept',
      note: 'an empty dataset will not replace a readable backup',
    });
    return false;
  }

  save(data: AppData): void {
    if (this.primaryUnreadable) {
      // Refuse rather than persist a degraded cache over the only good copy.
      // Without this, the first ordinary write — a settings change,
      // finishDay, the 30s heartbeat — rewrites data.json from a fallback
      // load and the second overwrites the backup, leaving nothing
      // recoverable. The data stays on disk exactly as the user left it.
      this.refuse();
      return;
    }
    // Cast: zod infers z.unknown() fields as optional in the parsed output type.
    const validated = AppDataSchema.parse(data) as AppData;
    if (existsSync(this.filePath) && this.safeToRotate(validated)) {
      copyFileSync(this.filePath, this.backupPath);
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(validated), 'utf8');
    renameSync(tmp, this.filePath); // atomic on POSIX
    this.cache = validated;
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
