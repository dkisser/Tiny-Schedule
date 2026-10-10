import { type AppData, localDate, type Task } from '@tiny-schedule/shared';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { QuadrantBoard } from '../components/QuadrantBoard';
import { TaskList } from '../components/TaskList';
import { Button } from '../components/ui/button';
import {
  doneTodayCount,
  estimateRemainingMs,
  focusSeries7d,
  isOverdue,
  longTermPool,
  workedTodayMs,
} from '../lib/tasks';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';

function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

type BoardTab = 'quadrant' | 'longTerm';

export function HomePage() {
  const data = useDataStore((s) => s.data);
  const activeTaskId = useTimerStore((s) => s.timer)?.taskId;
  const [tab, setTab] = useState<BoardTab>('quadrant');
  if (!data) return null;

  const today = localDate(Date.now());
  const thresholdDays = data.settings.urgencyThresholdDays;
  const allTasks = Object.values(data.tasks);
  const topLevel = allTasks.filter((t) => !t.parentTaskId);
  const series = focusSeries7d(allTasks, today);
  const pool = longTermPool(topLevel, today);
  const stats: { label: string; value: string }[] = [
    { label: '今日已专注', value: formatMs(workedTodayMs(allTasks, today)) },
    { label: '今日剩余估计', value: formatMs(estimateRemainingMs(topLevel, today)) },
    { label: '逾期', value: String(topLevel.filter((t) => isOverdue(t)).length) },
    { label: '今日完成', value: String(doneTodayCount(topLevel, today)) },
  ];

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-xl font-semibold">首页</h1>

      <div className="mt-3 grid grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div className="mt-0.5 text-lg font-medium tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-border bg-card px-3 py-2">
        <div className="text-xs text-muted-foreground">近 7 天专注</div>
        <div className="mt-2 h-40">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => formatMs(v)}
                width={56}
              />
              <Tooltip
                formatter={(value) => [formatMs(Number(value ?? 0)), '专注']}
                labelFormatter={(label) => String(label)}
              />
              <Bar dataKey="ms" fill="var(--color-primary)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="mt-6 flex gap-2">
        <Button
          variant={tab === 'quadrant' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setTab('quadrant')}
        >
          四象限
        </Button>
        <Button
          variant={tab === 'longTerm' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setTab('longTerm')}
        >
          长期池
        </Button>
        <span className="ml-1 self-center text-xs text-muted-foreground">
          {thresholdDays} 天内到期算紧急；跨列拖动即改期，跨行拖动即改「重要」
        </span>
      </div>

      {tab === 'quadrant' ? (
        <div className="mt-3">
          <QuadrantBoard
            data={data}
            today={today}
            thresholdDays={thresholdDays}
            activeTaskId={activeTaskId}
          />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          <PoolSection
            title="未定日期"
            viewKey="longTerm:unscheduled"
            tasks={pool.unscheduled}
            data={data}
            activeTaskId={activeTaskId}
          />
          <PoolSection
            title="已定远期（14 天以外）"
            viewKey="longTerm:farFuture"
            tasks={pool.farFuture}
            data={data}
            activeTaskId={activeTaskId}
          />
        </div>
      )}
    </div>
  );
}

function PoolSection({
  title,
  viewKey,
  tasks,
  data,
  activeTaskId,
}: {
  title: string;
  viewKey: string;
  tasks: Task[];
  data: AppData;
  activeTaskId?: string | null;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {title}（{tasks.length}）
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <TaskList tasks={tasks} data={data} activeTaskId={activeTaskId} viewKey={viewKey} />
    </section>
  );
}
