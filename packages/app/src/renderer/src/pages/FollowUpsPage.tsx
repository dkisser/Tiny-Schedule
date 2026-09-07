import { addDays, type FollowUp, localDate } from '@tiny-schedule/shared';
import { CheckCircle2, ChevronRight, Plus, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Input } from '../components/ui/input';
import {
  blankFollowUp,
  isFollowUpDue,
  openFollowUps,
  resolvedFollowUps,
  waitingDays,
} from '../lib/followUps';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';

function formatDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function FollowUpRow({ followUp }: { followUp: FollowUp }) {
  const upsertFollowUp = useDataStore((s) => s.upsertFollowUp);
  const selectFollowUp = useUiStore((s) => s.selectFollowUp);
  const selected = useUiStore((s) => s.selectedFollowUpId === followUp.id);
  const due = isFollowUpDue(followUp);
  const postpone = (days: number) => {
    void upsertFollowUp({
      ...followUp,
      nextFollowUpDay: addDays(localDate(Date.now()), days),
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectFollowUp(selected ? null : followUp.id)}
      onKeyDown={(e) => e.key === 'Enter' && selectFollowUp(selected ? null : followUp.id)}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 cursor-pointer',
        selected && 'ring-2 ring-ring',
        due && !selected && 'border-amber-400/60',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{followUp.title}</div>
        <div className="mt-0.5 flex gap-1">
          <span className="rounded bg-secondary px-1.5 text-xs text-muted-foreground">
            已等待 {waitingDays(followUp)} 天
          </span>
          {followUp.nextFollowUpDay && (
            <span
              className={cn(
                'rounded px-1.5 text-xs font-medium',
                due
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-secondary text-muted-foreground',
              )}
            >
              {due ? '跟进已到期' : '下次跟进'} {formatDay(followUp.nextFollowUpDay)}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            postpone(3);
          }}
        >
          +3天
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            postpone(7);
          }}
        >
          +7天
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            void upsertFollowUp({ ...followUp, isResolved: true, resolvedAt: Date.now() });
          }}
        >
          <CheckCircle2 />
          办结
        </Button>
      </div>
    </div>
  );
}

export function FollowUpsPage() {
  const data = useDataStore((s) => s.data);
  const upsertFollowUp = useDataStore((s) => s.upsertFollowUp);
  const selectFollowUp = useUiStore((s) => s.selectFollowUp);
  const selectedFollowUpId = useUiStore((s) => s.selectedFollowUpId);
  const [draft, setDraft] = useState('');
  if (!data) return null;

  const open = openFollowUps(data);
  const resolved = resolvedFollowUps(data);

  const create = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    await upsertFollowUp(blankFollowUp(title));
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">跟进</h1>
      <div className="mt-4 flex gap-2">
        <Input
          value={draft}
          placeholder="新建跟进事项（如 ICP 审核），回车确认"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
        />
        <Button variant="outline" disabled={!draft.trim()} onClick={() => void create()}>
          <Plus />
          新建
        </Button>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {open.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无跟进中的事项</div>
        ) : (
          open.map((f) => <FollowUpRow key={f.id} followUp={f} />)
        )}
      </div>
      {resolved.length > 0 && (
        <Collapsible className="mt-4">
          <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-md px-1 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
            已办结（{resolved.length}）
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 flex flex-col gap-2">
              {resolved.map((f) => (
                <div
                  key={f.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectFollowUp(selectedFollowUpId === f.id ? null : f.id)}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && selectFollowUp(selectedFollowUpId === f.id ? null : f.id)
                  }
                  className={cn(
                    'group relative flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 cursor-pointer',
                    selectedFollowUpId === f.id && 'ring-2 ring-ring',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-muted-foreground">{f.title}</div>
                    {f.resolvedAt !== undefined && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        办结于 {formatDay(localDate(f.resolvedAt))}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      void upsertFollowUp({ ...f, isResolved: false, resolvedAt: undefined });
                    }}
                  >
                    <RotateCcw />
                    恢复
                  </Button>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
