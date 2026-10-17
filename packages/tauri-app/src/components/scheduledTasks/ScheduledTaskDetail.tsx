import type { ScheduledTask } from '@tiny-schedule/shared';
import { Loader2, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { toast } from 'sonner';
import { nextRunLabel } from '@/lib/scheduledTasks';
import { useDebouncedCommit } from '@/lib/useDebouncedCommit';
import { useDataStore } from '@/stores/data';
import { useUiStore } from '@/stores/ui';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { RunHistory } from './RunHistory';
import { RunNowButton } from './RunNowButton';
import { ScheduleEditor } from './ScheduleEditor';
import { useLatestRuns } from './useLatestRuns';

function Section({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <section className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </section>
  );
}

/**
 * 定时任务的详情 / 编辑面板。
 *
 * 字段编辑沿用详情面板的既有节奏：受控输入 + 防抖自动提交（见 `useDebouncedCommit`
 *），启用开关与频率是"改了就该生效"的选择，所以立即提交——停用是一个动作而不是一个
 * 需要点保存的草稿（契约里 `enabled` 缺省即"不动"也正是这个意思）。
 */
export function ScheduledTaskDetail({ task }: { task: ScheduledTask }) {
  const saveScheduledTask = useDataStore((s) => s.saveScheduledTask);
  const deleteScheduledTask = useDataStore((s) => s.deleteScheduledTask);
  const selectScheduledTask = useUiStore((s) => s.selectScheduledTask);
  // 运行历史不进 AppData，运行开始与结束各靠这个计数器触发一次重查。
  const runsRevision = useUiStore((s) => s.runsRevision);
  // 「运行中」标记问的是最近一次运行的状态，与运行历史同一个数据源、同一套刷新机制。
  const latestRun = useLatestRuns([task.id]).get(task.id) ?? null;
  const running = latestRun?.status === 'running';
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [name, setName, flushName] = useDebouncedCommit(task.name, (value) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== task.name) void saveScheduledTask(task, { name: trimmed });
  });

  const [prompt, setPrompt, flushPrompt] = useDebouncedCommit(task.prompt, (value) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== task.prompt) void saveScheduledTask(task, { prompt: trimmed });
  });

  const [workingDirectory, setWorkingDirectory, flushDirectory] = useDebouncedCommit(
    task.workingDirectory ?? '',
    (value) => {
      const trimmed = value.trim();
      // null 是"清空、回到应用默认目录"，与"不动"在契约里是两个意思，所以不能
      // 把空串直接当"不动"提交——那会让用户清不掉已设的执行目录。
      if (trimmed === (task.workingDirectory ?? '')) return;
      void saveScheduledTask(task, {
        workingDirectory: trimmed === '' ? null : trimmed,
      });
    },
  );

  const confirmDeleteNow = async () => {
    setConfirmDelete(false);
    await deleteScheduledTask(task.id);
    selectScheduledTask(null);
    toast.success(`已删除定时任务「${task.name}」`);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto border-l border-border">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 truncate text-sm font-medium">{task.name}</h2>
          {/* 定时触发也会让这个标记亮起来——不只是「立即运行」按下去的那几秒。 */}
          {running && (
            <span className="flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">
              <Loader2 className="h-3 w-3 animate-spin" />
              运行中
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭详情"
            className="text-muted-foreground"
            onClick={() => selectScheduledTask(null)}
          >
            <X />
          </Button>
        </div>

        <Section label="名称">
          <Input
            value={name}
            placeholder="定时任务名称"
            onChange={(e) => setName(e.target.value)}
            onBlur={flushName}
          />
        </Section>

        <Section
          label="频率"
          // 编辑器本身已经显示了选中的星期几/几号，这行补的是它表达不了的那部分：
          // 下一次到底什么时候到点。停用即不再触发，所以停用时不显示任何时间。
          hint={
            task.enabled
              ? `下次触发 ${nextRunLabel(task.schedule, Date.now())}`
              : '已停用，不再触发。'
          }
        >
          <ScheduleEditor
            value={task.schedule}
            onChange={(schedule) => void saveScheduledTask(task, { schedule })}
          />
        </Section>

        <Section
          label="执行目录"
          hint="执行上下文，不是权限边界：定时任务的全部工具默认可用。留空则使用应用默认目录。"
        >
          <Input
            value={workingDirectory}
            placeholder="留空则使用应用默认目录"
            onChange={(e) => setWorkingDirectory(e.target.value)}
            onBlur={flushDirectory}
          />
        </Section>

        <Section label="prompt" hint="到点交给 Agent 执行的一段说明。">
          <Textarea
            value={prompt}
            rows={6}
            placeholder="到点要执行什么"
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={flushPrompt}
          />
        </Section>

        <div className="flex items-center justify-between gap-2">
          <Label className="flex flex-col gap-0.5">
            <span>启用</span>
            <span className="text-xs text-muted-foreground">停用即不再触发。</span>
          </Label>
          <Switch
            checked={task.enabled}
            aria-label="启用"
            onCheckedChange={(enabled) => void saveScheduledTask(task, { enabled })}
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <div>
            <div className="text-xs text-muted-foreground">
              「立即运行」是真实执行，与定时触发走同一个执行器。
            </div>
          </div>
          <RunNowButton scheduledTaskId={task.id} />
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <Label className="text-xs text-muted-foreground">运行历史</Label>
          <RunHistory scheduledTaskId={task.id} refreshToken={runsRevision} />
        </div>

        <div className="border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 />
            删除定时任务
          </Button>
        </div>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除定时任务「{task.name}」？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            删除会连同它的全部运行历史一起移除，运行记录不再可查。此操作不可恢复。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDeleteNow()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
