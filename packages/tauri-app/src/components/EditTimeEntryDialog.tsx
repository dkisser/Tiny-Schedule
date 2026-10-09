import { localDate, type TimeEntry } from '@tiny-schedule/shared';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function EditTimeEntryDialog({
  open,
  entry,
  onSave,
  onClose,
}: {
  open: boolean;
  entry: TimeEntry | null;
  onSave: (next: TimeEntry) => void;
  onClose: () => void;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  useEffect(() => {
    if (open && entry) {
      setStart(toLocalInput(entry.start));
      setEnd(toLocalInput(entry.end));
    }
  }, [open, entry]);

  const startTs = start ? new Date(start).getTime() : Number.NaN;
  const endTs = end ? new Date(end).getTime() : Number.NaN;
  const valid = Number.isFinite(startTs) && Number.isFinite(endTs) && endTs > startTs;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑计时记录</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            开始时间
            <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            结束时间
            <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="text-sm text-muted-foreground">
            时长：{valid ? formatDuration(endTs - startTs) : '—（结束时间需晚于开始时间）'}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSave({ date: localDate(endTs), start: startTs, end: endTs, ms: endTs - startTs });
              onClose();
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
