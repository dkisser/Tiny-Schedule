import type { ScheduledTaskRun } from '@tiny-schedule/shared';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  formatDuration,
  formatTimestamp,
  RUN_STATUS_LABELS,
  RUN_STATUS_TONES,
  RUN_TRIGGER_LABELS,
  runDurationMs,
} from '@/lib/scheduledTasks';
import { cn } from '@/lib/utils';
import { useDataStore } from '@/stores/data';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

/**
 * 一次运行的输出与工具调用。
 *
 * 排版上刻意区分两种内容：输出是 Agent 写的自然语言，工具调用是机器记的审计。
 * ADR-0008 说全部工具默认开放、运行的记录是唯一的追溯手段，所以工具调用一条不少
 * 地列出来——参数与结果只显示摘要（完整内容可能含凭据与整份文件），id 与耗时一起
 * 给出，方便对着别处的日志核。
 *
 * 还在跑的那一条要单独说两句：输出与工具调用都随终态一次写全，所以运行中它们必然是
 * 空的。空数组在终态意味着"这次没调工具"，在运行中意味着"还没写"——写成同一句话就
 * 是在骗人，而这里说的每一句都是用户据以判断"这次到底发生了什么"的依据。
 */
function RunAudit({ run }: { run: ScheduledTaskRun }) {
  const running = run.status === 'running';
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div>
        <div className="text-xs font-medium text-muted-foreground">输出</div>
        {run.output ? (
          <pre className="mt-1 max-h-48 overflow-y-auto rounded-md bg-secondary/60 p-2 text-xs whitespace-pre-wrap break-words">
            {run.output}
          </pre>
        ) : (
          <div className="mt-1 text-xs text-muted-foreground">
            {run.status === 'skipped'
              ? '已跳过，没有执行，也没有输出。'
              : running
                ? '运行中，还没有输出。'
                : '没有输出。'}
          </div>
        )}
      </div>
      {run.error && (
        <div>
          <div className="text-xs font-medium text-muted-foreground">错误</div>
          <pre className="mt-1 max-h-32 overflow-y-auto rounded-md bg-destructive/10 p-2 text-xs whitespace-pre-wrap break-words text-destructive">
            {run.error}
          </pre>
        </div>
      )}
      <div>
        <div className="text-xs font-medium text-muted-foreground">
          工具调用（{run.toolCalls.length}）
        </div>
        {running ? (
          <div className="mt-1 text-xs text-muted-foreground">
            运行中，工具调用还没有写下来：审计随这次运行的终态一次写全（ADR-0008）。
          </div>
        ) : run.toolCalls.length === 0 ? (
          <div className="mt-1 text-xs text-muted-foreground">本次运行没有调用任何工具。</div>
        ) : (
          <ol className="mt-1 flex flex-col gap-1">
            {run.toolCalls.map((call) => (
              <li key={call.id} className="rounded-md border border-border px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium">{call.toolName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDuration(call.durationMs)}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{call.target}</div>
                {call.argsSummary && (
                  <pre className="mt-1 max-h-24 overflow-y-auto rounded bg-secondary/60 p-1.5 text-xs whitespace-pre-wrap break-words">
                    {call.argsSummary}
                  </pre>
                )}
                {call.resultSummary && (
                  <pre className="mt-1 max-h-24 overflow-y-auto rounded bg-secondary/60 p-1.5 text-xs whitespace-pre-wrap break-words text-muted-foreground">
                    {call.resultSummary}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function RunItem({ run }: { run: ScheduledTaskRun }) {
  const [open, setOpen] = useState(false);
  const duration = runDurationMs(run);
  const running = run.status === 'running';
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-accent/50">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {/* 转圈本身就是"还没结束"这句话：一条 running 记录会在界面上停很久，用户
            需要一眼看出它还活着，而不是以为界面卡住了。 */}
        {running && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />}
        <span
          className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs', RUN_STATUS_TONES[run.status])}
        >
          {RUN_STATUS_LABELS[run.status]}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {RUN_TRIGGER_LABELS[run.trigger]}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {formatTimestamp(run.startedAt)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {duration === null ? '进行中' : formatDuration(duration)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <RunAudit run={run} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 定时任务的运行历史：最新一次在前，每次运行可展开看输出与工具调用审计。
 *
 * 历史只在这里查——运行记录不进 AppData（它只会一直增长），所以这是一个按任务
 * 发起的查询，`refreshToken` 变化时重新拉取。刷新的时机是运行开始与结束各一次
 * （`stores/ui.ts` 的 runsRevision，由 `bootstrap.ts` 订阅运行事件后 bump），所以
 * 手动与定时触发都是"点下去就看见运行中，结束就变成终态"。
 */
export function RunHistory({
  scheduledTaskId,
  refreshToken,
}: {
  scheduledTaskId: string;
  refreshToken: number;
}) {
  const listScheduledTaskRuns = useDataStore((s) => s.listScheduledTaskRuns);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listScheduledTaskRuns(scheduledTaskId)
      .then((next) => {
        if (!cancelled) setRuns(next);
      })
      .catch(() => {
        // 一次读不到历史不等于这个定时任务坏了，所以只说明这次没读到，不改写任何
        // 关于它本身的状态。
        if (!cancelled) setError('运行历史读取失败，可稍后重试。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scheduledTaskId, refreshToken, listScheduledTaskRuns]);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        正在读取运行历史…
      </div>
    );
  }
  if (error) return <div className="text-xs text-destructive">{error}</div>;
  if (runs.length === 0) {
    return <div className="text-xs text-muted-foreground">还没有运行记录。</div>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {runs.map((run) => (
        <RunItem key={run.id} run={run} />
      ))}
    </div>
  );
}
