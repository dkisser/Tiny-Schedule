export function isMacOS(): boolean {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'darwin';
  }
  if (typeof navigator !== 'undefined' && 'userAgentData' in navigator) {
    const ua = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    return ua.userAgentData?.platform === 'macOS';
  }
  return false;
}
