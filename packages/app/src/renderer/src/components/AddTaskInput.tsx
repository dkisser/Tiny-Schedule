import { SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { useState } from 'react';
import { blankTask } from '../lib/tasks';
import { useDataStore } from '../stores/data';
import { Input } from './ui/input';

export function AddTaskInput({
  projectId,
  addToToday = false,
}: {
  projectId: string;
  addToToday?: boolean;
}) {
  const [title, setTitle] = useState('');
  const upsertTask = useDataStore((s) => s.upsertTask);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const tags = addToToday ? [SYSTEM_TAG_IDS.today] : [];
    await upsertTask(blankTask(trimmed, projectId, tags));
    setTitle('');
  };

  return (
    <Input
      value={title}
      placeholder="＋ 添加任务，回车确认"
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && void submit()}
    />
  );
}
