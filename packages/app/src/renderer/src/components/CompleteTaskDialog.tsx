import { isPomodoro, POMODORO_CYCLES_PER_SET, settleTimer } from '@tiny-schedule/shared';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';
import { useUiStore } from '../stores/ui';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${`${h}`.padStart(2, '0')}:${`${m}`.padStart(2, '0')}:${`${sec}`.padStart(2, '0')}`;
}

/**
 * Asks before completing a task that is being timed, then ends its timing in
 * the same gesture. Mounted once at the app level so any future entry point can
 * route through `setCompletingTask` and get the same confirmation.
 *
 * Opening the dialog freezes the clock at the moment the user chose to
 * complete, so deliberation time is never billed as work; cancelling resumes
 * exactly what it interrupted.
 */
export function CompleteTaskDialog() {
  const taskId = useUiStore((s) => s.completingTaskId);
  const setCompletingTask = useUiStore((s) => s.setCompletingTask);
  const task = useDataStore((s) => (taskId ? (s.data?.tasks[taskId] ?? null) : null));
  const timer = useTimerStore((s) => s.timer);
  const completeFor = useTimerStore((s) => s.completeFor);
  // Only resume on cancel if the dialog was what stopped the clock. A timer the
  // user had already paused must stay paused when they back out.
  const pausedByDialog = useRef(false);

  const timed = timer?.taskId === taskId ? timer : null;

  useEffect(() => {
    if (!taskId) {
      pausedByDialog.current = false;
      return;
    }
    const cur = useTimerStore.getState().timer;
    if (cur && cur.taskId === taskId && !cur.isPaused) {
      pausedByDialog.current = true;
      useTimerStore.getState().pause();
    } else {
      pausedByDialog.current = false;
    }
  }, [taskId]);

  if (!taskId || !task) return null;

  // settleTimer dates the entry to the freeze instant and, for pomodoro, counts
  // focus time only — exactly what confirming will record.
  const ms = timed ? settleTimer(timed, Date.now()).ms : 0;
  const pomodoro = timed !== null && isPomodoro(timed);

  const handleCancel = () => {
    setCompletingTask(null);
    if (pausedByDialog.current) useTimerStore.getState().resume();
  };

  const handleConfirm = async () => {
    setCompletingTask(null);
    const settlement = await completeFor(taskId);
    if (settlement && settlement.ms > 0) {
      toast.success(`已做完并记录 ${formatElapsed(settlement.ms)}`);
    }
  };

  return (
    <Dialog open>
      <DialogContent showCloseButton={false} onInteractOutside={handleCancel}>
        <DialogHeader>
          <DialogTitle>完成这个任务？</DialogTitle>
          <DialogDescription>
            {pomodoro
              ? `本次番茄钟已完成 ${timed?.cyclesCompleted ?? 0}/${POMODORO_CYCLES_PER_SET} 轮专注。完成会结束计时并记录 ${formatElapsed(ms)}（只计专注时长）。`
              : `这个任务正在计时，完成会同时结束计时并记录 ${formatElapsed(ms)}。`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            取消
          </Button>
          <Button onClick={() => void handleConfirm()}>完成并结束计时</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
