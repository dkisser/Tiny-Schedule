/**
 * Date and duration helpers.
 *
 * The rules here are the plugin's single source of truth for "what day is it"
 * and "how long did that take". Dates compare as YYYY-MM-DD strings in local
 * time, exactly like the retired app's worklog export and projections.
 */

/** The local calendar day of an epoch-ms timestamp, as YYYY-MM-DD. */
export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** Add n days to a YYYY-MM-DD string, computed in local time. */
export function addDays(date: string, n: number): string {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n).getTime());
}

/** Today's local calendar day. */
export function today(now = Date.now()): string {
  return localDate(now);
}

/** Duration in the app's house format: `1h 30m`, `45m`. */
export function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

/** `2026-01-05` → `1月5日` style label, for compact UI rows. */
export function formatDay(day: string): string {
  const [, m = '', d = ''] = day.split('-');
  return `${Number(m)}月${Number(d)}日`;
}
