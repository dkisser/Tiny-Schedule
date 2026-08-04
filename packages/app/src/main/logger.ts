import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export function createLogger(logsDir: string): Logger {
  mkdirSync(logsDir, { recursive: true });
  return pino({
    level: 'info',
    transport: {
      target: 'pino-roll',
      options: {
        file: join(logsDir, 'app.log'),
        frequency: 'daily',
        size: '5M',
        limit: { count: 14 },
      },
    },
  });
}
