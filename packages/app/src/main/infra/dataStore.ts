import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type AppData, AppDataSchema, emptyAppData } from '@tiny-schedule/shared';
import type { Logger } from 'pino';

export class DataStore {
  private cache: AppData | null = null;

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
    if (!result.success) {
      onUnreadable(`schema mismatch: ${result.error.issues[0]?.path.join('.') ?? '(unknown)'}`);
      return null;
    }
    return result.data as AppData;
  }
}
