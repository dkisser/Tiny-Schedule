import type { Task } from '@tiny-schedule/shared';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { blankTask } from '../lib/tasks';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';
import { useUiStore } from '../stores/ui';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

function hoursToMs(h: number): number {
  return Math.round(h * 3_600_000);
}

export function TaskDetail({ task }: { task: Task }) {
  const data = useDataStore((s) => s.data);
  const upsertTask = useDataStore((s) => s.upsertTask);
  const deleteTask = useDataStore((s) => s.deleteTask);
  const selectTask = useUiStore((s) => s.selectTask);
  const activeTaskId = useTimerStore((s) => s.timer?.taskId ?? null);
  const [subTitle, setSubTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<Task | null>(null);
  if (!data) return null;

  const save = (patch: Partial<Task>) => void upsertTask({ ...task, ...patch });
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);
  const tags = Object.values(data.tags);
  const subTasks = task.subTaskIds.map((id) => data.tasks[id]).filter(Boolean) as Task[];

  const addSubTask = async () => {
    const title = subTitle.trim();
    if (!title) return;
    const sub = { ...blankTask(title, task.projectId), parentTaskId: task.id };
    await upsertTask(sub);
    await upsertTask({ ...task, subTaskIds: [...task.subTaskIds, sub.id] });
    setSubTitle('');
  };

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <Input
          defaultValue={task.title}
          onBlur={(e) => e.target.value.trim() && save({ title: e.target.value.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <Button variant="ghost" size="icon" aria-label="关闭" onClick={() => selectTask(null)}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={task.isDone}
          onChange={(e) =>
            save({ isDone: e.target.checked, doneAt: e.target.checked ? Date.now() : undefined })
          }
        />
        已完成
      </label>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">项目</div>
        <select
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          value={task.projectId}
          onChange={(e) => save({ projectId: e.target.value })}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">标签</div>
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => {
            const on = task.tagIds.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  save({
                    tagIds: on ? task.tagIds.filter((id) => id !== t.id) : [...task.tagIds, t.id],
                  })
                }
                className={
                  on
                    ? 'rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground'
                    : 'rounded-full bg-secondary px-2 py-0.5 text-xs'
                }
              >
                {t.title}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 text-xs text-muted-foreground">截止日</div>
          <Input
            type="date"
            value={task.dueDay ?? ''}
            onChange={(e) => save({ dueDay: e.target.value || undefined })}
          />
        </div>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">预估（小时）</div>
          <Input
            type="number"
            min="0"
            step="0.5"
            defaultValue={task.timeEstimate > 0 ? task.timeEstimate / 3_600_000 : ''}
            onBlur={(e) => save({ timeEstimate: hoursToMs(Number(e.target.value) || 0) })}
          />
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">子任务</div>
        <div className="flex flex-col gap-1">
          {subTasks.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={s.isDone}
                onChange={(e) => void upsertTask({ ...s, isDone: e.target.checked })}
              />
              <span className={s.isDone ? 'line-through text-muted-foreground' : ''}>
                {s.title}
              </span>
              {activeTaskId !== s.id && (
                <button
                  type="button"
                  aria-label="删除子任务"
                  className="ml-auto text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (s.timeSpent > 0 || s.timeEntries.length > 0) setConfirmDelete(s);
                    else void deleteTask(s.id);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <Input
            placeholder="添加子任务"
            value={subTitle}
            onChange={(e) => setSubTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addSubTask()}
          />
          <Button variant="outline" size="icon" aria-label="添加" onClick={() => void addSubTask()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">备注</div>
        <Textarea
          rows={6}
          defaultValue={task.notes}
          onBlur={(e) => save({ notes: e.target.value })}
          placeholder="支持 Markdown"
        />
      </div>

      <DeleteTaskDialog
        open={confirmDelete !== null}
        title={confirmDelete?.title ?? ''}
        timeSpent={confirmDelete?.timeSpent ?? 0}
        onConfirm={() => {
          if (confirmDelete) void deleteTask(confirmDelete.id);
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
