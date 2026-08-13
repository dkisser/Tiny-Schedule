import {
  POMODORO_BREAK_MS,
  POMODORO_CYCLES_PER_SET,
  POMODORO_FOCUS_MS,
} from '@tiny-schedule/shared';
import { useEffect } from 'react';
import { api } from '../../api';
import { useTimerStore } from '../../stores/timer';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

function describe(pending: { finishedPhase: 'focus' | 'break'; setComplete: boolean }): {
  title: string;
  description: string;
  primaryLabel: string;
} {
  if (pending.setComplete) {
    return {
      title: '已完成一个完整番茄循环',
      description: `共完成 ${POMODORO_CYCLES_PER_SET} 个专注段（${POMODORO_CYCLES_PER_SET} × ${POMODORO_FOCUS_MS / 60_000} 分钟）。再来一组？`,
      primaryLabel: '再来一组',
    };
  }
  if (pending.finishedPhase === 'focus') {
    return {
      title: '休息时间到！',
      description: `开始 ${POMODORO_BREAK_MS / 60_000} 分钟休息。`,
      primaryLabel: '开始休息',
    };
  }
  return {
    title: '休息结束',
    description: `开始下一个 ${POMODORO_FOCUS_MS / 60_000} 分钟专注段。`,
    primaryLabel: '开始专注',
  };
}

/**
 * Listens for `phasePendingAdvance` in the timer store and pops a confirmation
 * dialog whenever a phase ends. The dialog also fires the OS notification and
 * pins the window so the user can't miss the transition.
 */
export function PomodoroPhaseDialog() {
  const pending = useTimerStore((s) => s.phasePendingAdvance);
  const advancePhase = useTimerStore((s) => s.advancePhase);
  const startNextSet = useTimerStore((s) => s.startNextPomodoroSet);
  const stop = useTimerStore((s) => s.stop);

  // Side-effects: OS notification + always-on-top while the dialog is open.
  useEffect(() => {
    if (!pending) {
      void api().setAlwaysOnTopWindow({ enabled: false });
      return;
    }
    if (pending.setComplete) {
      void api().notifyPhaseComplete({
        phase: 'focus',
        title: '已完成一组番茄',
        body: '是否开始下一组？',
      });
    } else if (pending.finishedPhase === 'focus') {
      void api().notifyPhaseComplete({
        phase: 'focus',
        title: '休息时间到',
        body: '点击开始 5 分钟休息。',
      });
    } else {
      void api().notifyPhaseComplete({
        phase: 'break',
        title: '休息结束',
        body: '点击开始下一个番茄。',
      });
    }
    void api().setAlwaysOnTopWindow({ enabled: true });
    return () => {
      void api().setAlwaysOnTopWindow({ enabled: false });
    };
  }, [pending]);

  if (!pending) return null;
  const { title, description, primaryLabel } = describe(pending);
  const handlePrimary = () => {
    if (pending.setComplete) void startNextSet();
    else void advancePhase();
  };
  const handleStop = () => {
    void stop();
  };

  return (
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleStop}>
            结束计时
          </Button>
          <Button onClick={handlePrimary}>{primaryLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
