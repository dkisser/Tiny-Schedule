import { INBOX_PROJECT_ID, SYSTEM_TAG_IDS, type Task } from '@tiny-schedule/shared';
import { ChevronLeft, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { blankTask, taskProjectTitle, taskTagLabel } from '../lib/tasks';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';
import { useUiStore } from '../stores/ui';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { MarkdownEditor } from './MarkdownEditor';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import { Input } from './ui/input';
import { Markdown } from './ui/markdown';

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
  const [editingNotes, setEditingNotes] = useState(false);
  if (!data) return null;

  const save = (patch: Partial<Task>) => void upsertTask({ ...task, ...patch });
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);
  const systemTagIds = Object.values(SYSTEM_TAG_IDS) as string[];
  const tags = Object.values(data.tags).filter((t) => !systemTagIds.includes(t.id));
  const subTasks = task.subTaskIds.map((id) => data.tasks[id]).filter(Boolean) as Task[];

  const addSubTask = async () => {
    const title = subTitle.trim();
    if (!title) return;
    const project = data.projects[task.projectId] ?? data.projects[INBOX_PROJECT_ID];
    if (!project) return;
    const sub = { ...blankTask(title, project), parentTaskId: task.id };
    await upsertTask(sub);
    await upsertTask({ ...task, subTaskIds: [...task.subTaskIds, sub.id] });
    setSubTitle('');
  };

  const toggleTag = (tagId: string) => {
    const on = task.tagIds.includes(tagId);
    if (on) {
      const snapshots = { ...task.tagSnapshots };
      delete snapshots[tagId];
      save({
        tagIds: task.tagIds.filter((id) => id !== tagId),
        tagSnapshots: Object.keys(snapshots).length > 0 ? snapshots : undefined,
      });
    } else {
      const tag = data.tags[tagId];
      save({
        tagIds: [...task.tagIds, tagId],
        tagSnapshots: {
          ...task.tagSnapshots,
          ...(tag
            ? { [tagId]: { title: tag.title, ...(tag.color ? { color: tag.color } : {}) } }
            : {}),
        },
      });
    }
  };

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => selectTask(null)}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          关闭
        </Button>
      </div>

      <Input
        defaultValue={task.title}
        onBlur={(e) => e.target.value.trim() && save({ title: e.target.value.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />

      <div>
        <div className="mb-1 text-xs text-muted-foreground">项目</div>
        <Combobox
          options={projects.map((p) => ({ id: p.id, title: p.title }))}
          value={data.projects[task.projectId] ? task.projectId : undefined}
          display={taskProjectTitle(task, data) || undefined}
          placeholder="选择项目"
          onSelect={(id) => {
            const p = data.projects[id];
            if (p) save({ projectId: id, projectTitle: p.title });
          }}
        />
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">标签</div>
        <Combobox
          options={tags.map((t) => ({ id: t.id, title: t.title, color: t.color }))}
          selectedIds={task.tagIds}
          onToggle={toggleTag}
          placeholder="搜索并选择标签"
          display={task.tagIds.length > 0 ? `已选 ${task.tagIds.length} 个标签` : undefined}
        />
        {task.tagIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {task.tagIds.map((id) => (
              <span
                key={id}
                className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
              >
                {taskTagLabel(task, data, id) || id}
                {!data.tags[id] && <span className="text-muted-foreground">（已删除）</span>}
                <button
                  type="button"
                  aria-label="移除标签"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => toggleTag(id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
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
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">备注</span>
          {!editingNotes && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => setEditingNotes(true)}
            >
              <Pencil className="mr-1 h-3 w-3" />
              编辑
            </Button>
          )}
        </div>
        {editingNotes ? (
          <MarkdownEditor
            initialValue={task.notes}
            onDone={(text) => {
              setEditingNotes(false);
              if (text !== task.notes) save({ notes: text });
            }}
            onCancel={() => setEditingNotes(false)}
          />
        ) : task.notes ? (
          <Markdown text={task.notes} className="rounded-md border border-border p-2" />
        ) : (
          <div className="text-sm text-muted-foreground">暂无备注</div>
        )}
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
