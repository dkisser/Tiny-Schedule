import type { AppData, Task } from '@tiny-schedule/shared';
import { AnimatePresence, motion, Reorder, useDragControls } from 'motion/react';
import { splitByDone } from '../lib/tasks';
import { useManualOrder } from '../lib/useManualOrder';
import { TaskCard } from './TaskCard';

export function TaskList({
  tasks,
  data,
  activeTaskId,
  groupDone = false,
  viewKey,
}: {
  tasks: Task[];
  data: AppData;
  activeTaskId?: string | null;
  groupDone?: boolean;
  viewKey?: string;
}) {
  if (tasks.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">暂无任务</div>;
  }

  const { open, done } = groupDone ? splitByDone(tasks) : { open: tasks, done: [] as Task[] };

  if (viewKey) {
    return (
      <div className="flex flex-col gap-2">
        <ReorderableOpenList
          open={open}
          data={data}
          activeTaskId={activeTaskId}
          viewKey={viewKey}
        />
        <DoneSection done={done} data={data} activeTaskId={activeTaskId} withHeader={groupDone} />
      </div>
    );
  }

  // Build one flat keyed list so a card that moves between the open and done
  // sections animates as a layout move (same key, no unmount), and cards that
  // leave the list entirely get an exit animation.
  const children = [];
  for (const t of open) {
    children.push(<TaskItem key={t.id} task={t} data={data} activeTaskId={activeTaskId} />);
  }
  if (groupDone && done.length > 0) {
    children.push(<DoneHeader key="__done-header__" count={done.length} />);
  }
  for (const t of done) {
    children.push(<TaskItem key={t.id} task={t} data={data} activeTaskId={activeTaskId} />);
  }

  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false} mode="popLayout">
        {children}
      </AnimatePresence>
    </div>
  );
}

/** Open tasks with manual drag ordering, persisted per view via viewKey. */
function ReorderableOpenList({
  open,
  data,
  activeTaskId,
  viewKey,
}: {
  open: Task[];
  data: AppData;
  activeTaskId?: string | null;
  viewKey: string;
}) {
  const { ordered, onReorder } = useManualOrder(open, viewKey);
  const ids = ordered.map((t) => t.id);

  return (
    <Reorder.Group axis="y" values={ids} onReorder={onReorder} className="flex flex-col gap-2">
      {ordered.map((t) => (
        <ReorderableItem key={t.id} task={t} data={data} activeTaskId={activeTaskId} />
      ))}
    </Reorder.Group>
  );
}

function ReorderableItem({
  task,
  data,
  activeTaskId,
}: {
  task: Task;
  data: AppData;
  activeTaskId?: string | null;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={task.id}
      dragListener={false}
      dragControls={controls}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      whileDrag={{ scale: 1.01, zIndex: 10 }}
    >
      <TaskCard task={task} data={data} active={task.id === activeTaskId} dragControls={controls} />
    </Reorder.Item>
  );
}

function DoneSection({
  done,
  data,
  activeTaskId,
  withHeader,
}: {
  done: Task[];
  data: AppData;
  activeTaskId?: string | null;
  withHeader: boolean;
}) {
  if (done.length === 0) return null;
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {withHeader && <DoneHeader key="__done-header__" count={done.length} />}
      {done.map((t) => (
        <TaskItem key={t.id} task={t} data={data} activeTaskId={activeTaskId} />
      ))}
    </AnimatePresence>
  );
}

function DoneHeader({ count }: { count: number }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="mt-4 mb-1 flex items-center gap-2 text-xs text-muted-foreground"
    >
      <span>已做完（{count}）</span>
      <div className="h-px flex-1 bg-border" />
    </motion.div>
  );
}

function TaskItem({
  task,
  data,
  activeTaskId,
}: {
  task: Task;
  data: AppData;
  activeTaskId?: string | null;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2, layout: { duration: 0.2, ease: 'easeOut' } }}
    >
      <TaskCard task={task} data={data} active={task.id === activeTaskId} />
    </motion.div>
  );
}
