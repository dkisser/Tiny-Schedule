import type { AppData, Task } from '@tiny-schedule/shared';
import { AnimatePresence, motion, Reorder, useDragControls } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { splitByDone } from '../lib/tasks';
import { useDataStore } from '../stores/data';
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
  const setTaskOrder = useDataStore((s) => s.setTaskOrder);
  const [ids, setIds] = useState<string[]>(() => open.map((t) => t.id));
  const openRef = useRef(open);
  openRef.current = open;

  // Reconcile when membership changes (task added/completed/deleted): keep the
  // current manual order for remaining items, append new ones at the end.
  const membershipKey = open
    .map((t) => t.id)
    .sort()
    .join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconcile only when membership changes, order state lives here
  useEffect(() => {
    setIds((prev) => {
      const current = openRef.current.map((t) => t.id);
      const currentSet = new Set(current);
      const kept = prev.filter((id) => currentSet.has(id));
      const keptSet = new Set(kept);
      return [...kept, ...current.filter((id) => !keptSet.has(id))];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipKey]);

  const byId = new Map(open.map((t) => [t.id, t]));
  const ordered = ids.map((id) => byId.get(id)).filter((t): t is Task => Boolean(t));

  return (
    <Reorder.Group
      axis="y"
      values={ids}
      onReorder={(next) => {
        setIds(next);
        setTaskOrder(viewKey, next);
      }}
      className="flex flex-col gap-2"
    >
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
      <span>已完成（{count}）</span>
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
