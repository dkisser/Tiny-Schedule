import { PROJECT_TITLE_MAX_LENGTH } from '@tiny-schedule/shared';
import { useEffect, useState } from 'react';
import { upgradeIdeaToProject } from '../lib/ideas';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

// 升级为项目：创建专属项目（一对一）并把想法带入验证中。不做 icon/color 选择。
export function UpgradeIdeaDialog() {
  const data = useDataStore((s) => s.data);
  const createProject = useDataStore((s) => s.createProject);
  const upsertIdea = useDataStore((s) => s.upsertIdea);
  const ideaId = useUiStore((s) => s.upgradeIdeaId);
  const setUpgradeIdea = useUiStore((s) => s.setUpgradeIdea);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');

  const idea = ideaId && data ? data.ideas[ideaId] : undefined;
  const open = !!idea;

  useEffect(() => {
    if (!ideaId) return;
    const idea = useDataStore.getState().data?.ideas[ideaId];
    if (!idea) return;
    setTitle(idea.title.slice(0, PROJECT_TITLE_MAX_LENGTH));
    setGoal(idea.validationGoal ?? '');
    // 只在弹窗打开（ideaId 变化）时重置草稿；createProject 引起的数据刷新不应清空输入。
  }, [ideaId]);

  if (!idea) return null;

  const canSubmit = title.trim().length > 0;

  const submit = async () => {
    const trimmed = title.trim();
    const trimmedGoal = goal.trim();
    if (!trimmed) return;
    const project = await createProject(trimmed);
    if (!project) return;
    await upsertIdea(upgradeIdeaToProject(idea, project.id, trimmedGoal || undefined));
    setUpgradeIdea(null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setUpgradeIdea(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>升级为项目</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">项目名</div>
            <Input
              autoFocus
              value={title}
              maxLength={PROJECT_TITLE_MAX_LENGTH}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canSubmit && void submit()}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">验证目标</div>
            <Textarea
              placeholder="怎么算验证成功？（可选）"
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setUpgradeIdea(null)}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            升级
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
