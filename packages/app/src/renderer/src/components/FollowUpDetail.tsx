import type { FollowUp } from '@tiny-schedule/shared';
import type Cherry from 'cherry-markdown';
import { CheckCircle2, ChevronLeft, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { newFollowUpId, waitingDays } from '../lib/followUps';
import { useDebouncedCommit } from '../lib/useDebouncedCommit';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import { MarkdownEditor } from './MarkdownEditor';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Markdown } from './ui/markdown';
import { Textarea } from './ui/textarea';

function formatEntryAt(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FollowUpDetail({ followUp }: { followUp: FollowUp }) {
  const upsertFollowUp = useDataStore((s) => s.upsertFollowUp);
  const deleteFollowUp = useDataStore((s) => s.deleteFollowUp);
  const selectFollowUp = useUiStore((s) => s.selectFollowUp);
  const [editingNotes, setEditingNotes] = useState(false);
  const [entryDraft, setEntryDraft] = useState('');
  const cherryRef = useRef<Cherry | null>(null);
  // 标记 Done / Cancel 已经处理过当前编辑会话，MarkdownEditor 卸载时不要重复 flush。
  const notesHandledRef = useRef(false);

  const [title, setTitle, flushTitle] = useDebouncedCommit(followUp.title, (v) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== followUp.title) {
      void upsertFollowUp({ ...followUp, title: trimmed });
    }
  });

  const save = (patch: Partial<FollowUp>) => void upsertFollowUp({ ...followUp, ...patch });

  const addEntry = () => {
    const text = entryDraft.trim();
    if (!text) return;
    save({ entries: [...followUp.entries, { id: newFollowUpId(), at: Date.now(), text }] });
    setEntryDraft('');
  };

  const entries = [...followUp.entries].sort((a, b) => b.at - a.at);

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => selectFollowUp(null)}>
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

      <div className="text-xs text-muted-foreground">已等待 {waitingDays(followUp)} 天</div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">下次跟进日期</div>
        <Input
          type="date"
          value={followUp.nextFollowUpDay ?? ''}
          onChange={(e) => save({ nextFollowUpDay: e.target.value || undefined })}
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">备注（在等谁 / 背景）</span>
          {!editingNotes && (
            <Button variant="ghost" size="xs" onClick={() => setEditingNotes(true)}>
              <Pencil />
              编辑
            </Button>
          )}
        </div>
        {editingNotes ? (
          <MarkdownEditor
            initialValue={followUp.notes}
            onDone={(text) => {
              // Done 已经保存；通知 onUnmount 不必再 flush。
              notesHandledRef.current = true;
              setEditingNotes(false);
              if (text !== followUp.notes) save({ notes: text });
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
              if (latest !== followUp.notes) void upsertFollowUp({ ...followUp, notes: latest });
            }}
          />
        ) : followUp.notes ? (
          <Markdown text={followUp.notes} className="rounded-md border border-border p-2" />
        ) : (
          <div className="text-sm text-muted-foreground">暂无备注</div>
        )}
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">跟进记录</div>
        {!followUp.isResolved && (
          <div className="flex flex-col gap-2">
            <Textarea
              value={entryDraft}
              placeholder="记录一次跟进（如：电话询问，仍在审核）"
              onChange={(e) => setEntryDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void addEntry();
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="self-end"
              disabled={!entryDraft.trim()}
              onClick={() => void addEntry()}
            >
              记录
            </Button>
          </div>
        )}
        {entries.length === 0 ? (
          <div className="mt-2 text-sm text-muted-foreground">暂无跟进记录</div>
        ) : (
          <div className="mt-2 flex flex-col gap-1">
            {entries.map((entry) => (
              <div key={entry.id} className="group flex items-start gap-2 text-sm">
                <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                  {formatEntryAt(entry.at)}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{entry.text}</span>
                {!followUp.isResolved && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="删除记录"
                    className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                    onClick={() =>
                      save({ entries: followUp.entries.filter((e) => e.id !== entry.id) })
                    }
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-auto flex gap-2">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() =>
            save(
              followUp.isResolved
                ? { isResolved: false, resolvedAt: undefined }
                : { isResolved: true, resolvedAt: Date.now() },
            )
          }
        >
          {followUp.isResolved ? (
            <>
              <RotateCcw />
              恢复跟进
            </>
          ) : (
            <>
              <CheckCircle2 />
              办结
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          className="text-destructive"
          onClick={() => {
            selectFollowUp(null);
            void deleteFollowUp(followUp.id);
          }}
        >
          <Trash2 />
          删除
        </Button>
      </div>
    </div>
  );
}
