import type { TimeEntry } from '@tiny-schedule/shared';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function DeleteTimeEntryDialog({
  open,
  entry,
  onConfirm,
  onClose,
}: {
  open: boolean;
  entry: TimeEntry | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除这条计时记录？</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          该记录时长 {entry ? formatDuration(entry.ms) : ''}
          ，删除后对应时长会从任务统计中扣除，且不可恢复。
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
