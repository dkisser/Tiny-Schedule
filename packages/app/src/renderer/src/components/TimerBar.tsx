import { INBOX_PROJECT_ID, localDate } from '@tiny-schedule/shared';
import { Pause, Play, Plus, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useDataStore } from '../stores/data';
import { elapsedOf, useTimerStore } from '../stores/timer';
import { useUiStore } from '../stores/ui';
import { AddTaskDialog } from './AddTaskDialog';
import { Button } from './ui/button';

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${`${h}`.padStart(2, '0')}:${`${m}`.padStart(2, '0')}:${`${sec}`.padStart(2, '0')}`;
}

export function TimerBar() {
  const timer = useTimerStore((s) => s.timer);
  const now = useTimerStore((s) => s.now);
  const pause = useTimerStore((s) => s.pause);
  const resume = useTimerStore((s) => s.resume);
  const stop = useTimerStore((s) => s.stop);
  const data = useDataStore((s) => s.data);
  const view = useUiStore((s) => s.view);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => api().onNewTask(() => setCreateOpen(true)), []);

  const defaultProjectId = view.type === 'project' ? view.id : INBOX_PROJECT_ID;
  const defaultDueDay = view.type === 'today' ? localDate(Date.now()) : undefined;

  const addButton = (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="新建任务"
      onClick={() => setCreateOpen(true)}
    >
      <Plus className="h-4 w-4" />
    </Button>
  );

  const dialog = (
    <AddTaskDialog
      open={createOpen}
      onClose={() => setCreateOpen(false)}
      defaultProjectId={defaultProjectId}
      defaultDueDay={defaultDueDay}
    />
  );

  if (!timer || !data) {
    return (
      <>
        <div className="flex h-12 items-center px-4 text-sm text-muted-foreground">
          没有进行中的计时
          <div className="ml-auto">{addButton}</div>
        </div>
        {dialog}
      </>
    );
  }
  const task = data.tasks[timer.taskId];
  const elapsed = elapsedOf(timer, now);

  return (
    <>
      <div className="flex h-12 items-center gap-3 bg-pink-50 px-4 dark:bg-pink-950/40">
        {timer.isPaused ? (
          <Button size="icon" aria-label="继续" onClick={resume}>
            <Play className="h-5 w-5" />
          </Button>
        ) : (
          <Button size="icon" aria-label="暂停" onClick={pause}>
            <Pause className="h-5 w-5" />
          </Button>
        )}
        <Button
          size="icon"
          variant="destructive"
          aria-label="停止并结算"
          onClick={() => void stop()}
        >
          <Square className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">
          {task?.title ?? timer.taskId}
        </div>
        <div className="font-mono text-lg tabular-nums text-pink-600 dark:text-pink-400">
          {formatElapsed(elapsed)}
        </div>
        {task && task.timeEstimate > 0 && (
          <div className="text-xs text-muted-foreground">/ {formatElapsed(task.timeEstimate)}</div>
        )}
        {addButton}
      </div>
      {dialog}
    </>
  );
}
