import { describe, expect, test } from 'bun:test';

type ProcessLike = Pick<NodeJS.Process, 'platform'>;

describe('isMacOS', () => {
  test('returns true on darwin', async () => {
    const original = globalThis.process;
    Object.defineProperty(globalThis, 'process', {
      value: { platform: 'darwin' } as ProcessLike,
      writable: true,
      configurable: true,
    });
    try {
      const mod = await import('./platform');
      expect(mod.isMacOS()).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'process', {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  test('returns false on win32', async () => {
    const original = globalThis.process;
    Object.defineProperty(globalThis, 'process', {
      value: { platform: 'win32' } as ProcessLike,
      writable: true,
      configurable: true,
    });
    try {
      const mod = await import('./platform');
      expect(mod.isMacOS()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'process', {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });
});
