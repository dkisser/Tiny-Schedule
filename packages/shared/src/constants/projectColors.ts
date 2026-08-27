/**
 * Curated 8-color project palette used by the Sidebar's project color picker.
 *
 * Design constraints:
 * - OKLCH values, L held in 0.55–0.62 so colors read against both the light
 *   `bg-card` (oklch 1) and the dark `bg-card` (oklch 0.205).
 * - Chroma capped at 0.150 to keep tones muted and avoid clashing with the
 *   existing status colors (active pink, overdue amber, done emerald).
 * - Hues spaced ~35–40° apart and positioned to dodge the four chromatic
 *   anchors already in the design system:
 *     - destructive red (hue ~27)
 *     - overdue amber (hue ~70)
 *     - done emerald (hue ~162)
 *     - active pink (hue ~343)
 *
 * The first slot (warm orange, hue 40) is intentionally close to amber and
 * destructive, but the 3px stripe width keeps it from being mistaken for a
 * status indicator.
 */
export const PROJECT_COLORS: readonly string[] = [
  'oklch(0.62 0.150 40)', // warm orange
  'oklch(0.58 0.140 100)', // leaf green
  'oklch(0.58 0.130 140)', // spring green
  'oklch(0.58 0.130 175)', // teal
  'oklch(0.56 0.140 220)', // sky blue
  'oklch(0.55 0.150 265)', // indigo
  'oklch(0.58 0.145 305)', // violet
  'oklch(0.60 0.135 325)', // rose
] as const;

/**
 * Guard that returns true when a project has a non-empty primaryColor.
 * Used by TaskCard and the sidebar to decide whether to render the stripe /
 * swatch. The model already accepts null and undefined as "unset"; we also
 * treat the empty string as unset for defensive cleanliness against legacy
 * or corrupted data.
 */
export function hasProjectColor(primaryColor: string | null | undefined): primaryColor is string {
  return typeof primaryColor === 'string' && primaryColor.length > 0;
}
