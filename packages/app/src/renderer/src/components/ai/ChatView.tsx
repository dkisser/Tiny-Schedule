import { Button } from '../ui/button';

export function ChatView({ onBack }: { onBack: () => void }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <Button variant="ghost" onClick={onBack}>
        返回报告
      </Button>
    </div>
  );
}
