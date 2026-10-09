import { z } from 'zod';
import { localDate } from './task';

export interface FollowUpEntry {
  id: string;
  at: number; // epoch ms
  text: string;
}

// 长期等待外部反馈的事项（如 ICP 审核）：与 Task 完全分开，不参与计时/今日。
export interface FollowUp {
  id: string;
  title: string;
  notes: string; // markdown，在等谁/背景说明
  entries: FollowUpEntry[]; // 跟进记录时间线，按 at 升序追加
  createdAt: number; // epoch ms，开始等待的时间
  nextFollowUpDay?: string; // YYYY-MM-DD，下次跟进日期
  isResolved: boolean;
  resolvedAt?: number; // epoch ms
}

export const FollowUpEntrySchema = z.object({
  id: z.string().min(1),
  at: z.number(),
  text: z.string(),
});

export const FollowUpSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  notes: z.string(),
  // default([]) lets entries be added to persisted follow-ups later without a migration.
  entries: z.array(FollowUpEntrySchema).default([]),
  createdAt: z.number(),
  nextFollowUpDay: z.string().optional(),
  isResolved: z.boolean(),
  resolvedAt: z.number().optional(),
});

export function newFollowUpId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankFollowUp(title: string): FollowUp {
  return {
    id: newFollowUpId(),
    title,
    notes: '',
    entries: [],
    createdAt: Date.now(),
    isResolved: false,
  };
}

export function isFollowUpDue(f: FollowUp, now = Date.now()): boolean {
  const today = localDate(now);
  return !f.isResolved && !!f.nextFollowUpDay && f.nextFollowUpDay <= today;
}

// 办结：记录了结时刻；此后该跟进不再出现在到期提醒里。
export function resolveFollowUp(f: FollowUp, now = Date.now()): FollowUp {
  return { ...f, isResolved: true, resolvedAt: now };
}

// 恢复跟进：清空了结时刻，回到等待中（isFollowUpDue 随之重新生效）。
export function reopenFollowUp(f: FollowUp): FollowUp {
  return { ...f, isResolved: false, resolvedAt: undefined };
}
