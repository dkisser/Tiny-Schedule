import {
  applyEntryChange,
  INBOX_PROJECT_ID,
  localDate,
  SYSTEM_TAG_IDS,
  type Task,
  type TimeEntry,
} from '@tiny-schedule/shared';
import type Cherry from 'cherry-markdown';
import { ChevronLeft, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { blankTask, taskProjectTitle, taskTagLabel } from '../lib/tasks';
import { useDebouncedCommit } from '../lib/useDebouncedCommit';
import { useDataStore } from '../stores/data';
import { useTimerStore } from '../stores/timer';
import { useUiStore } from '../stores/ui';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { DeleteTimeEntryDialog } from './DeleteTimeEntryDialog';
import { EditTimeEntryDialog } from './EditTimeEntryDialog';
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
  const [editEntry, setEditEntry] = useState<TimeEntry | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<TimeEntry | null>(null);
  const cherryRef = useRef<Cherry | null>(null);
  // 标记 Done / Cancel 已经处理过当前编辑会话，MarkdownEditor 卸载时不要重复 flush。
  const notesHandledRef = useRef(false);

  // 标题/预估输入：受控 + 防抖自动提交 + 切换任务（initial 变化）时自动重新同步。
  // 这样用户在标题框里打字没失焦就切换任务，400 ms 后会自动落盘，不再丢失。
  const [title, setTitle, flushTitle] = useDebouncedCommit(task.title, (v) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== task.title) void upsertTask({ ...task, title: trimmed });
  });
  const initialHours = task.timeEstimate > 0 ? task.timeEstimate / 3_600_000 : '';
  const [hours, setHours, flushHours] = useDebouncedCommit<number | ''>(initialHours, (v) => {
    const next = typeof v === 'number' ? v : 0;
    const ms = hoursToMs(next);
    if (ms !== task.timeEstimate) void upsertTask({ ...task, timeEstimate: ms });
  });
  if (!data) return null;

  const save = (patch: Partial<Task>) => void upsertTask({ ...task, ...patch });
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);
  const systemTagIds = Object.values(SYSTEM_TAG_IDS) as string[];
  const tags = Object.values(data.tags).filter((t) => !systemTagIds.includes(t.id));
  const subTasks = task.subTaskIds.map((id) => data.tasks[id]).filter(Boolean) as Task[];
  const entries = [...task.timeEntries].sort((a, b) => b.end - a.end);
  const today = localDate(Date.now());
  const fmtClock = (ts: number) => {
    const d = new Date(ts);
    return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
  };
  const fmtDur = (ms: number) => {
    const m = Math.floor(ms / 60_000);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
  };

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
          <ChevronLeft />
          关闭
        </Button>
      </div>

      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={flushTitle}
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
            value={hours}
            onChange={(e) => {
              const raw = e.target.value;
              setHours(raw === '' ? '' : Number(raw));
            }}
            onBlur={flushHours}
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
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="删除子任务"
                  className="ml-auto text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (s.timeSpent > 0 || s.timeEntries.length > 0) setConfirmDelete(s);
                    else void deleteTask(s.id);
                  }}
                >
                  <X />
                </Button>
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
            <Plus />
          </Button>
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">计时记录</div>
        {entries.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无计时记录</div>
        ) : (
          <div className="flex flex-col gap-1">
            {entries.map((e) => (
              <div key={`${e.start}-${e.end}`} className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {e.date === today ? '今天' : e.date} {fmtClock(e.start)}–{fmtClock(e.end)}
                </span>
                <span>{fmtDur(e.ms)}</span>
                <div className="ml-auto flex gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="编辑计时记录"
                    onClick={() => setEditEntry(e)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="删除计时记录"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteEntry(e)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">备注</span>
          {!editingNotes && (
            <Button variant="ghost" size="xs" onClick={() => setEditingNotes(true)}>
              <Pencil />
              编辑
            </Button>
          )}
        </div>
        {editingNotes ? (
          <MarkdownEditor
            initialValue={task.notes}
            onDone={(text) => {
              // Done 已经保存；通知 onUnmount 不必再 flush。
              notesHandledRef.current = true;
              setEditingNotes(false);
              if (text !== task.notes) save({ notes: text });
            }}
            onCancel={() => {
              // 取消时不保存；通知 onUnmount 不必 flush。
              notesHandledRef.current = true;
              setEditingNotes(false);
            }}
            onReady={(cherry) => {
              cherryRef.current = cherry;
              // 新一轮编辑会话：尚未被 Done/Cancel 处理过。
              notesHandledRef.current = false;
            }}
            onUnmount={(latest) => {
              // 走到这里说明 MarkdownEditor 被卸载前没有经过 Done / Cancel，
              // 即用户切到了别的任务或关闭了面板——这时把未提交的编辑当作按了 Done。
              if (notesHandledRef.current) return;
              if (latest !== task.notes) void upsertTask({ ...task, notes: latest });
            }}
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

      <EditTimeEntryDialog
        open={editEntry !== null}
        entry={editEntry}
        onSave={(next) => {
          if (editEntry) void upsertTask(applyEntryChange(task, editEntry, next));
        }}
        onClose={() => setEditEntry(null)}
      />

      <DeleteTimeEntryDialog
        open={deleteEntry !== null}
        entry={deleteEntry}
        onConfirm={() => {
          if (deleteEntry) void upsertTask(applyEntryChange(task, deleteEntry, null));
        }}
        onClose={() => setDeleteEntry(null)}
      />
    </div>
  );
}
