import { INBOX_PROJECT_ID, localDate } from '@tiny-schedule/shared';
import { CheckCircle2 } from 'lucide-react';
import { AddTaskInput } from '../components/AddTaskInput';
import { TaskList } from '../components/TaskList';
import { Button } from '../components/ui/button';
import { todayTasks } from '../lib/tasks';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';

function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function TodayPage() {
  const data = useDataStore((s) => s.data);
  const activeTaskId = useTimerStore((s) => s.timer)?.taskId;
  if (!data) return null;
  const today = localDate(Date.now());
  const tasks = todayTasks(data);
  const workedToday = Object.values(data.tasks).reduce(
    (sum, t) => sum + (t.timeSpentOnDay[today] ?? 0),
    0,
  );
  const estimateRemaining = tasks.reduce(
    (sum, t) => sum + Math.max(0, t.timeEstimate - t.timeSpent),
    0,
  );
  const finishedToday = data.misc.lastFinishDay === today;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">今日</h1>
      <div className="mt-2 flex gap-6 text-sm text-muted-foreground">
        <span>预估剩余：{formatMs(estimateRemaining)}</span>
        <span>今日工作：{formatMs(workedToday)}</span>
      </div>
      {finishedToday && (
        <div className="mt-3 rounded-md bg-secondary px-3 py-2 text-sm text-muted-foreground">
          今天已结束（Finish Day 已完成）
        </div>
      )}
      <div className="mt-4">
        <TaskList tasks={tasks} data={data} activeTaskId={activeTaskId} />
      </div>
      <div className="mt-4">
        <AddTaskInput projectId={INBOX_PROJECT_ID} addToToday />
      </div>
      <div className="mt-8 flex justify-center">
        <Button
          variant="outline"
          disabled={finishedToday}
          onClick={() => {
            /* Task 19 接入 Finish Day */
          }}
        >
          <CheckCircle2 className="mr-1 h-4 w-4" /> Finish Day
        </Button>
      </div>
    </div>
  );
}
