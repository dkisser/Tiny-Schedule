/** Strip a leading `v` from a release tag, e.g. "v1.2.3" -> "1.2.3". */
export function normalizeVersion(tag: string): string {
  return tag.replace(/^v/i, '');
}

/**
 * Compare two semver-ish versions segment by segment as numbers, so
 * "0.1.10" > "0.1.9" (string comparison would get this wrong).
 * Returns 1 / -1 / 0. Non-numeric segments fall back to string comparison.
 */
export function compareSemver(a: string, b: string): 1 | -1 | 0 {
  const pa = normalizeVersion(a).split('.').map(Number);
  const pb = normalizeVersion(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const s = String(x).localeCompare(String(y));
      if (s !== 0) return s > 0 ? 1 : -1;
      continue;
    }
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
