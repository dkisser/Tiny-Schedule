import { INBOX_PROJECT_ID, SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { blankTask } from '../lib/tasks';
import { useDataStore } from '../stores/data';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

interface AddTaskDialogProps {
  open: boolean;
  onClose: () => void;
  defaultProjectId: string;
  defaultDueDay?: string;
}

export function AddTaskDialog({
  open,
  onClose,
  defaultProjectId,
  defaultDueDay,
}: AddTaskDialogProps) {
  const data = useDataStore((s) => s.data);
  const upsertTask = useDataStore((s) => s.upsertTask);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [tagIds, setTagIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setNotes('');
    setDueDay(defaultDueDay ?? '');
    setProjectId(defaultProjectId);
    setTagIds([]);
  }, [open, defaultProjectId, defaultDueDay]);

  if (!data) return null;

  const projects = Object.values(data.projects).filter((p) => !p.isArchived);
  const systemTagIds = Object.values(SYSTEM_TAG_IDS) as string[];
  const tags = Object.values(data.tags).filter((t) => !systemTagIds.includes(t.id));
  const canSubmit = title.trim().length > 0;

  const toggleTag = (tagId: string) => {
    setTagIds((ids) => (ids.includes(tagId) ? ids.filter((id) => id !== tagId) : [...ids, tagId]));
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || !data) return;
    const project = data.projects[projectId] ?? data.projects[INBOX_PROJECT_ID];
    if (!project) return;
    const tagSnapshots: Record<string, { title: string; color?: string }> = {};
    for (const id of tagIds) {
      const tag = data.tags[id];
      if (tag) tagSnapshots[id] = { title: tag.title, ...(tag.color ? { color: tag.color } : {}) };
    }
    await upsertTask({
      ...blankTask(trimmed, project),
      projectId: project.id,
      projectTitle: project.title,
      notes: notes.trim(),
      dueDay: dueDay || undefined,
      tagIds,
      tagSnapshots: Object.keys(tagSnapshots).length > 0 ? tagSnapshots : undefined,
    });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            placeholder="任务名称"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canSubmit && void submit()}
          />
          <Textarea
            placeholder="备注"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div>
            <div className="mb-1 text-xs text-muted-foreground">截止日</div>
            <Input type="date" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">项目</div>
            <Combobox
              options={projects.map((p) => ({ id: p.id, title: p.title }))}
              value={data.projects[projectId] ? projectId : undefined}
              display={data.projects[projectId]?.title}
              placeholder="选择项目"
              onSelect={setProjectId}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">标签</div>
            <Combobox
              options={tags.map((t) => ({ id: t.id, title: t.title, color: t.color }))}
              selectedIds={tagIds}
              onToggle={toggleTag}
              placeholder="搜索并选择标签"
              display={tagIds.length > 0 ? `已选 ${tagIds.length} 个标签` : undefined}
            />
            {tagIds.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {tagIds.map((id) => (
                  <span
                    key={id}
                    className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
                  >
                    {data.tags[id]?.title ?? id}
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
