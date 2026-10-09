import { describe, expect, mock, test } from 'bun:test';
import * as realOs from '@tauri-apps/plugin-os';

/**
 * `isMacOS` gates the calendar button, and its first implementation returned
 * `false` on macOS itself — both of its guesses (node's `process.platform`,
 * `navigator.userAgentData`) miss inside a WKWebView. These tests therefore
 * pin the *source of truth*: the platform the host reports, not an
 * environment heuristic.
 *
 * `osType()` is stubbed rather than a global mutated, because it is the host
 * that answers the question; stubbing anything else would let the test pass
 * against the old, broken implementation.
 */

/** What `@tauri-apps/plugin-os` will report; `null` means "no host at all". */
let osTypeValue: string | null = 'macos';

mock.module('@tauri-apps/plugin-os', () => ({
  ...realOs,
  type: () => {
    if (osTypeValue === null) throw new Error('no Tauri host injected');
    return osTypeValue as ReturnType<typeof realOs.type>;
  },
}));

const { isMacOS } = await import('./platform');

describe('isMacOS', () => {
  test('returns true when the host reports macos', () => {
    osTypeValue = 'macos';
    expect(isMacOS()).toBe(true);
  });

  test('returns false on windows', () => {
    osTypeValue = 'windows';
    expect(isMacOS()).toBe(false);
  });

  test('returns false on linux', () => {
    osTypeValue = 'linux';
    expect(isMacOS()).toBe(false);
  });

  test('returns false rather than throwing outside a Tauri host', () => {
    // A browser, or any host-less context. The button staying hidden is the
    // safe direction; throwing here would take the whole task panel down.
    osTypeValue = null;
    expect(isMacOS()).toBe(false);
  });

  test('does not consult node process.platform', () => {
    // The regression that shipped: the old implementation keyed off
    // `process.platform`, which in a WKWebView is absent.
    //
    // The conflict between host and platform is *constructed*, never assumed.
    // Asserting `process.platform === 'darwin'` here would say nothing about
    // this code — it would only make the test unrunnable on any non-Mac
    // machine, which is where it failed in CI. Instead both directions are
    // driven from the host stub: a Mac running the tests must still answer
    // false when the host says windows, and Linux must still answer true when
    // it says macos. Passing on either platform then means the host decides.
    osTypeValue = 'windows';
    expect(isMacOS()).toBe(false);

    osTypeValue = 'macos';
    expect(isMacOS()).toBe(true);
  });
});
