import type { AppData, Task } from '@tiny-schedule/shared';
import { Check, GripVertical, Pause, Play, Trash2 } from 'lucide-react';
import type { DragControls } from 'motion/react';
import { useState } from 'react';
import { isOverdue } from '../lib/tasks';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';
import { useUiStore } from '../stores/ui';
import { DeleteTaskDialog } from './DeleteTaskDialog';

function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function TaskCard({
  task,
  data,
  active,
  dragControls,
}: {
  task: Task;
  data: AppData;
  active: boolean;
  dragControls?: DragControls;
}) {
  const selectTask = useUiStore((s) => s.selectTask);
  const selectedTaskId = useUiStore((s) => s.selectedTaskId);
  const upsertTask = useDataStore((s) => s.upsertTask);
  const deleteTask = useDataStore((s) => s.deleteTask);
  const startTimer = useTimerStore((s) => s.start);
  const pauseTimer = useTimerStore((s) => s.pause);
  const resumeTimer = useTimerStore((s) => s.resume);
  const timerPaused = useTimerStore((s) => (active ? (s.timer?.isPaused ?? false) : false));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = selectedTaskId === task.id;
  const overdue = isOverdue(task);
  const overdueDays = overdue
    ? Math.max(
        1,
        Math.round(
          (new Date(new Date().toDateString()).getTime() -
            new Date(`${task.dueDay}T00:00:00`).getTime()) /
            86_400_000,
        ),
      )
    : 0;

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
        overdue && !active && 'border-amber-400/60',
      )}
    >
      {dragControls && !task.isDone && (
        <button
          type="button"
          aria-label="拖动排序"
          onPointerDown={(e) => dragControls.start(e)}
          onClick={(e) => e.stopPropagation()}
          className="-ml-1 shrink-0 touch-none cursor-grab rounded p-0.5 text-muted-foreground/40 transition-all duration-300 hover:bg-accent/60 hover:text-muted-foreground hover:shadow-md active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
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
          {overdue && (
            <span className="rounded bg-amber-500/15 px-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              逾期 {overdueDays} 天
            </span>
          )}
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
      <div className={cn('flex shrink-0 gap-1', !active && 'opacity-0 group-hover:opacity-100')}>
        {active ? (
          timerPaused ? (
            <button
              type="button"
              aria-label="继续"
              className="text-pink-500"
              onClick={(e) => {
                e.stopPropagation();
                resumeTimer();
              }}
            >
              <Play className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="暂停"
              className="text-pink-500"
              onClick={(e) => {
                e.stopPropagation();
                pauseTimer();
              }}
            >
              <Pause className="h-4 w-4" />
            </button>
          )
        ) : (
          <button
            type="button"
            aria-label="开始计时"
            className="hover:text-pink-500"
            onClick={(e) => {
              e.stopPropagation();
              void startTimer(task.id);
            }}
          >
            <Play className="h-4 w-4" />
          </button>
        )}
        {/* A running timer must not be deleted out from under itself. */}
        {!active && (
          <button
            type="button"
            aria-label="删除"
            className="hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              if (task.timeSpent > 0 || task.timeEntries.length > 0) setConfirmDelete(true);
              else void deleteTask(task.id);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      <DeleteTaskDialog
        open={confirmDelete}
        title={task.title}
        timeSpent={task.timeSpent}
        onConfirm={() => void deleteTask(task.id)}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
