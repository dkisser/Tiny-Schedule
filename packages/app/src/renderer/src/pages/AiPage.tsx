import { Bot, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';

export function AiPage() {
  const data = useDataStore((s) => s.data);
  const setView = useUiStore((s) => s.setView);
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
      if (ev.full !== undefined) setRunning(false);
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
    const { requestId } = await api().aiAnalyze({
      scope,
      projectId: scope === 'project' ? projectId : undefined,
    });
    requestIdRef.current = requestId;
  };

  const runWith = async (s: 'today' | 'week' | 'project', providerId: string) => {
    setScope(s);
    setOutput('');
    setError('');
    setRunning(true);
    const { requestId } = await api().aiAnalyze({ scope: s, providerId });
    requestIdRef.current = requestId;
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

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">AI 分析</h1>
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
        {output && (
          <Button variant="outline" onClick={() => void navigator.clipboard.writeText(output)}>
            <Copy className="h-4 w-4" />
          </Button>
        )}
      </div>
      {error && <div className="mt-3 text-sm text-destructive">{error}</div>}
      {output && (
        <div className="prose prose-sm dark:prose-invert mt-4 max-w-none rounded-lg border border-border p-4">
          <ReactMarkdown>{output}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
