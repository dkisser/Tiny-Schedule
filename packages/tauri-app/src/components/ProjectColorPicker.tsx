import { hasProjectColor, PROJECT_COLORS } from '@tiny-schedule/shared';
import { Ban } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

const isPaletteColor = (c: string | null | undefined): boolean =>
  typeof c === 'string' && (PROJECT_COLORS as readonly string[]).includes(c);

/**
 * Validate a free-form color string. Accepts:
 *   - 3- or 6-digit hex (#abc / #aabbcc), case-insensitive
 *   - rgb()/rgba() functional notation
 *   - oklch()/oklab() functional notation (any sane whitespace/separator)
 *
 * Returns the trimmed string when valid, `null` otherwise. The format is
 * passed through unchanged so the CSS layer can consume it directly.
 */
function validateColor(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^#[0-9a-f]{3}$/i.test(v)) return v;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{8}$/i.test(v)) return v; // #rrggbbaa
  if (/^rgba?\([\s\d.,%/]+\)$/i.test(v)) return v;
  if (/^oklch\([\s\d.,%/]+\)$/i.test(v)) return v;
  if (/^oklab\([\s\d.,%/]+\)$/i.test(v)) return v;
  return null;
}

/**
 * Sidebar popover for assigning a primaryColor (or clearing it) to a project.
 *
 * Two affordances, used independently:
 *   1. 3×3 grid of curated OKLCH swatches + a "None" tile for fast choices
 *      that keep the day-view legible across users.
 *   2. A text input below the grid for power users who need an exact brand
 *      color. Accepts `#hex`, `rgb()`, or `oklch()` notation; valid input is
 *      committed on Enter (and on blur if already valid).
 *
 * The popover closes after each commit — pickers are atomic. When reopened,
 * the input resets to the current value (or empty when the current value is a
 * palette color, to invite the user into the curated set).
 */
export function ProjectColorPicker({
  projectId,
  currentColor,
  children,
}: {
  projectId: string;
  currentColor: string | null | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  const updateProject = useDataStore((s) => s.updateProject);

  // Reset input whenever the popover opens so stale drafts from the previous
  // session don't leak in.
  useEffect(() => {
    if (!open) return;
    setError(false);
    setText(isPaletteColor(currentColor) || !hasProjectColor(currentColor) ? '' : currentColor);
  }, [open, currentColor]);

  const commit = (next: string | null) => {
    if (next === currentColor) {
      setOpen(false);
      return;
    }
    void updateProject(projectId, { primaryColor: next }).then(() => setOpen(false));
  };

  const submitText = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const valid = validateColor(trimmed);
    if (valid) {
      setError(false);
      commit(valid);
    } else {
      setError(true);
    }
  };

  // Show a small swatch next to the input only when the current color isn't
  // one of the curated palette slots — otherwise it would just echo a swatch
  // the grid already shows.
  const showCustomSwatch = hasProjectColor(currentColor) && !isPaletteColor(currentColor);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-auto p-3"
        // Prevent click-through into the sidebar nav when interacting with the grid.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2.5">
          <div className="grid grid-cols-3 gap-2">
            {PROJECT_COLORS.map((color) => {
              const selected = currentColor === color;
              return (
                <button
                  key={color}
                  type="button"
                  aria-label={`选择颜色 ${color}`}
                  aria-pressed={selected}
                  onClick={() => commit(color)}
                  className={cn(
                    'relative h-7 w-7 rounded-full border border-border transition-transform',
                    'hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                    selected && 'ring-2 ring-foreground ring-offset-1 ring-offset-popover',
                  )}
                  style={{ backgroundColor: color }}
                />
              );
            })}
            <button
              type="button"
              aria-label="无颜色"
              aria-pressed={!hasProjectColor(currentColor)}
              onClick={() => commit(null)}
              className={cn(
                'relative flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-border bg-background text-muted-foreground transition-transform',
                'hover:scale-110 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                !hasProjectColor(currentColor) &&
                  'ring-2 ring-foreground ring-offset-1 ring-offset-popover',
              )}
            >
              <Ban className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            {showCustomSwatch && (
              <span
                aria-hidden
                className="h-5 w-5 shrink-0 rounded border border-border"
                style={{ backgroundColor: currentColor as string }}
              />
            )}
            <Input
              type="text"
              value={text}
              spellCheck={false}
              autoComplete="off"
              aria-label="自定义颜色（hex、rgb 或 oklch）"
              aria-invalid={error}
              placeholder="#000000 / rgb() / oklch()"
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Stop Enter from bubbling up to the parent NavItem, which
                  // would treat it as a route-navigation keystroke.
                  e.preventDefault();
                  e.stopPropagation();
                  submitText();
                }
              }}
              onBlur={() => {
                if (text.trim()) submitText();
              }}
              className={cn(
                'h-7 px-2 font-mono text-xs',
                error && 'border-destructive focus-visible:ring-destructive',
              )}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
