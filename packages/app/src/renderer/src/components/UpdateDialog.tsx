import { api } from '../api';
import { useUpdateStore } from '../stores/update';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Markdown } from './ui/markdown';
import { ScrollArea } from './ui/scroll-area';

export function UpdateDialog() {
  const open = useUpdateStore((s) => s.dialogOpen);
  const result = useUpdateStore((s) => s.result);
  const closeDialog = useUpdateStore((s) => s.closeDialog);
  if (!result) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>发现新版本 v{result.latest}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          当前版本 v{result.current} → 最新版本 v{result.latest}
        </p>
        {result.notes && (
          <ScrollArea className="max-h-64">
            <Markdown text={result.notes} className="pr-4" />
          </ScrollArea>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>
            稍后提醒
          </Button>
          <Button
            onClick={() => {
              if (result.url) void api().appOpenExternal({ url: result.url });
              closeDialog();
            }}
          >
            前往下载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
