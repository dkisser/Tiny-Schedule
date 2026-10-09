import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

export interface ComboboxOption {
  id: string;
  title: string;
  color?: string;
  suffix?: string;
}

interface ComboboxProps {
  options: ComboboxOption[];
  placeholder?: string;
  display?: string;
  // single-select
  value?: string;
  onSelect?: (id: string) => void;
  // multi-select
  selectedIds?: string[];
  onToggle?: (id: string) => void;
}

export function Combobox({
  options,
  placeholder = '请选择',
  display,
  value,
  onSelect,
  selectedIds,
  onToggle,
}: ComboboxProps) {
  const multi = Array.isArray(selectedIds);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    inputRef.current?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.title.toLowerCase().includes(q)) : options;
  const current = options.find((o) => o.id === value);
  const label = display ?? current?.title ?? '';

  const pick = (id: string) => {
    if (multi) onToggle?.(id);
    else {
      onSelect?.(id);
      setOpen(false);
    }
    setQuery('');
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between rounded-md border border-input bg-background px-2 py-1.5 text-sm',
          !label && 'text-muted-foreground',
        )}
      >
        <span className="truncate">{label || placeholder}</span>
        <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-popover shadow-md">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={inputRef}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder="搜索…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && filtered.length === 1) pick(filtered[0]!.id);
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">无匹配项</div>
            )}
            {filtered.map((o) => {
              const checked = multi ? selectedIds.includes(o.id) : o.id === value;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => pick(o.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
                    checked && 'font-medium',
                  )}
                >
                  {multi && (
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-input',
                        checked && 'border-primary bg-primary text-primary-foreground',
                      )}
                    >
                      {checked && <Check className="h-2.5 w-2.5" />}
                    </span>
                  )}
                  {o.color && (
                    <span className="h-2 w-2 rounded-full" style={{ background: o.color }} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{o.title}</span>
                  {o.suffix && <span className="text-xs text-muted-foreground">{o.suffix}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
