import { INBOX_PROJECT_ID } from '@tiny-schedule/shared';
import { useEffect } from 'react';
import { AddTaskInput } from './components/AddTaskInput';
import { Layout } from './components/Layout';
import { Sidebar } from './components/Sidebar';
import { TaskDetail } from './components/TaskDetail';
import { TaskList } from './components/TaskList';
import { TimerBar } from './components/TimerBar';
import { projectTasks, tagTasks, upcomingTasks } from './lib/tasks';
import { SettingsPage } from './pages/SettingsPage';
import { TodayPage } from './pages/TodayPage';
import { useDataStore } from './stores/data';
import { useTimerStore } from './stores/timer';
import { useUiStore } from './stores/ui';
import { applyTheme } from './theme';

function Placeholder({ name }: { name: string }) {
  return <div className="p-4 text-muted-foreground">{name} 页面待实现</div>;
}

function ProjectPage({ projectId }: { projectId: string }) {
  const data = useDataStore((s) => s.data);
  const activeTaskId = useTimerStore((s) => s.timer)?.taskId;
  if (!data) return null;
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">{data.projects[projectId]?.title ?? '项目'}</h1>
      <div className="mt-4">
        <TaskList tasks={projectTasks(data, projectId)} data={data} activeTaskId={activeTaskId} />
      </div>
      <div className="mt-4">
        <AddTaskInput projectId={projectId} />
      </div>
    </div>
  );
}

function TagPage({ tagId }: { tagId: string }) {
  const data = useDataStore((s) => s.data);
  const activeTaskId = useTimerStore((s) => s.timer)?.taskId;
  if (!data) return null;
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">{data.tags[tagId]?.title ?? '标签'}</h1>
      <div className="mt-4">
        <TaskList tasks={tagTasks(data, tagId)} data={data} activeTaskId={activeTaskId} />
      </div>
    </div>
  );
}

function UpcomingPage() {
  const data = useDataStore((s) => s.data);
  const activeTaskId = useTimerStore((s) => s.timer)?.taskId;
  if (!data) return null;
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">Upcoming</h1>
      <div className="mt-4">
        <TaskList tasks={upcomingTasks(data)} data={data} activeTaskId={activeTaskId} />
      </div>
      <div className="mt-4">
        <AddTaskInput projectId={INBOX_PROJECT_ID} />
      </div>
    </div>
  );
}

export default function App() {
  const data = useDataStore((s) => s.data);
  const load = useDataStore((s) => s.load);
  const view = useUiStore((s) => s.view);
  const selectedTaskId = useUiStore((s) => s.selectedTaskId);
  const theme = data?.settings.theme;

  useEffect(() => {
    void load().then(() => {
      const data = useDataStore.getState().data;
      if (data) useTimerStore.getState().restore(data);
    });
  }, [load]);

  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  if (!data) return <div className="p-4">加载中…</div>;

  const selectedTask = selectedTaskId ? (data.tasks[selectedTaskId] ?? null) : null;

  const page =
    view.type === 'today' ? (
      <TodayPage />
    ) : view.type === 'project' ? (
      <ProjectPage projectId={view.id} />
    ) : view.type === 'tag' ? (
      <TagPage tagId={view.id} />
    ) : view.type === 'upcoming' ? (
      <UpcomingPage />
    ) : view.type === 'ai' ? (
      <Placeholder name="AI 分析" />
    ) : view.type === 'export' ? (
      <Placeholder name="导入导出" />
    ) : (
      <SettingsPage />
    );

  return (
    <Layout sidebar={<Sidebar />} timerBar={<TimerBar />}>
      <div className="flex h-full">
        <div className="min-w-0 flex-1 overflow-y-auto">{page}</div>
        {selectedTask && <TaskDetail key={selectedTask.id} task={selectedTask} />}
      </div>
    </Layout>
  );
}
