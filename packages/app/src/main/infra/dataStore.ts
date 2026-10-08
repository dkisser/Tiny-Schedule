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

  update(fn: (current: AppData) => AppData): AppData {
    const next = fn(this.get());
    this.save(next);
    return next;
  }

  save(data: AppData): void {
    if (this.primaryUnreadable) {
      // The flag is only ever cleared in load(), which runs once at startup,
      // so a user who repairs data.json by hand would still be locked out.
      // Re-read before refusing: if the file now yields a dataset, the
      // problem is gone and the write proceeds.
      const problems: string[] = [];
      if (this.readValidated(this.filePath, (r) => problems.push(r))) {
        this.logger.info({ action: 'dataStore:save:recovered', file: this.filePath });
        this.primaryUnreadable = null;
      } else {
        // Refuse rather than persist a degraded cache over the only good copy.
        // Without this, the first ordinary write — a settings change,
        // finishDay, the 30s heartbeat — rewrites data.json from a fallback
        // load and the second overwrites the backup, leaving nothing
        // recoverable. The data stays on disk exactly as the user left it.
        this.logger.error({
          action: 'dataStore:save:refused',
          reason: this.primaryUnreadable,
          file: this.filePath,
          note: 'not written; the unreadable data.json has been left in place',
        });
        return;
      }
    }
    // Cast: zod infers z.unknown() fields as optional in the parsed output type.
    const validated = AppDataSchema.parse(data) as AppData;
    if (existsSync(this.filePath)) {
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
