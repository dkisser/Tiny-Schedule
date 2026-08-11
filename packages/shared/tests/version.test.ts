import { describe, expect, test } from 'bun:test';
import { compareSemver, normalizeVersion } from '../src/version';

describe('normalizeVersion', () => {
  test('strips leading v', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('V2.0.0')).toBe('2.0.0');
  });
  test('leaves plain versions untouched', () => {
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
  });
});

describe('compareSemver', () => {
  test('numeric segment comparison beats string order', () => {
    expect(compareSemver('0.1.10', '0.1.9')).toBe(1);
    expect(compareSemver('0.1.9', '0.1.10')).toBe(-1);
  });
  test('treats v prefix as equivalent', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
  });
  test('equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });
  test('orders across segments', () => {
    expect(compareSemver('1.2.3', '1.3.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
  });
  test('shorter version is older when prefix matches', () => {
    expect(compareSemver('1.2', '1.2.1')).toBe(-1);
    expect(compareSemver('1.2.1', '1.2')).toBe(1);
  });
});
