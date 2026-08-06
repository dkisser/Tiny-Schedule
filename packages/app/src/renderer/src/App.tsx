import { INBOX_PROJECT_ID } from '@tiny-schedule/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';
import { AddTaskInput } from './components/AddTaskInput';
import { Layout } from './components/Layout';
import { Sidebar } from './components/Sidebar';
import { TaskDetail } from './components/TaskDetail';
import { TaskList } from './components/TaskList';
import { TimerBar } from './components/TimerBar';
import { applyManualOrder, projectTasks, tagTasks, taskOrderFor, upcomingTasks } from './lib/tasks';
import { AiPage } from './pages/AiPage';
import { ExportPage } from './pages/ExportPage';
import { SettingsPage } from './pages/SettingsPage';
import { TodayPage } from './pages/TodayPage';
import { useDataStore } from './stores/data';
import { useTimerStore } from './stores/timer';
import { useUiStore } from './stores/ui';
import { applyTheme } from './theme';

function ProjectPage({ projectId }: { projectId: string }) {
  const data = useDataStore((s) => s.data);
  const activeTaskId = useTimerStore((s) => s.timer)?.taskId;
  if (!data) return null;
  const viewKey = `project:${projectId}`;
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">{data.projects[projectId]?.title ?? '项目'}</h1>
      <div className="mt-4">
        <TaskList
          tasks={applyManualOrder(projectTasks(data, projectId), taskOrderFor(data, viewKey))}
          data={data}
          activeTaskId={activeTaskId}
          groupDone
          viewKey={viewKey}
        />
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
  const viewKey = `tag:${tagId}`;
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">{data.tags[tagId]?.title ?? '标签'}</h1>
      <div className="mt-4">
        <TaskList
          tasks={applyManualOrder(tagTasks(data, tagId), taskOrderFor(data, viewKey))}
          data={data}
          activeTaskId={activeTaskId}
          viewKey={viewKey}
        />
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
        <TaskList
          tasks={applyManualOrder(upcomingTasks(data), taskOrderFor(data, 'upcoming'))}
          data={data}
          activeTaskId={activeTaskId}
          viewKey="upcoming"
        />
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
      <AiPage />
    ) : view.type === 'export' ? (
      <ExportPage />
    ) : (
      <SettingsPage />
    );

  return (
    <Layout sidebar={<Sidebar />} timerBar={<TimerBar />}>
      <div className="flex h-full">
        <div className="min-w-0 flex-1 overflow-y-auto">{page}</div>
        {/* Animate the panel width so the list reflows in step with it instead
            of snapping while cards lag behind on their layout animation. */}
        <AnimatePresence initial={false}>
          {selectedTask && (
            <motion.div
              key="task-detail"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 380, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
              className="shrink-0 overflow-hidden"
            >
              <TaskDetail key={selectedTask.id} task={selectedTask} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Layout>
  );
}
