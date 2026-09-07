import type { AppData, Idea, Project, Task } from '@tiny-schedule/shared';
import { blankTask } from './tasks';

export function newIdeaId(): string {
  return `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankIdea(title: string): Idea {
  return {
    id: newIdeaId(),
    title,
    notes: '',
    createdAt: Date.now(),
  };
}

// 待转化的想法：新建的在最前。
export function openIdeas(data: AppData): Idea[] {
  return Object.values(data.ideas)
    .filter((i) => i.convertedAt === undefined)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// 已转化的想法：最近转化的在最前。
export function convertedIdeas(data: AppData): Idea[] {
  return Object.values(data.ideas)
    .filter((i) => i.convertedAt !== undefined)
    .sort((a, b) => (b.convertedAt ?? 0) - (a.convertedAt ?? 0));
}

// 想法转任务：任务进 Inbox，备注随标题一起带入；返回新任务与更新后的想法，
// 由调用方负责 upsertTask / upsertIdea。
export function ideaToTask(idea: Idea, inbox: Project): { task: Task; converted: Idea } {
  const task: Task = { ...blankTask(idea.title, inbox), notes: idea.notes };
  return {
    task,
    converted: { ...idea, convertedAt: Date.now(), convertedTaskId: task.id },
  };
}
