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

export class DataStore {
  private cache: AppData | null = null;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private get filePath(): string {
    return join(this.dir, 'data.json');
  }

  private get backupPath(): string {
    return join(this.dir, 'data.backup.json');
  }

  load(): AppData {
    this.cache =
      this.readValidated(this.filePath) ?? this.readValidated(this.backupPath) ?? emptyAppData();
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

  private readValidated(path: string): AppData | null {
    if (!existsSync(path)) return null;
    try {
      return AppDataSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) as AppData;
    } catch {
      return null;
    }
  }
}
