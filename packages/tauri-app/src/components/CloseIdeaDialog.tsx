import type { IdeaVerdict } from '@tiny-schedule/shared';
import { useEffect, useState } from 'react';
import { closeIdeaWithVerdict } from '../lib/ideas';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Textarea } from './ui/textarea';

const RESULTS: { value: IdeaVerdict['result']; label: string }[] = [
  { value: 'validated', label: '已验证' },
  { value: 'invalidated', label: '未验证' },
  { value: 'partial', label: '部分验证' },
];

// 验证闭环弹窗。三个触发点：归档项目时、想法详情"给出结论"、"修改结论"。
// closed 状态下打开即修改结论模式：回填现有 verdict，不显示"暂不确定"。
export function CloseIdeaDialog() {
  const data = useDataStore((s) => s.data);
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const ideaId = useUiStore((s) => s.closingIdeaId);
  const setClosingIdea = useUiStore((s) => s.setClosingIdea);
  const [result, setResult] = useState<IdeaVerdict['result']>('validated');
  const [text, setText] = useState('');

  const idea = ideaId && data ? data.ideas[ideaId] : undefined;
  const open = !!idea;
  const editing = idea?.status === 'closed';

  useEffect(() => {
    if (!ideaId) return;
    const idea = useDataStore.getState().data?.ideas[ideaId];
    if (!idea) return;
    setResult(idea.verdict?.result ?? 'validated');
    setText(idea.verdict?.text ?? '');
    // 只在弹窗打开（ideaId 变化）时回填；数据刷新不应打断正在填写的结论。
  }, [ideaId]);

  if (!idea) return null;

  const confirm = async () => {
    await upsertIdea(closeIdeaWithVerdict(idea, result, text.trim() || undefined));
    setClosingIdea(null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setClosingIdea(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>想法《{idea.title}》得到验证了吗？</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {idea.validationGoal && (
            <div className="rounded-md bg-secondary px-3 py-2 text-sm text-muted-foreground">
              当初的验证目标：{idea.validationGoal}
            </div>
          )}
          <div className="flex gap-1">
            {RESULTS.map((r) => (
              <Button
                key={r.value}
                variant={result === r.value ? 'default' : 'outline'}
                size="sm"
                className={cn('flex-1')}
                onClick={() => setResult(r.value)}
              >
                {r.label}
              </Button>
            ))}
          </div>
          <Textarea
            placeholder="结论说明（可选）"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <DialogFooter>
          {!editing && (
            <Button variant="ghost" onClick={() => setClosingIdea(null)}>
              暂不确定
            </Button>
          )}
          <Button variant="outline" onClick={() => setClosingIdea(null)}>
            取消
          </Button>
          <Button onClick={() => void confirm()}>{editing ? '保存结论' : '确认结论'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
