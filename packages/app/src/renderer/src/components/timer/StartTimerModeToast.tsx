import { toast } from 'sonner';
import { useTimerStore } from '../../stores/timer';
import { Button } from '../ui/button';

/**
 * Open a small toast asking the user to pick a timer mode for `taskId`.
 * "Free" matches the legacy single-mode behaviour. "Pomodoro" starts a
 * 25/5 cycle driven by the timer's own clock.
 */
export function openStartModeToast(taskId: string): void {
  const start = useTimerStore.getState().start;
  const startPomodoro = useTimerStore.getState().startPomodoro;

  toast.custom(
    (t) => (
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 shadow-lg">
        <span className="text-sm">选择计时模式</span>
        <Button
          size="sm"
          variant="default"
          onClick={() => {
            toast.dismiss(t);
            void startPomodoro(taskId);
          }}
        >
          番茄时钟
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            toast.dismiss(t);
            void start(taskId);
          }}
        >
          无限制
        </Button>
      </div>
    ),
    { duration: 6000, id: `start-mode-${taskId}` },
  );
}
