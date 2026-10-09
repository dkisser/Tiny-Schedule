import { type Idea, localDate } from '@tiny-schedule/shared';
import {
  Ban,
  Check,
  ChevronRight,
  FlaskConical,
  ListPlus,
  Plus,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Input } from '../components/ui/input';
import {
  blankIdea,
  completeIdea,
  discardIdea,
  ideaPendingVerdict,
  ideaProjectOpenTaskCount,
  incubatingIdeas,
  openIdeas,
  resolvedIdeas,
} from '../lib/ideas';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';

function formatDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function useIdeaRow(idea: Idea) {
  const selectIdea = useUiStore((s) => s.selectIdea);
  const selected = useUiStore((s) => s.selectedIdeaId === idea.id);
  return {
    selected,
    rowProps: {
      role: 'button' as const,
      tabIndex: 0,
      onClick: () => selectIdea(selected ? null : idea.id),
      onKeyDown: (e: React.KeyboardEvent) =>
        e.key === 'Enter' && selectIdea(selected ? null : idea.id),
      className: cn(
        'group relative flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 cursor-pointer',
        selected && 'ring-2 ring-ring',
      ),
    },
  };
}

// 收集箱行：整行点击选中；hover 只放轻操作（完成/废弃），转任务与升级在详情面板。
function OpenIdeaRow({ idea }: { idea: Idea }) {
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const { rowProps } = useIdeaRow(idea);

  return (
    <div {...rowProps}>
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
            void upsertIdea(completeIdea(idea));
          }}
        >
          <Check />
          完成
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            void upsertIdea(discardIdea(idea));
          }}
        >
          <Ban />
          废弃
        </Button>
      </div>
    </div>
  );
}

// 验证中区行：标题 + 关联项目名 + 项目未完成任务数；待结论的加标识。
function IncubatingIdeaRow({ idea }: { idea: Idea }) {
  const data = useDataStore((s) => s.data);
  const { rowProps } = useIdeaRow(idea);
  const project = idea.projectId ? data?.projects[idea.projectId] : undefined;
  const openTaskCount = idea.projectId && data ? ideaProjectOpenTaskCount(data, idea.projectId) : 0;
  const pending = data ? ideaPendingVerdict(idea, data) : false;

  return (
    <div {...rowProps}>
      <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{idea.title}</div>
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate">
            {project ? `${project.title} · ${openTaskCount} 个未完成任务` : '关联项目不可用'}
          </span>
          {pending && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 text-amber-600 dark:text-amber-400">
              待结论
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function VerdictBadge({ idea }: { idea: Idea }) {
  if (idea.status !== 'closed' || !idea.verdict) return null;
  const label =
    idea.verdict.result === 'validated'
      ? '已验证'
      : idea.verdict.result === 'invalidated'
        ? '未验证'
        : '部分验证';
  return <span className="rounded bg-secondary px-1.5 text-xs text-muted-foreground">{label}</span>;
}

// 已了结行：结局 badge；已转任务的保留"打开任务" hover 操作。
function ResolvedIdeaRow({ idea }: { idea: Idea }) {
  const data = useDataStore((s) => s.data);
  const setView = useUiStore((s) => s.setView);
  const selectTask = useUiStore((s) => s.selectTask);
  const { rowProps } = useIdeaRow(idea);
  const task = idea.convertedTaskId ? data?.tasks[idea.convertedTaskId] : undefined;

  const openTask = () => {
    if (!task) return;
    setView({ type: 'project', id: task.projectId });
    selectTask(task.id);
  };

  const resolvedLabel =
    idea.status === 'done'
      ? '已完成'
      : idea.status === 'discarded'
        ? '已废弃'
        : idea.status === 'converted'
          ? '已转任务'
          : null;
  const ResolvedIcon =
    idea.status === 'done' ? Check : idea.status === 'discarded' ? Ban : ListPlus;
  const resolvedAt = idea.resolvedAt ?? idea.convertedAt;

  return (
    <div {...rowProps}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-muted-foreground">{idea.title}</div>
        <div className="mt-0.5 flex items-center gap-1">
          {resolvedLabel && (
            <span className="flex items-center gap-0.5 rounded bg-secondary px-1.5 text-xs text-muted-foreground">
              <ResolvedIcon className="h-3 w-3" />
              {resolvedLabel}
            </span>
          )}
          <VerdictBadge idea={idea} />
          {resolvedAt !== undefined && (
            <span className="text-xs text-muted-foreground">
              {formatDay(localDate(resolvedAt))}
            </span>
          )}
        </div>
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

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="px-1 text-xs font-medium text-muted-foreground">
      {title}（{count}）
    </div>
  );
}

export function IdeasPage() {
  const data = useDataStore((s) => s.data);
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const [draft, setDraft] = useState('');
  if (!data) return null;

  const open = openIdeas(data);
  const incubating = incubatingIdeas(data);
  const resolved = resolvedIdeas(data);

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
          <div className="text-sm text-muted-foreground">收集箱是空的</div>
        ) : (
          open.map((i) => <OpenIdeaRow key={i.id} idea={i} />)
        )}
      </div>

      {incubating.length > 0 && (
        <div className="mt-6">
          <SectionHeader title="验证中" count={incubating.length} />
          <div className="mt-2 flex flex-col gap-2">
            {incubating.map((i) => (
              <IncubatingIdeaRow key={i.id} idea={i} />
            ))}
          </div>
        </div>
      )}

      {resolved.length > 0 && (
        <Collapsible className="mt-6">
          <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-md px-1 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
            已了结（{resolved.length}）
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 flex flex-col gap-2">
              {resolved.map((i) => (
                <ResolvedIdeaRow key={i.id} idea={i} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
