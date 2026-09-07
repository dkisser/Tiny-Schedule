import { type Idea, INBOX_PROJECT_ID, localDate } from '@tiny-schedule/shared';
import { ChevronRight, ListPlus, Plus, SquareArrowOutUpRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Input } from '../components/ui/input';
import { blankIdea, convertedIdeas, ideaToTask, openIdeas } from '../lib/ideas';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';

function formatDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function IdeaRow({ idea }: { idea: Idea }) {
  const data = useDataStore((s) => s.data);
  const upsertTask = useDataStore((s) => s.upsertTask);
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const selectIdea = useUiStore((s) => s.selectIdea);
  const selected = useUiStore((s) => s.selectedIdeaId === idea.id);

  const convert = async () => {
    const inbox = data?.projects[INBOX_PROJECT_ID];
    if (!inbox) return;
    const { task, converted } = ideaToTask(idea, inbox);
    await upsertTask(task);
    await upsertIdea(converted);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectIdea(selected ? null : idea.id)}
      onKeyDown={(e) => e.key === 'Enter' && selectIdea(selected ? null : idea.id)}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 cursor-pointer',
        selected && 'ring-2 ring-ring',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{idea.title}</div>
        <div className="mt-0.5 flex gap-1">
          <span className="rounded bg-secondary px-1.5 text-xs text-muted-foreground">
            记录于 {formatDay(localDate(idea.createdAt))}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            void convert();
          }}
        >
          <ListPlus />
          转为任务
        </Button>
      </div>
    </div>
  );
}

function ConvertedIdeaRow({ idea }: { idea: Idea }) {
  const data = useDataStore((s) => s.data);
  const selectIdea = useUiStore((s) => s.selectIdea);
  const setView = useUiStore((s) => s.setView);
  const selectTask = useUiStore((s) => s.selectTask);
  const selected = useUiStore((s) => s.selectedIdeaId === idea.id);
  const task = idea.convertedTaskId ? data?.tasks[idea.convertedTaskId] : undefined;

  const openTask = () => {
    if (!task) return;
    setView({ type: 'project', id: task.projectId });
    selectTask(task.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectIdea(selected ? null : idea.id)}
      onKeyDown={(e) => e.key === 'Enter' && selectIdea(selected ? null : idea.id)}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 cursor-pointer',
        selected && 'ring-2 ring-ring',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-muted-foreground">{idea.title}</div>
        {idea.convertedAt !== undefined && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            转化于 {formatDay(localDate(idea.convertedAt))}
          </div>
        )}
      </div>
      {task && (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            openTask();
          }}
        >
          <SquareArrowOutUpRight />
          打开任务
        </Button>
      )}
    </div>
  );
}

export function IdeasPage() {
  const data = useDataStore((s) => s.data);
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const [draft, setDraft] = useState('');
  if (!data) return null;

  const open = openIdeas(data);
  const converted = convertedIdeas(data);

  const create = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    await upsertIdea(blankIdea(title));
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">想法</h1>
      <div className="mt-4 flex gap-2">
        <Input
          value={draft}
          placeholder="记录一个想法，回车保存"
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
          <div className="text-sm text-muted-foreground">暂无待转化的想法</div>
        ) : (
          open.map((i) => <IdeaRow key={i.id} idea={i} />)
        )}
      </div>
      {converted.length > 0 && (
        <Collapsible className="mt-4">
          <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-md px-1 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
            已转化（{converted.length}）
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 flex flex-col gap-2">
              {converted.map((i) => (
                <ConvertedIdeaRow key={i.id} idea={i} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
