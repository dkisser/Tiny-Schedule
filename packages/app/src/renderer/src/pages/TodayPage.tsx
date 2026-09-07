import { addDays, localDate } from '@tiny-schedule/shared';
import { CheckCircle2, ChevronRight, Hourglass } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { FinishDayDialog } from '../components/FinishDayDialog';
import { TaskList } from '../components/TaskList';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { dueFollowUps, waitingDays } from '../lib/followUps';
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
  const upsertFollowUp = useDataStore((s) => s.upsertFollowUp);
  const setView = useUiStore((s) => s.setView);
  const selectFollowUp = useUiStore((s) => s.selectFollowUp);
  const activeTaskId = useTimerStore((s) => s.timer)?.taskId;
  const [finishOpen, setFinishOpen] = useState(false);
  if (!data) return null;
  const today = localDate(Date.now());
  const tasks = applyManualOrder(todayTasks(data), taskOrderFor(data, 'today'));
  const doneTasks = todayDoneTasks(data);
  const due = dueFollowUps(data);
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
      {due.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-400/60 bg-amber-500/10 px-3 py-2">
          <div className="flex items-center gap-1 text-sm font-medium text-amber-600 dark:text-amber-400">
            <Hourglass className="h-3 w-3" /> 需要跟进
          </div>
          <div className="mt-1 flex flex-col gap-1">
            {due.map((f) => (
              <div
                key={f.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setView({ type: 'followUps' });
                  selectFollowUp(f.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setView({ type: 'followUps' });
                    selectFollowUp(f.id);
                  }
                }}
                className="flex cursor-pointer items-center gap-2 rounded px-1 text-sm hover:bg-amber-500/10"
              >
                <span className="min-w-0 flex-1 truncate">{f.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  已等待 {waitingDays(f)} 天
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    void upsertFollowUp({
                      ...f,
                      nextFollowUpDay: addDays(today, 7),
                    });
                  }}
                >
                  +7天
                </Button>
              </div>
            ))}
          </div>
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
