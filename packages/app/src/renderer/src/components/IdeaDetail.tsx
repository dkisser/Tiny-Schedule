import { type Idea, INBOX_PROJECT_ID, localDate } from '@tiny-schedule/shared';
import type Cherry from 'cherry-markdown';
import { ChevronLeft, ListPlus, Pencil, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { ideaToTask } from '../lib/ideas';
import { useDebouncedCommit } from '../lib/useDebouncedCommit';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import { MarkdownEditor } from './MarkdownEditor';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Markdown } from './ui/markdown';

export function IdeaDetail({ idea }: { idea: Idea }) {
  const data = useDataStore((s) => s.data);
  const upsertTask = useDataStore((s) => s.upsertTask);
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const deleteIdea = useDataStore((s) => s.deleteIdea);
  const selectIdea = useUiStore((s) => s.selectIdea);
  const setView = useUiStore((s) => s.setView);
  const selectTask = useUiStore((s) => s.selectTask);
  const [editingNotes, setEditingNotes] = useState(false);
  const cherryRef = useRef<Cherry | null>(null);
  // 标记 Done / Cancel 已经处理过当前编辑会话，MarkdownEditor 卸载时不要重复 flush。
  const notesHandledRef = useRef(false);

  const [title, setTitle, flushTitle] = useDebouncedCommit(idea.title, (v) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== idea.title) {
      void upsertIdea({ ...idea, title: trimmed });
    }
  });

  const isConverted = idea.convertedAt !== undefined;
  const convertedTask = idea.convertedTaskId ? data?.tasks[idea.convertedTaskId] : undefined;

  const convert = async () => {
    const inbox = data?.projects[INBOX_PROJECT_ID];
    if (!inbox) return;
    const { task, converted } = ideaToTask(idea, inbox);
    await upsertTask(task);
    await upsertIdea(converted);
  };

  const openTask = () => {
    if (!convertedTask) return;
    setView({ type: 'project', id: convertedTask.projectId });
    selectTask(convertedTask.id);
  };

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => selectIdea(null)}>
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

      <div className="text-xs text-muted-foreground">
        记录于 {localDate(idea.createdAt)}
        {isConverted &&
          idea.convertedAt !== undefined &&
          ` · 转化于 ${localDate(idea.convertedAt)}`}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">备注</span>
          {!editingNotes && !isConverted && (
            <Button variant="ghost" size="xs" onClick={() => setEditingNotes(true)}>
              <Pencil />
              编辑
            </Button>
          )}
        </div>
        {editingNotes ? (
          <MarkdownEditor
            initialValue={idea.notes}
            onDone={(text) => {
              // Done 已经保存；通知 onUnmount 不必再 flush。
              notesHandledRef.current = true;
              setEditingNotes(false);
              if (text !== idea.notes) void upsertIdea({ ...idea, notes: text });
            }}
            onCancel={() => {
              notesHandledRef.current = true;
              setEditingNotes(false);
            }}
            onReady={(cherry) => {
              cherryRef.current = cherry;
              notesHandledRef.current = false;
            }}
            onUnmount={(latest) => {
              if (notesHandledRef.current) return;
              if (latest !== idea.notes) void upsertIdea({ ...idea, notes: latest });
            }}
          />
        ) : idea.notes ? (
          <Markdown text={idea.notes} className="rounded-md border border-border p-2" />
        ) : (
          <div className="text-sm text-muted-foreground">暂无备注</div>
        )}
      </div>

      <div className="mt-auto flex gap-2">
        {isConverted ? (
          <Button variant="outline" className="flex-1" disabled={!convertedTask} onClick={openTask}>
            <SquareArrowOutUpRight />
            打开任务
          </Button>
        ) : (
          <Button variant="outline" className="flex-1" onClick={() => void convert()}>
            <ListPlus />
            转为任务
          </Button>
        )}
        <Button
          variant="ghost"
          className="text-destructive"
          onClick={() => {
            selectIdea(null);
            void deleteIdea(idea.id);
          }}
        >
          <Trash2 />
          删除
        </Button>
      </div>
    </div>
  );
}
