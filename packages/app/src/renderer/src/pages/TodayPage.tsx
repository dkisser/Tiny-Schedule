import { localDate } from '@tiny-schedule/shared';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { FinishDayDialog } from '../components/FinishDayDialog';
import { TaskList } from '../components/TaskList';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { applyManualOrder, taskOrderFor, todayDoneTasks, todayTasks } from '../lib/tasks';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';
import { useUiStore } from '../stores/ui';

function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function TodayPage() {
  const data = useDataStore((s) => s.data);
  const activeTaskId = useTimerStore((s) => s.timer)?.taskId;
  const [finishOpen, setFinishOpen] = useState(false);
  if (!data) return null;
  const today = localDate(Date.now());
  const tasks = applyManualOrder(todayTasks(data), taskOrderFor(data, 'today'));
  const doneTasks = todayDoneTasks(data);
  const workedToday = Object.values(data.tasks).reduce(
    (sum, t) => sum + (t.timeSpentOnDay[today] ?? 0),
    0,
  );
  const estimateRemaining = tasks.reduce(
    (sum, t) => sum + Math.max(0, t.timeEstimate - t.timeSpent),
    0,
  );
  const finishedToday = data.misc.lastFinishDay === today;

  const handleFinish = async () => {
    const { aiProviders, autoAiAnalyzeOnFinishDay } = data.settings;
    if (!autoAiAnalyzeOnFinishDay) {
      setFinishOpen(true);
      return;
    }
    // 设置里已开启「Finish Day 自动触发 AI 分析」：直接结束，不再弹窗询问
    const next = await api().finishDay({ date: new Date().toISOString() });
    useDataStore.setState({ data: next });
    const def = aiProviders.find((p) => p.isDefault) ?? aiProviders[0];
    if (def) {
      useUiStore.setState({
        aiAutoRun: { scope: 'today', providerId: def.id },
        view: { type: 'ai' },
        selectedTaskId: null,
      });
    }
  };

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
        <TaskList tasks={tasks} data={data} activeTaskId={activeTaskId} viewKey="today" />
      </div>
      {doneTasks.length > 0 && (
        <Collapsible className="mt-4">
          <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-md px-1 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
            今日已完成（{doneTasks.length}）
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2">
              <TaskList tasks={doneTasks} data={data} activeTaskId={activeTaskId} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="mt-8 flex justify-center">
        <Button variant="outline" disabled={finishedToday} onClick={() => void handleFinish()}>
          <CheckCircle2 /> Finish Day
        </Button>
      </div>
      <FinishDayDialog open={finishOpen} onClose={() => setFinishOpen(false)} />
    </div>
  );
}
