#!/usr/bin/env node
/**
 * The migration command.
 *
 * Reads the retired app's `data.json` and writes the plugin's storage unit
 * into the harness's storage root. The old file is only ever read.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { migrateAppData, serializeUnit } from './fromAppData.ts';

const UNIT_NAME = 'task_tracker';

interface Options {
  from?: string;
  root: string;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    root: join(homedir(), '.dsh', 'storages'),
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') options.from = argv[++i] ?? undefined;
    else if (arg === '--root') options.root = argv[++i] ?? options.root;
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument '${arg}'`);
    }
  }
  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: dsh-plugin-tiny-schedule migrate --from <data.json> [options]',
      '',
      "  --from <path>   the retired app's data.json (read-only)",
      '  --root <dir>    the harness storage root (default: ~/.dsh/storages)',
      '  --force         overwrite an existing unit',
      '  --dry-run       report what would be migrated, write nothing',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.from === undefined) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const raw = JSON.parse(await readFile(options.from, 'utf8')) as unknown;
  const { unit, stats } = migrateAppData(raw);
  const target = join(options.root, `${UNIT_NAME}.json`);

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ target, stats }, null, 2)}\n`);
    return;
  }

  let existing: { size: number } | undefined;
  try {
    existing = await stat(target);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined && !options.force) {
    throw new Error(`${target} already exists; pass --force to overwrite it`);
  }

  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, serializeUnit(unit), { mode: 0o600 });
  await rename(temporary, target);

  process.stdout.write(
    [
      `Migrated into ${target}`,
      `  tasks      ${stats.tasks}`,
      `  projects   ${stats.projects}`,
      `  tags       ${stats.tags}`,
      `  ideas      ${stats.ideas}`,
      `  follow-ups ${stats.followUps}`,
      `  time rows  ${stats.timeEntries}`,
      `  dropped    ${
        Object.entries(stats.dropped)
          .map(([k, v]) => `${k} (${v} bytes)`)
          .join(', ') || 'nothing'
      }`,
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
