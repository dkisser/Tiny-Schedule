import { useEffect, useState } from 'react';
import { api } from '../api';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

export function FinishDayDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const data = useDataStore((s) => s.data);
  const updateSettings = useDataStore((s) => s.updateSettings);
  const setView = useUiStore((s) => s.setView);
  const [analyze, setAnalyze] = useState(false);
  const [autoAnalyze, setAutoAnalyze] = useState(false);
  const [providerId, setProviderId] = useState('');

  useEffect(() => {
    if (open && data) {
      const def =
        data.settings.aiProviders.find((p) => p.isDefault) ?? data.settings.aiProviders[0];
      setProviderId(def?.id ?? '');
      setAnalyze(data.settings.autoAiAnalyzeOnFinishDay);
      setAutoAnalyze(data.settings.autoAiAnalyzeOnFinishDay);
    }
  }, [open, data]);

  if (!data) return null;
  const hasProvider = data.settings.aiProviders.length > 0;

  const confirm = async () => {
    const next = await api().finishDay({ date: new Date().toISOString() });
    useDataStore.setState({ data: next });
    if (autoAnalyze !== data.settings.autoAiAnalyzeOnFinishDay) {
      await updateSettings({ autoAiAnalyzeOnFinishDay: autoAnalyze });
    }
    onClose();
    if (analyze && hasProvider) {
      // hand off an auto-run request to the AI page
      useUiStore.setState({
        aiAutoRun: { scope: 'today', providerId },
        view: { type: 'ai' },
        selectedTaskId: null,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>结束今天？</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          未完成的今日任务将顺延到明天，已完成任务保留在今日记录中。
        </p>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={analyze}
              disabled={!hasProvider}
              onChange={(e) => setAnalyze(e.target.checked)}
            />
            触发 AI 日报分析
          </label>
          {analyze && hasProvider && (
            <select
              className="rounded-md border border-input bg-background px-2 py-1.5"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              {data.settings.aiProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.model}
                  {p.isDefault ? '（默认）' : ''}
                </option>
              ))}
            </select>
          )}
          {!hasProvider && (
            <Button
              variant="link"
              className="justify-start px-0"
              onClick={() => {
                onClose();
                setView({ type: 'settings' });
              }}
            >
              尚未配置 AI Provider，去设置 →
            </Button>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoAnalyze}
              onChange={(e) => setAutoAnalyze(e.target.checked)}
            />
            以后自动触发 AI 分析（不再询问）
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void confirm()}>结束今天</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
