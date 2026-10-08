import { z } from 'zod';
import type { Project } from './project';
import { blankTask, type Task } from './task';

// 想法生命周期：open 是唯一可分流的状态；done/discarded 可重新打开；
// converted/closed 是终态（closed 可修改结论）；incubating 的唯一出口是给结论。
export type IdeaStatus = 'open' | 'done' | 'discarded' | 'converted' | 'incubating' | 'closed';

// 验证中想法的演进日志条目（结构对齐 FollowUpEntry）。
export interface IdeaEntry {
  id: string;
  createdAt: number; // epoch ms
  text: string;
}

export interface IdeaVerdict {
  result: 'validated' | 'invalidated' | 'partial';
  text?: string;
  closedAt: number; // epoch ms
}

// 灵光一闪的想法：与 Task 完全分开，不参与计时/今日；出口：转任务/完成/废弃/升级为项目。
export interface Idea {
  id: string;
  title: string;
  notes: string; // markdown 备注
  createdAt: number; // epoch ms
  // 旧数据无 status 字段，由 IdeaSchema 在解析时派生：convertedAt 存在 → converted，否则 → open。
  status: IdeaStatus;
  convertedAt?: number; // epoch ms；设置即表示已转为任务
  convertedTaskId?: string; // 转化生成的任务 id
  projectId?: string; // incubating/closed 时关联的专属项目（一对一）
  validationGoal?: string; // 可选验证目标：怎么算验证成功
  timeline?: IdeaEntry[]; // 演进日志，按 createdAt 升序追加
  verdict?: IdeaVerdict; // closed 时的验证结论
  incubatedAt?: number; // epoch ms，升级为项目的时间（验证中区排序用）
  resolvedAt?: number; // epoch ms，进入 done/discarded/closed 的时间（已了结区排序用）
}

export const IdeaEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number(),
  text: z.string(),
});

export const IdeaVerdictSchema = z.object({
  result: z.enum(['validated', 'invalidated', 'partial']),
  text: z.string().optional(),
  closedAt: z.number(),
});

export const IdeaStatusSchema = z.enum([
  'open',
  'done',
  'discarded',
  'converted',
  'incubating',
  'closed',
]);

export const IdeaSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1),
    notes: z.string(),
    createdAt: z.number(),
    convertedAt: z.number().optional(),
    convertedTaskId: z.string().optional(),
    // 旧数据没有 status：transform 按 convertedAt 派生缺失值。刻意**不**加
    // .catch()——一个不认识的状态值说明 data.json 来自更新的构建或有损坏，
    // 此时静默降级成 undefined 会让 transform 把已闭环的想法复活成 open。
    // 让它抛，读侧（readValidated）会退回备份，这比悄悄丢失终态安全。
    status: IdeaStatusSchema.optional(),
    projectId: z.string().optional(),
    validationGoal: z.string().optional(),
    timeline: z.array(IdeaEntrySchema).optional(),
    verdict: IdeaVerdictSchema.optional(),
    incubatedAt: z.number().optional(),
    resolvedAt: z.number().optional(),
  })
  .transform(
    (idea): Idea => ({
      ...idea,
      status: idea.status ?? (idea.convertedAt !== undefined ? 'converted' : 'open'),
    }),
  );

export function newIdeaId(): string {
  return `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankIdea(title: string): Idea {
  return {
    id: newIdeaId(),
    title,
    notes: '',
    createdAt: Date.now(),
    status: 'open',
  };
}

// 想法转任务：任务进 Inbox，备注随标题一起带入；返回新任务与更新后的想法，
// 由调用方负责 upsertTask / upsertIdea。
export function ideaToTask(idea: Idea, inbox: Project): { task: Task; converted: Idea } {
  const task: Task = { ...blankTask(idea.title, inbox), notes: idea.notes };
  return {
    task,
    converted: { ...idea, status: 'converted', convertedAt: Date.now(), convertedTaskId: task.id },
  };
}

// 直接完成：记录即完成（今天的感受、天气…）。
export function completeIdea(idea: Idea): Idea {
  return { ...idea, status: 'done', resolvedAt: Date.now() };
}

// 废弃：觉得没必要做了；可重新打开。
export function discardIdea(idea: Idea): Idea {
  return { ...idea, status: 'discarded', resolvedAt: Date.now() };
}

// 重新打开：仅 done/discarded 允许，回到收集箱。
export function reopenIdea(idea: Idea): Idea {
  if (idea.status !== 'done' && idea.status !== 'discarded') return idea;
  return { ...idea, status: 'open', resolvedAt: undefined };
}

// 升级为项目：关联专属项目并进入验证中。项目由调用方先通过 project:create 建好。
export function upgradeIdeaToProject(idea: Idea, projectId: string, validationGoal?: string): Idea {
  return {
    ...idea,
    status: 'incubating',
    projectId,
    validationGoal: validationGoal || undefined,
    incubatedAt: Date.now(),
  };
}

export function appendIdeaEntry(idea: Idea, text: string): Idea {
  const entry: IdeaEntry = { id: newIdeaId(), createdAt: Date.now(), text };
  return { ...idea, timeline: [...(idea.timeline ?? []), entry] };
}

export function updateIdeaEntry(idea: Idea, entryId: string, text: string): Idea {
  return {
    ...idea,
    timeline: (idea.timeline ?? []).map((e) => (e.id === entryId ? { ...e, text } : e)),
  };
}

export function deleteIdeaEntry(idea: Idea, entryId: string): Idea {
  return { ...idea, timeline: (idea.timeline ?? []).filter((e) => e.id !== entryId) };
}

// 给出结论：incubating → closed；已 closed 时复用来修改结论（状态不变，只更新 verdict）。
export function closeIdeaWithVerdict(
  idea: Idea,
  result: IdeaVerdict['result'],
  text?: string,
): Idea {
  const verdict: IdeaVerdict = { result, text: text || undefined, closedAt: Date.now() };
  if (idea.status === 'closed') return { ...idea, verdict };
  return { ...idea, status: 'closed', verdict, resolvedAt: Date.now() };
}
