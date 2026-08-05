import type { AppData, Task } from '@tiny-schedule/shared';
import { Check, Play, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';
import { useUiStore } from '../stores/ui';

function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function TaskCard({ task, data, active }: { task: Task; data: AppData; active: boolean }) {
  const selectTask = useUiStore((s) => s.selectTask);
  const selectedTaskId = useUiStore((s) => s.selectedTaskId);
  const upsertTask = useDataStore((s) => s.upsertTask);
  const deleteTask = useDataStore((s) => s.deleteTask);
  const startTimer = useTimerStore((s) => s.start);
  const selected = selectedTaskId === task.id;

  return (
    // biome-ignore lint/a11y/useSemanticElements: card contains nested action buttons, cannot be a semantic <button>
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectTask(selected ? null : task.id)}
      onKeyDown={(e) => e.key === 'Enter' && selectTask(selected ? null : task.id)}
      className={cn(
        'group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 cursor-pointer',
        selected && 'ring-2 ring-ring',
        active && 'border-pink-400 bg-pink-50 dark:bg-pink-950/30',
      )}
    >
      <button
        type="button"
        aria-label="完成"
        className="text-muted-foreground hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          void upsertTask({
            ...task,
            isDone: !task.isDone,
            doneAt: task.isDone ? undefined : Date.now(),
          });
        }}
      >
        <Check
          className={cn(
            'h-4 w-4 rounded-full border p-0.5',
            task.isDone && 'bg-primary text-primary-foreground',
          )}
        />
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={cn('truncate text-sm', task.isDone && 'line-through text-muted-foreground')}
        >
          {task.title}
        </div>
        <div className="mt-0.5 flex gap-1">
          {task.tagIds.map(
            (id) =>
              data.tags[id] && (
                <span
                  key={id}
                  className="rounded bg-secondary px-1.5 text-xs text-muted-foreground"
                >
                  {data.tags[id]?.title}
                </span>
              ),
          )}
        </div>
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">
        {task.timeSpent > 0 && task.timeEstimate > 0
          ? `${formatMs(task.timeSpent)} / ${formatMs(task.timeEstimate)}`
          : task.timeSpent > 0
            ? formatMs(task.timeSpent)
            : task.timeEstimate > 0
              ? formatMs(task.timeEstimate)
              : ''}
      </div>
      <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
        <button
          type="button"
          aria-label="开始计时"
          className="hover:text-pink-500"
          onClick={(e) => {
            e.stopPropagation();
            startTimer(task.id);
          }}
        >
          <Play className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="删除"
          className="hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            void deleteTask(task.id);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
