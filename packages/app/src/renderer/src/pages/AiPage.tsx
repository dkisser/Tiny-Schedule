import { MessageSquare, ScrollText } from 'lucide-react';
import { ChatView } from '../components/ai/ChatView';
import { ReportView } from '../components/ai/ReportView';
import { Button } from '../components/ui/button';
import { useUiStore } from '../stores/ui';

export function AiPage() {
  const aiView = useUiStore((s) => s.aiView);
  const setAiView = useUiStore((s) => s.setAiView);
  if (aiView === 'report') return <ReportView />;
  return <ChatView onBack={() => setAiView('report')} />;
}
