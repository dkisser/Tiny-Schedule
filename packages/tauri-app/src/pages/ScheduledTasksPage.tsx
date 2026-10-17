import type { ScheduledTask, ScheduledTaskRun } from '@tiny-schedule/shared';
import { CalendarClock, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { NewScheduledTaskDialog } from '../components/scheduledTasks/NewScheduledTaskDialog';
import { useLatestRuns } from '../components/scheduledTasks/useLatestRuns';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import {
  nextRunLabel,
  RUN_STATUS_LABELS,
  RUN_STATUS_TONES,
  RUN_TRIGGER_LABELS,
  scheduleSummary,
  sortedScheduledTasks,
} from '../lib/scheduledTasks';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';

/**
 * 一条定时任务：名称、频率摘要、下次触发、最近一次运行、启用开关。
 *
 * 「最近一次运行」来自运行历史而不是 AppData——运行记录不进数据集（它只会一直增长），
 * 所以由 `useLatestRuns` 按任务查。查不到与没有都显示成"还没有运行记录"：这一列的
 * 信息量就到此为止，要看清区别的地方是详情面板的运行历史。
 */
function ScheduledTaskRow({
  task,
  selected,
  lastRun,
  onOpen,
  onToggleEnabled,
}: {
  task: ScheduledTask;
  selected: boolean;
  lastRun: ScheduledTaskRun | null;
  onOpen: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5',
        selected && 'ring-2 ring-ring',
        task.enabled ? 'hover:border-ring/40' : 'opacity-60',
      )}
    >
      <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{task.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{scheduleSummary(task.schedule)}</span>
          <span>·</span>
          <span>
            {task.enabled
              ? `下次触发 ${nextRunLabel(task.schedule, Date.now())}`
              : '已停用，不再触发'}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {lastRun ? (
            <span className="flex items-center gap-1.5">
              {/* 还在跑的那一次转圈：列表页是用户最常待着的地方，"正在执行"这件事
                  必须在这里也一眼可见，否则只有开了详情的人才知道。 */}
              {lastRun.status === 'running' && (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              )}
              最近一次运行
              <span className={cn('rounded px-1.5 py-0.5', RUN_STATUS_TONES[lastRun.status])}>
                {RUN_STATUS_LABELS[lastRun.status]}
              </span>
              <span>（{RUN_TRIGGER_LABELS[lastRun.trigger]}）</span>
            </span>
          ) : (
            <span>还没有运行记录</span>
          )}
        </div>
      </div>
      <div
        className="flex shrink-0 items-center"
        // 开关是一个独立操作：点它不该顺手把详情面板也打开。
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Switch
          size="sm"
          checked={task.enabled}
          aria-label={`启用「${task.name}」`}
          onCheckedChange={onToggleEnabled}
        />
      </div>
    </div>
  );
}

export function ScheduledTasksPage() {
  const data = useDataStore((s) => s.data);
  const saveScheduledTask = useDataStore((s) => s.saveScheduledTask);
  const selectedScheduledTaskId = useUiStore((s) => s.selectedScheduledTaskId);
  const selectScheduledTask = useUiStore((s) => s.selectScheduledTask);
  const [creating, setCreating] = useState(false);
  const tasks = sortedScheduledTasks(Object.values(data?.scheduledTasks ?? {}), Date.now());
  const latestRuns = useLatestRuns(tasks.map((t) => t.id));
  if (!data) return null;

  // 建完直接打开详情面板：新任务的要点（执行目录、启用状态）都在那里，
  // 而停在列表上只会让人以为已经配完了。
  const onCreated = (scheduledTaskId: string) => selectScheduledTask(scheduledTaskId);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">定时任务</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        到点驱动 Agent 执行一段 prompt 的规则：prompt、频率、执行目录。
        与任务分开——任务是给人做的待办，定时任务是机器到点执行的规则。
      </p>
      <div className="mt-4">
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus />
          新建定时任务
        </Button>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {tasks.length === 0 ? (
          <div className="text-sm text-muted-foreground">还没有定时任务。</div>
        ) : (
          tasks.map((task) => (
            <ScheduledTaskRow
              key={task.id}
              task={task}
              selected={selectedScheduledTaskId === task.id}
              lastRun={latestRuns.get(task.id) ?? null}
              onOpen={() => selectScheduledTask(task.id)}
              onToggleEnabled={(enabled) => void saveScheduledTask(task, { enabled })}
            />
          ))
        )}
      </div>
      <NewScheduledTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={onCreated}
      />
    </div>
  );
}
