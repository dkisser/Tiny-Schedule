import type { Schedule } from '@tiny-schedule/shared';
import { useState } from 'react';
import { useDataStore } from '@/stores/data';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { ScheduleEditor } from './ScheduleEditor';

/** 新建时的默认频率，与 `blankScheduledTask` 一致：每天 09:00。 */
const DEFAULT_SCHEDULE: Schedule = { kind: 'daily', time: '09:00' };

/**
 * 新建定时任务。
 *
 * 名称、prompt、频率一起在这里收齐，而不是先建一条空任务再补：prompt 在存储层是必填，
 * 而一条"名字有了、prompt 还没有"的定时任务照样会到点触发——那会真的启动一次 Agent
 * 去执行一段空话。宁可不建，也不建一条用户没意识到它会跑的空规则。
 */
export function NewScheduledTaskDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (scheduledTaskId: string) => void;
}) {
  const createScheduledTask = useDataStore((s) => s.createScheduledTask);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState<Schedule>(DEFAULT_SCHEDULE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && prompt.trim().length > 0 && !submitting;

  const reset = () => {
    setName('');
    setPrompt('');
    setSchedule(DEFAULT_SCHEDULE);
    setError(null);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const id = await createScheduledTask({
        name: name.trim(),
        prompt: prompt.trim(),
        schedule,
      });
      // 被存储层拒绝时对话框不关：草稿是在关闭时才清掉的，关掉等于替用户把刚敲的
      // 东西丢掉。提示说明的是发生了什么，不是为什么。
      if (!id) {
        setError('未能保存：数据存储当前不可写（只读模式下所有写入都会被拒绝）。');
        return;
      }
      reset();
      onCreated(id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '新建失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setError(null);
        onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建定时任务</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-scheduled-task-name">名称</Label>
            <Input
              id="new-scheduled-task-name"
              autoFocus
              value={name}
              placeholder="如 每日巡检仓库"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>频率</Label>
            <ScheduleEditor value={schedule} onChange={setSchedule} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-scheduled-task-prompt">prompt</Label>
            <Textarea
              id="new-scheduled-task-prompt"
              value={prompt}
              rows={5}
              placeholder="到点交给 Agent 执行的一段说明"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            新建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
