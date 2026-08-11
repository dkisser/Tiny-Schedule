import type { ChatSession } from '@tiny-schedule/shared';
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type DisplayMessage, toDisplayMessages } from '../../lib/chatMessages';
import { subscribeChatEvents, useChatStore } from '../../stores/chat';
import { useDataStore } from '../../stores/data';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Markdown } from '../ui/markdown';

function StatusBanner() {
  const status = useChatStore((s) => s.status);
  const detail = useChatStore((s) => s.statusDetail);
  const retry = useChatStore((s) => s.retry);
  if (status === 'idle') return null;
  // 停止入口在输入区的「停止」按钮，这里只提示进行中状态
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-2 text-sm">
      {status === 'running' && <span className="flex-1">分析中…</span>}
      {status === 'retrying' && <span className="flex-1 text-amber-500">{detail}</span>}
      {status === 'failed' && (
        <>
          <span className="flex-1 text-destructive">{detail || '请求失败'}</span>
          <Button variant="outline" size="sm" onClick={() => void retry()}>
            重试
          </Button>
        </>
      )}
    </div>
  );
}

function ToolCardItem({ name, status }: { name: string; status: 'running' | 'done' | 'error' }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2 py-1.5 text-xs text-muted-foreground">
      {status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'done' && <Check className="h-3 w-3" />}
      {status === 'error' && <AlertCircle className="h-3 w-3 text-destructive" />}
      <span className={status === 'error' ? 'text-destructive' : undefined}>
        {status === 'running'
          ? `正在调用 ${name}…`
          : status === 'error'
            ? `${name} 失败`
            : `${name} 完成`}
      </span>
    </div>
  );
}

function ToolCards() {
  const cards = useChatStore((s) => s.toolCards);
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {cards.map((c) => (
        <ToolCardItem key={c.toolCallId} name={c.name} status={c.status} />
      ))}
    </div>
  );
}

function HistoryToolCard({ m, messages }: { m: DisplayMessage; messages: DisplayMessage[] }) {
  // toolResult 不单独展示（入参/结果不在页面呈现），仅由 tool 卡片汇总状态
  if (m.kind !== 'tool') return null;
  // 用同 toolCallId 的 toolResult 的 isError 决定 失败/完成 状态，而非硬编码 done
  const result = messages.find(
    (x): x is Extract<DisplayMessage, { kind: 'toolResult' }> =>
      x.kind === 'toolResult' && x.toolCallId === m.toolCallId,
  );
  return <ToolCardItem name={m.toolName} status={result?.isError ? 'error' : 'done'} />;
}

export function ChatView({ onBack }: { onBack: () => void }) {
  const data = useDataStore((s) => s.data);
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const streamText = useChatStore((s) => s.streamText);
  const status = useChatStore((s) => s.status);
  const load = useChatStore((s) => s.load);
  const create = useChatStore((s) => s.create);
  const remove = useChatStore((s) => s.remove);
  const select = useChatStore((s) => s.select);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const retry = useChatStore((s) => s.retry);
  const [input, setInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const active = sessions.find((s) => s.id === activeSessionId);
  const messages = active ? toDisplayMessages(active.messages) : [];

  useEffect(() => {
    void load();
    return subscribeChatEvents();
  }, [load]);

  // messages 在 chatDone 刷新会话后变化，也要触发滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [streamText, activeSessionId, messages]);

  if (!data) return null;
  const hasProvider = data.settings.aiProviders.length > 0;
  // run 进行中（running/retrying）禁用输入与发送，从 UI 上杜绝双发/抢占在途 run
  const isBusy = status === 'running' || status === 'retrying';

  const submit = () => {
    const text = input.trim();
    if (!text || !hasProvider || isBusy) return;
    setInput('');
    void send(text);
  };

  return (
    <div className="flex h-full">
      <div className="flex w-52 shrink-0 flex-col border-r border-border">
        <div className="flex flex-col gap-1 p-3 pb-2">
          <Button
            variant="ghost"
            size="sm"
            className="justify-start"
            aria-label="返回报告"
            onClick={onBack}
          >
            <ScrollText />
            报告
          </Button>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="sm"
              title="新建会话"
              className="min-w-0 flex-1 justify-start"
              onClick={() => {
                // 新建（空白会话复用）后展开列表，确保能看到选中的会话
                setListOpen(true);
                void create();
              }}
            >
              <Plus />
              <span>会话</span>
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={listOpen ? '收起会话列表' : '展开会话列表'}
              className="text-muted-foreground"
              onClick={() => setListOpen((v) => !v)}
            >
              {listOpen ? <ChevronDown /> : <ChevronRight />}
            </Button>
          </div>
        </div>
        {listOpen && (
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-secondary ${
                  s.id === activeSessionId ? 'bg-secondary' : ''
                }`}
                onClick={() => select(s.id)}
              >
                <span className="min-w-0 flex-1 truncate">{s.title || '新会话'}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="删除会话"
                  className="hidden text-muted-foreground hover:text-destructive group-hover:inline-flex"
                  onClick={(e) => {
                    e.stopPropagation();
                    // 空会话没有可丢失的内容，直接删除
                    if (s.messages.length === 0) void remove(s.id);
                    else setDeleteTarget(s);
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {messages.map((m, i) => {
              if (m.kind === 'user')
                return (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                      {m.text}
                    </div>
                  </div>
                );
              if (m.kind === 'assistant') {
                const aborted = m.stopReason === 'aborted';
                const isLast = i === messages.length - 1;
                return (
                  <div key={i} className="flex flex-col gap-1">
                    <div className="rounded-lg border border-border p-3">
                      {m.text ? (
                        <Markdown text={m.text} />
                      ) : (
                        <p className="text-sm text-muted-foreground">回答已中断</p>
                      )}
                    </div>
                    {aborted && isLast && status === 'idle' && (
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-label="重新生成回答"
                        className="self-start text-muted-foreground"
                        onClick={() => void retry()}
                      >
                        <RotateCw />
                        重试
                      </Button>
                    )}
                  </div>
                );
              }
              // tool/toolResult 历史条目以折叠卡展示（与实时 toolCards 同款式）
              return <HistoryToolCard key={i} m={m} messages={messages} />;
            })}
            <ToolCards />
            {streamText && (
              <div className="rounded-lg border border-border p-3">
                <Markdown text={streamText} />
              </div>
            )}
            <StatusBanner />
          </div>
        </div>
        <div className="border-t border-border p-3">
          <div className="mx-auto flex max-w-2xl items-end gap-2">
            <textarea
              className="min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder={
                hasProvider
                  ? '输入问题，例如：本周时间都花在哪了？'
                  : '尚未配置 AI Provider，请先去设置'
              }
              value={input}
              disabled={!hasProvider || isBusy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // isComposing：中文输入法候选确认时不触发发送
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
            />
            {isBusy ? (
              <Button variant="outline" onClick={() => setStopConfirmOpen(true)}>
                <Square />
                停止
              </Button>
            ) : (
              <Button disabled={!hasProvider || !input.trim()} onClick={submit}>
                <Bot />
                发送
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除「{deleteTarget?.title || '新会话'}」？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">删除后所有对话记录将无法恢复。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) void remove(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stopConfirmOpen} onOpenChange={(o) => !o && setStopConfirmOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停止当前回答？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">已生成的内容会保留，可随时重试。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopConfirmOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setStopConfirmOpen(false);
                void stop();
              }}
            >
              停止
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
