import { Bot, Plus, ScrollText, Square, Trash2, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { type DisplayMessage, toDisplayMessages } from '../../lib/chatMessages';
import { subscribeChatEvents, useChatStore } from '../../stores/chat';
import { useDataStore } from '../../stores/data';
import { Button } from '../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

function StatusBanner() {
  const status = useChatStore((s) => s.status);
  const detail = useChatStore((s) => s.statusDetail);
  const stop = useChatStore((s) => s.stop);
  const retry = useChatStore((s) => s.retry);
  if (status === 'idle') return null;
  // store stop() 不清 streamText/toolCards，这里一并复位流状态
  const handleStop = async () => {
    await stop();
    useChatStore.setState({ streamText: '', toolCards: [] });
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-2 text-sm">
      {status === 'running' && (
        <>
          <span className="flex-1">分析中…</span>
          <Button variant="outline" size="sm" onClick={() => void handleStop()}>
            <Square className="mr-1 h-3 w-3" />
            停止
          </Button>
        </>
      )}
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

function ToolCardItem({
  name,
  status,
  args,
  resultSummary,
}: {
  name: string;
  status: 'running' | 'done' | 'error';
  args?: unknown;
  resultSummary?: string;
}) {
  const detail = resultSummary || (args !== undefined ? JSON.stringify(args, null, 2) : '暂无详情');
  return (
    <Collapsible className="rounded-md border border-border bg-secondary/30">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <Wrench className="h-3 w-3" />
        <span>{name}</span>
        <span>{status === 'running' ? '执行中…' : status === 'error' ? '失败' : '完成'}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-40 overflow-auto border-t border-border p-2 text-xs">{detail}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCards() {
  const cards = useChatStore((s) => s.toolCards);
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {cards.map((c) => (
        <ToolCardItem
          key={c.toolCallId}
          name={c.name}
          status={c.status}
          args={c.args}
          resultSummary={c.resultSummary}
        />
      ))}
    </div>
  );
}

function HistoryToolCard({ m, messages }: { m: DisplayMessage; messages: DisplayMessage[] }) {
  if (m.kind === 'tool') {
    // 用同 toolCallId 的 toolResult 的 isError 决定 失败/完成 状态，而非硬编码 done
    const result = messages.find(
      (x): x is Extract<DisplayMessage, { kind: 'toolResult' }> =>
        x.kind === 'toolResult' && x.toolCallId === m.toolCallId,
    );
    return (
      <ToolCardItem name={m.toolName} status={result?.isError ? 'error' : 'done'} args={m.args} />
    );
  }
  if (m.kind === 'toolResult') {
    return (
      <ToolCardItem name="工具结果" status={m.isError ? 'error' : 'done'} resultSummary={m.text} />
    );
  }
  return null;
}

export function ChatView({ onBack }: { onBack: () => void }) {
  const data = useDataStore((s) => s.data);
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const streamText = useChatStore((s) => s.streamText);
  const load = useChatStore((s) => s.load);
  const create = useChatStore((s) => s.create);
  const remove = useChatStore((s) => s.remove);
  const select = useChatStore((s) => s.select);
  const send = useChatStore((s) => s.send);
  const [input, setInput] = useState('');
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

  const submit = () => {
    const text = input.trim();
    if (!text || !hasProvider) return;
    setInput('');
    void send(text);
  };

  return (
    <div className="flex h-full">
      <div className="flex w-52 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between p-3">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="返回报告" onClick={onBack}>
              <ScrollText className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium">会话</span>
          </div>
          <Button variant="ghost" size="icon" aria-label="新建会话" onClick={() => void create()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
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
              <button
                type="button"
                aria-label="删除会话"
                className="hidden text-muted-foreground hover:text-destructive group-hover:block"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(s.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
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
              if (m.kind === 'assistant')
                return (
                  <div
                    key={i}
                    className="prose prose-sm dark:prose-invert max-w-none rounded-lg border border-border p-3"
                  >
                    <ReactMarkdown>{m.text}</ReactMarkdown>
                  </div>
                );
              // tool/toolResult 历史条目以折叠卡展示（与实时 toolCards 同款式）
              return <HistoryToolCard key={i} m={m} messages={messages} />;
            })}
            <ToolCards />
            {streamText && (
              <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border border-border p-3">
                <ReactMarkdown>{streamText}</ReactMarkdown>
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
              disabled={!hasProvider}
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
            <Button disabled={!hasProvider || !input.trim()} onClick={submit}>
              <Bot className="mr-1 h-4 w-4" />
              发送
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
