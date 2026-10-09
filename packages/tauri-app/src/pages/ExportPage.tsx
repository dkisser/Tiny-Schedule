import { Download, Upload } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { useDataStore } from '../stores/data';

export function ExportPage() {
  const data = useDataStore((s) => s.data);
  const load = useDataStore((s) => s.load);
  const [projectId, setProjectId] = useState('');
  const [message, setMessage] = useState('');

  if (!data) return null;
  // Stats / exports must include archived projects; sort for a stable dropdown.
  const projects = Object.values(data.projects).sort((a, b) => a.title.localeCompare(b.title));

  const runImport = async () => {
    setMessage('导入中…');
    try {
      const res = await api().importRun();
      if (res.ok && res.counts) {
        setMessage(
          `✓ 导入成功：${res.counts.tasks} 任务 / ${res.counts.projects} 项目 / ${res.counts.tags} 标签`,
        );
        await load();
      } else if (res.error && res.error !== 'CANCELLED') {
        setMessage(`✗ 导入失败：${res.error}`);
      } else {
        setMessage('');
      }
    } catch (err) {
      setMessage(`✗ 导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runExport = async (mode: 'projectList' | 'worklog') => {
    setMessage('导出中…');
    try {
      const res = await api().exportMarkdown(
        mode === 'projectList'
          ? { mode, projectId }
          : { mode, from: '1970-01-01', to: '2999-12-31' },
      );
      setMessage(res.savedPath ? `✓ 已保存：${res.savedPath}` : res.error ? `✗ ${res.error}` : '');
    } catch (err) {
      setMessage(`✗ 导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">导入 / 导出</h1>

      <section className="mt-6 rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium">导入 Super Productivity 备份</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          整库导入，将覆盖当前任务/项目/标签数据（设置保留）。导入前会自动备份当前数据。
        </p>
        <Button className="mt-3" onClick={() => void runImport()}>
          <Upload />
          选择备份 JSON
        </Button>
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium">导出项目任务清单</h2>
        <div className="mt-3 flex gap-2">
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
          <Button disabled={!projectId} onClick={() => void runExport('projectList')}>
            <Download />
            导出 .md
          </Button>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium">导出工作日志（全部时间）</h2>
        <Button className="mt-3" onClick={() => void runExport('worklog')}>
          <Download />
          导出 .md
        </Button>
      </section>

      {message && <div className="mt-4 text-sm">{message}</div>}
    </div>
  );
}
