import { describe, expect, test } from 'bun:test';
import { addOneDay, formatCalendarTitle } from './calendar';

describe('formatCalendarTitle', () => {
  test('with project title', () => {
    expect(formatCalendarTitle('写周报', '工作')).toBe('[工作] 写周报');
  });
  test('without project title', () => {
    expect(formatCalendarTitle('写周报')).toBe('写周报');
  });
  test('empty project title falls back', () => {
    expect(formatCalendarTitle('写周报', '')).toBe('写周报');
  });
  test('with whitespace-only project title falls back', () => {
    expect(formatCalendarTitle('写周报', '   ')).toBe('写周报');
  });
});

describe('addOneDay', () => {
  test('simple date', () => {
    expect(addOneDay('2026-09-10')).toBe('2026-09-11');
  });
  test('crosses month boundary', () => {
    expect(addOneDay('2026-09-30')).toBe('2026-10-01');
  });
  test('crosses year boundary', () => {
    expect(addOneDay('2026-12-31')).toBe('2027-01-01');
  });
  test('leap day', () => {
    expect(addOneDay('2028-02-28')).toBe('2028-02-29');
  });
});
