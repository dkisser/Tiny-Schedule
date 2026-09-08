import { type Idea, type IdeaEntry, INBOX_PROJECT_ID, localDate } from '@tiny-schedule/shared';
import type Cherry from 'cherry-markdown';
import {
  Ban,
  Check,
  ChevronLeft,
  Flag,
  ListPlus,
  Pencil,
  Rocket,
  RotateCcw,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import {
  appendIdeaEntry,
  completeIdea,
  deleteIdeaEntry,
  discardIdea,
  ideaPendingVerdict,
  ideaProjectOpenTaskCount,
  ideaToTask,
  reopenIdea,
  updateIdeaEntry,
} from '../lib/ideas';
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

const VERDICT_LABELS = {
  validated: '已验证',
  invalidated: '未验证',
  partial: '部分验证',
} as const;

// 验证目标：一行可编辑文本，防抖提交（同标题编辑模式）。
function ValidationGoalEditor({ idea }: { idea: Idea }) {
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const [goal, setGoal, flushGoal] = useDebouncedCommit(idea.validationGoal ?? '', (v) => {
    const trimmed = v.trim();
    if (trimmed !== (idea.validationGoal ?? '')) {
      void upsertIdea({ ...idea, validationGoal: trimmed || undefined });
    }
  });
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">验证目标</div>
      <Input
        value={goal}
        placeholder="怎么算验证成功？（可选）"
        onChange={(e) => setGoal(e.target.value)}
        onBlur={flushGoal}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

// 演进日志：追加 + hover 编辑/删除（仅验证中可改）。
function IdeaTimeline({ idea, editable }: { idea: Idea; editable: boolean }) {
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const [entryDraft, setEntryDraft] = useState('');
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const addEntry = () => {
    const text = entryDraft.trim();
    if (!text) return;
    void upsertIdea(appendIdeaEntry(idea, text));
    setEntryDraft('');
  };

  const beginEdit = (entry: IdeaEntry) => {
    setEditingEntryId(entry.id);
    setEditingText(entry.text);
  };

  const submitEdit = () => {
    const text = editingText.trim();
    if (editingEntryId && text) void upsertIdea(updateIdeaEntry(idea, editingEntryId, text));
    setEditingEntryId(null);
    setEditingText('');
  };

  const entries = [...(idea.timeline ?? [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">演进日志</div>
      {editable && (
        <div className="flex flex-col gap-2">
          <Textarea
            value={entryDraft}
            placeholder="记录验证过程中的思考、方向调整…"
            onChange={(e) => setEntryDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addEntry();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="self-end"
            disabled={!entryDraft.trim()}
            onClick={addEntry}
          >
            记录
          </Button>
        </div>
      )}
      {entries.length === 0 ? (
        <div className="mt-2 text-sm text-muted-foreground">暂无演进日志</div>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {entries.map((entry) => (
            <div key={entry.id} className="group flex items-start gap-2 text-sm">
              <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                {formatEntryAt(entry.createdAt)}
              </span>
              {editingEntryId === entry.id ? (
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Textarea
                    autoFocus
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitEdit();
                      if (e.key === 'Escape') setEditingEntryId(null);
                    }}
                  />
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="xs" onClick={() => setEditingEntryId(null)}>
                      取消
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!editingText.trim()}
                      onClick={submitEdit}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <Markdown text={entry.text} className="min-w-0 flex-1" />
                  {editable && (
                    <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="编辑记录"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => beginEdit(entry)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="删除记录"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => void upsertIdea(deleteIdeaEntry(idea, entry.id))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function IdeaDetail({ idea }: { idea: Idea }) {
  const data = useDataStore((s) => s.data);
  const upsertTask = useDataStore((s) => s.upsertTask);
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const selectIdea = useUiStore((s) => s.selectIdea);
  const setView = useUiStore((s) => s.setView);
  const selectTask = useUiStore((s) => s.selectTask);
  const setUpgradeIdea = useUiStore((s) => s.setUpgradeIdea);
  const setClosingIdea = useUiStore((s) => s.setClosingIdea);
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

  const status = idea.status;
  const convertedTask = idea.convertedTaskId ? data?.tasks[idea.convertedTaskId] : undefined;
  const project = idea.projectId ? data?.projects[idea.projectId] : undefined;
  const openTaskCount = idea.projectId && data ? ideaProjectOpenTaskCount(data, idea.projectId) : 0;
  const pendingVerdict = data ? ideaPendingVerdict(idea, data) : false;

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

  const openProject = () => {
    if (!idea.projectId) return;
    setView({ type: 'project', id: idea.projectId });
  };

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => selectIdea(null)}>
          <ChevronLeft />
          关闭
        </Button>
      </div>

      {pendingVerdict && (
        <div className="rounded-md bg-amber-500/15 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          关联项目已归档 · 结论待定
        </div>
      )}

      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={flushTitle}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />

      <div className="text-xs text-muted-foreground">
        记录于 {localDate(idea.createdAt)}
        {idea.convertedAt !== undefined && ` · 转任务于 ${localDate(idea.convertedAt)}`}
        {idea.incubatedAt !== undefined && ` · 升级于 ${localDate(idea.incubatedAt)}`}
      </div>

      {status === 'closed' && idea.verdict && (
        <div className="rounded-md border border-border p-2">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Flag className="h-3 w-3" />
            验证结论：{VERDICT_LABELS[idea.verdict.result]} · {localDate(idea.verdict.closedAt)}
          </div>
          {idea.verdict.text && (
            <div className="mt-1 whitespace-pre-wrap text-sm">{idea.verdict.text}</div>
          )}
        </div>
      )}

      {(status === 'incubating' || status === 'closed') && (
        <>
          {status === 'incubating' ? (
            <ValidationGoalEditor idea={idea} />
          ) : (
            idea.validationGoal && (
              <div>
                <div className="mb-1 text-xs text-muted-foreground">验证目标</div>
                <div className="text-sm">{idea.validationGoal}</div>
              </div>
            )
          )}

          {project && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">关联项目</div>
              <div
                role="button"
                tabIndex={0}
                onClick={openProject}
                onKeyDown={(e) => e.key === 'Enter' && openProject()}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-accent/50"
              >
                <span className="min-w-0 flex-1 truncate">{project.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {openTaskCount} 个未完成任务
                </span>
                <SquareArrowOutUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </div>
            </div>
          )}

          <IdeaTimeline idea={idea} editable={status === 'incubating'} />
        </>
      )}

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

      <div className="mt-auto flex flex-col gap-2">
        {status === 'open' && (
          <>
            <div className="flex gap-2">
              <Button variant="default" className="flex-1" onClick={() => setUpgradeIdea(idea.id)}>
                <Rocket />
                升级为项目
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => void convert()}>
                <ListPlus />
                转为任务
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => void upsertIdea(completeIdea(idea))}
              >
                <Check />
                完成
              </Button>
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => void upsertIdea(discardIdea(idea))}
              >
                <Ban />
                废弃
              </Button>
            </div>
          </>
        )}
        {status === 'incubating' && (
          <div className="flex gap-2">
            <Button variant="default" className="flex-1" onClick={() => setClosingIdea(idea.id)}>
              <Flag />
              给出结论
            </Button>
            <Button variant="outline" disabled={!project} onClick={openProject}>
              <SquareArrowOutUpRight />
              打开项目
            </Button>
          </div>
        )}
        {(status === 'done' || status === 'discarded') && (
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => void upsertIdea(reopenIdea(idea))}
          >
            <RotateCcw />
            重新打开
          </Button>
        )}
        {status === 'converted' && (
          <Button variant="outline" className="flex-1" disabled={!convertedTask} onClick={openTask}>
            <SquareArrowOutUpRight />
            打开任务
          </Button>
        )}
        {status === 'closed' && (
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={!project} onClick={openProject}>
              <SquareArrowOutUpRight />
              打开项目
            </Button>
            <Button variant="ghost" onClick={() => setClosingIdea(idea.id)}>
              <Pencil />
              修改结论
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
