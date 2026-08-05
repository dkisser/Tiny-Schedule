import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../logger';

describe('createLogger', () => {
  test('writes NDJSON lines to file in logs dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tslog-'));
    const logger = createLogger(dir);
    logger.info({ action: 'app:start' }, 'started');
    logger.info({ action: 'timer:start', taskId: 't1' });
    // pino with file transport writes async; give it a moment
    await new Promise((r) => setTimeout(r, 500));
    const files = readdirSync(dir).filter((f) => f.startsWith('app'));
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(join(dir, files[0] as string), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(lines[0] as string);
    expect(first.action).toBe('app:start');
    expect(first.level).toBe(30);
    expect(typeof first.time).toBe('number');
  });
});
