import type { AppData, Task } from '@tiny-schedule/shared';
import { TaskCard } from './TaskCard';

export function TaskList({
  tasks,
  data,
  activeTaskId,
}: {
  tasks: Task[];
  data: AppData;
  activeTaskId?: string | null;
}) {
  if (tasks.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">暂无任务</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} data={data} active={t.id === activeTaskId} />
      ))}
    </div>
  );
}
