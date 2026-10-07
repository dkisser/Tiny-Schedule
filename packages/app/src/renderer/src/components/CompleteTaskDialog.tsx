import { isPomodoro, POMODORO_CYCLES_PER_SET, settleTimer } from '@tiny-schedule/shared';
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
 * the same gesture. Mounted once at the app level so any entry point can route
 * through `requestComplete` and get the same confirmation.
 *
 * The clock freeze lives in `requestComplete` rather than in an effect here, so
 * what gets restored on cancel is a recorded decision instead of something
 * re-derived on every render.
 */
export function CompleteTaskDialog() {
  const pending = useUiStore((s) => s.completing);
  const cancelComplete = useUiStore((s) => s.cancelComplete);
  const task = useDataStore((s) => (pending ? (s.data?.tasks[pending.taskId] ?? null) : null));
  const timer = useTimerStore((s) => s.timer);
  const completeFor = useTimerStore((s) => s.completeFor);

  if (!pending || !task) return null;
  const timed = timer?.taskId === pending.taskId ? timer : null;

  // settleTimer dates the entry to the freeze instant and, for pomodoro, counts
  // focus time only — exactly what confirming will record.
  const ms = timed ? settleTimer(timed, Date.now()).ms : 0;
  const pomodoro = timed !== null && isPomodoro(timed);

  const handleConfirm = async () => {
    const { taskId } = pending;
    // Drop the dialog first: completing must not be undone by a later cancel,
    // and the paused clock is settled and cleared by completeFor itself.
    useUiStore.setState({ completing: null });
    try {
      const settled = await completeFor(taskId);
      if (settled > 0) toast.success(`已做完并记录 ${formatElapsed(settled)}`);
    } catch {
      // Leaving the task un-done is the safe failure: nothing was recorded and
      // the clock is still running, so the user can simply try again.
      toast.error('完成任务失败，请重试');
      const still = useTimerStore.getState().timer;
      if (still?.taskId === taskId && still.isPaused) useTimerStore.getState().resume();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && cancelComplete()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>完成这个任务？</DialogTitle>
          <DialogDescription>
            {pomodoro
              ? `本次番茄钟已完成 ${timed?.cyclesCompleted ?? 0}/${POMODORO_CYCLES_PER_SET} 轮专注。完成会结束计时并记录 ${formatElapsed(ms)}（只计专注时长）。`
              : `这个任务正在计时，完成会同时结束计时并记录 ${formatElapsed(ms)}。`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={cancelComplete}>
            取消
          </Button>
          <Button onClick={() => void handleConfirm()}>完成并结束计时</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
