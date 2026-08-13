import type { AppData, Task } from '@tiny-schedule/shared';
import { Check, GripVertical, Pause, Play, Trash2 } from 'lucide-react';
import type { DragControls } from 'motion/react';
import { useState } from 'react';
import { isOverdue, taskTagLabel } from '../lib/tasks';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';
import { useUiStore } from '../stores/ui';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { openStartModeToast } from './timer/StartTimerModeToast';
import { Button } from './ui/button';

function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function formatDoneAt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
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
        selected && (overdue ? 'ring-2 ring-amber-400/70' : 'ring-2 ring-ring'),
        active && 'border-pink-400 bg-pink-50 dark:bg-pink-950/30',
        overdue && !active && !selected && 'border-amber-400/60',
      )}
    >
      {dragControls && !task.isDone && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="拖动排序"
          onPointerDown={(e) => dragControls.start(e)}
          onClick={(e) => e.stopPropagation()}
          className="-ml-1 shrink-0 touch-none cursor-grab text-muted-foreground/40 transition-all duration-300 hover:text-muted-foreground hover:shadow-md active:cursor-grabbing"
        >
          <GripVertical />
        </Button>
      )}
      <button
        type="button"
        aria-label="完成"
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:text-foreground',
          task.isDone && 'border-primary bg-primary text-primary-foreground',
        )}
        onClick={(e) => {
          e.stopPropagation();
          void upsertTask({
            ...task,
            isDone: !task.isDone,
            doneAt: task.isDone ? undefined : Date.now(),
          });
        }}
      >
        <Check className="h-3 w-3" />
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={cn('truncate text-sm', task.isDone && 'line-through text-muted-foreground')}
        >
          {task.title}
        </div>
        <div className="mt-0.5 flex gap-1">
          {task.isDone && task.doneAt !== undefined && (
            <span className="rounded bg-emerald-500/15 px-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              完成于 {formatDoneAt(task.doneAt)}
            </span>
          )}
          {overdue && (
            <span className="rounded bg-amber-500/15 px-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              逾期 {overdueDays} 天
            </span>
          )}
          {task.tagIds.map((id) => {
            const label = taskTagLabel(task, data, id);
            return label ? (
              <span key={id} className="rounded bg-secondary px-1.5 text-xs text-muted-foreground">
                {label}
              </span>
            ) : null;
          })}
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
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="继续"
              className="text-pink-500"
              onClick={(e) => {
                e.stopPropagation();
                resumeTimer();
              }}
            >
              <Play />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="暂停"
              className="text-pink-500"
              onClick={(e) => {
                e.stopPropagation();
                pauseTimer();
              }}
            >
              <Pause />
            </Button>
          )
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="开始计时"
            className="hover:text-pink-500"
            onClick={(e) => {
              e.stopPropagation();
              openStartModeToast(task.id);
            }}
          >
            <Play />
          </Button>
        )}
        {/* A running timer must not be deleted out from under itself. */}
        {!active && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="删除"
            className="hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              if (task.timeSpent > 0 || task.timeEntries.length > 0) setConfirmDelete(true);
              else void deleteTask(task.id);
            }}
          >
            <Trash2 />
          </Button>
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
