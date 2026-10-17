import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useDataStore } from '@/stores/data';
import { Button } from '../ui/button';

/**
 * 「立即运行」：手动触发一次运行（CONTEXT.md）。
 *
 * 它不是演练，是真实执行——所以按钮跑完不隐藏结果，失败时把原因留在按钮下方，同时
 * 那条失败的运行仍然进了运行历史（失败的运行也是审计记录）。
 *
 * 按钮本身不负责刷新历史：运行记录开始落库与结束改写时各发一次运行事件，`bootstrap`
 * 订阅后 bump `runsRevision`，运行历史与列表页因此在**开始时就看见这条 running**。
 * 这条路径同时覆盖定时触发——那才是没人按按钮的那种运行。
 */
export function RunNowButton({ scheduledTaskId }: { scheduledTaskId: string }) {
  const runScheduledTaskNow = useDataStore((s) => s.runScheduledTaskNow);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await runScheduledTaskNow(scheduledTaskId);
      if (!res.ok) setResult(res.error);
    } catch {
      // 抛错说明连运行记录都没能落下来，所以这里给的是"去历史里确认"而不是一句
      // 具体的失败原因——界面并不知道发生了什么，不该编一个。
      setResult('未能启动运行，请检查下方运行历史。');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" disabled={running} onClick={() => void run()}>
        {running ? <Loader2 className="animate-spin" /> : null}
        {running ? '运行中…' : '立即运行'}
      </Button>
      {result && <span className="text-xs text-destructive">{result}</span>}
    </div>
  );
}
