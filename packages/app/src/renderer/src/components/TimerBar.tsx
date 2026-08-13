import {
  computePhaseElapsed,
  INBOX_PROJECT_ID,
  isPomodoro,
  localDate,
  POMODORO_CYCLES_PER_SET,
} from '@tiny-schedule/shared';
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

function formatPomodoroClock(elapsedMs: number, durationMs: number): string {
  const remaining = Math.max(0, durationMs - elapsedMs);
  const total = Math.floor(remaining / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${`${m}`.padStart(2, '0')}:${`${sec}`.padStart(2, '0')}`;
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
      <Plus />
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
  const pomodoro = isPomodoro(timer);
  const phaseElapsed = pomodoro ? computePhaseElapsed(timer, now) : 0;
  const phaseDuration = timer.phaseDurationMs ?? 0;
  const phaseRemainingMs = pomodoro ? Math.max(0, phaseDuration - phaseElapsed) : 0;
  const progress = pomodoro && phaseDuration > 0 ? Math.min(1, phaseElapsed / phaseDuration) : 0;

  return (
    <>
      <div className="relative flex h-12 items-center gap-3 bg-pink-50 px-4 dark:bg-pink-950/40">
        {pomodoro && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 bg-pink-200/60 transition-[width] duration-500 ease-linear dark:bg-pink-900/40"
            style={{ width: `${progress * 100}%` }}
          />
        )}
        <div className="relative z-10 flex items-center gap-3">
          {timer.isPaused ? (
            <Button size="icon-sm" aria-label="继续" onClick={resume}>
              <Play />
            </Button>
          ) : (
            <Button size="icon-sm" aria-label="暂停" onClick={pause}>
              <Pause />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="destructive"
            aria-label="停止并结算"
            onClick={() => void stop()}
          >
            <Square />
          </Button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            {task?.title ?? timer.taskId}
          </div>
        </div>
        <div className="relative z-10 ml-auto flex shrink-0 items-center gap-3">
          {pomodoro && (
            <>
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                  timer.phase === 'break'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-pink-500/15 text-pink-600 dark:text-pink-400'
                }`}
              >
                {timer.phase === 'focus' ? '专注中' : '休息中'}
              </span>
              <span className="font-mono text-sm tabular-nums text-muted-foreground">
                {formatPomodoroClock(phaseElapsed, phaseDuration)}
              </span>
              <span className="text-xs text-muted-foreground">
                {(timer.cyclesCompleted ?? 0) + 1}/{POMODORO_CYCLES_PER_SET}
              </span>
            </>
          )}
          {timer.isPaused && timer.autoPausedBy && (
            <div className="shrink-0 text-xs text-muted-foreground">
              {timer.autoPausedBy === 'idle' ? '已因空闲自动暂停' : '已因睡眠自动暂停'}
            </div>
          )}
          <div className="font-mono text-base tabular-nums text-pink-600 dark:text-pink-400">
            {formatElapsed(elapsed)}
          </div>
          {task && task.timeEstimate > 0 && (
            <div className="text-xs text-muted-foreground">
              / {formatElapsed(task.timeEstimate)}
            </div>
          )}
          {addButton}
        </div>
      </div>
      {dialog}
    </>
  );
}
