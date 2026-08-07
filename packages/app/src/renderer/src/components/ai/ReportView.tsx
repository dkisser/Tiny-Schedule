import type { AiSummary } from '@tiny-schedule/shared';
import { Bot, Check, ChevronRight, Copy, MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../../api';
import { useDataStore } from '../../stores/data';
import { useUiStore } from '../../stores/ui';
import { Button } from '../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="复制"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

export function ReportView() {
  const data = useDataStore((s) => s.data);
  const setView = useUiStore((s) => s.setView);
  const setAiView = useUiStore((s) => s.setAiView);
  const [scope, setScope] = useState<'today' | 'week' | 'project'>('today');
  const [projectId, setProjectId] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const off = api().onAiEvent((ev) => {
      if (ev.requestId !== requestIdRef.current) return;
      if (ev.delta) setOutput((o) => o + ev.delta);
      if (ev.full !== undefined) {
        setOutput(ev.full); // reconcile any missed deltas
        setRunning(false);
        // Main persisted the summary before sending done; refresh to show it in history.
        void useDataStore.getState().load();
      }
      if (ev.error) {
        setError(
          ev.error === 'NO_PROVIDER_CONFIGURED' ? '尚未配置 AI Provider' : `分析失败：${ev.error}`,
        );
        setRunning(false);
      }
    });
    return off;
  }, []);

  const run = async () => {
    setOutput('');
    setError('');
    setRunning(true);
    try {
      const { requestId } = await api().aiAnalyze({
        scope,
        projectId: scope === 'project' ? projectId : undefined,
      });
      requestIdRef.current = requestId;
    } catch (err) {
      setError(`分析失败：${err instanceof Error ? err.message : String(err)}`);
      setRunning(false);
    }
  };

  const runWith = async (s: 'today' | 'week' | 'project', providerId: string) => {
    setScope(s);
    setOutput('');
    setError('');
    setRunning(true);
    try {
      const { requestId } = await api().aiAnalyze({ scope: s, providerId });
      requestIdRef.current = requestId;
    } catch (err) {
      setError(`分析失败：${err instanceof Error ? err.message : String(err)}`);
      setRunning(false);
    }
  };

  // Finish Day 自动触发：Task 13 的 ui store 中的 aiAutoRun 交接
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only handoff
  useEffect(() => {
    const auto = useUiStore.getState().aiAutoRun;
    if (auto) {
      useUiStore.setState({ aiAutoRun: null });
      void runWith(auto.scope, auto.providerId);
    }
  }, []);

  if (!data) return null;
  const hasProvider = data.settings.aiProviders.length > 0;
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);
  const history = (data.misc.aiHistory ?? []) as AiSummary[];
  const scopeLabel = (s: AiSummary) =>
    s.scope === 'today'
      ? '今日日报'
      : s.scope === 'week'
        ? '本周周报'
        : (data.projects[s.projectId ?? '']?.title ?? '项目');

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">分析</h1>
        <Button variant="ghost" size="icon" aria-label="对话" onClick={() => setAiView('chat')}>
          <MessageSquare className="h-4 w-4" />
        </Button>
      </div>
      {!hasProvider && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          尚未配置 AI Provider。
          <Button variant="link" className="px-1" onClick={() => setView({ type: 'settings' })}>
            去设置
          </Button>
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        <select
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          value={scope}
          onChange={(e) => setScope(e.target.value as never)}
        >
          <option value="today">今日日报</option>
          <option value="week">本周周报</option>
          <option value="project">指定项目</option>
        </select>
        {scope === 'project' && (
          <select
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">选择项目…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        )}
        <Button
          disabled={!hasProvider || running || (scope === 'project' && !projectId)}
          onClick={() => void run()}
        >
          <Bot className="mr-1 h-4 w-4" />
          {running ? '分析中…' : '开始分析'}
        </Button>
        {output && <CopyButton text={output} />}
      </div>
      {error && <div className="mt-3 text-sm text-destructive">{error}</div>}
      {output && (
        <div className="prose prose-sm dark:prose-invert mt-4 max-w-none rounded-lg border border-border p-4">
          <ReactMarkdown>{output}</ReactMarkdown>
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">历史总结</h2>
          <div className="flex flex-col gap-2">
            {history.map((s, i) => (
              <Collapsible
                key={s.id}
                defaultOpen={i === 0}
                className="rounded-lg border border-border bg-card"
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
                    <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                    <span className="shrink-0">{formatTime(s.createdAt)}</span>
                    <span className="truncate rounded bg-secondary px-1.5 text-xs">
                      {scopeLabel(s)}
                    </span>
                  </CollapsibleTrigger>
                  <CopyButton text={s.content} />
                </div>
                <CollapsibleContent>
                  <div className="prose prose-sm dark:prose-invert max-w-none border-t border-border p-4">
                    <ReactMarkdown>{s.content}</ReactMarkdown>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
