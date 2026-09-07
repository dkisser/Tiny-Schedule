import { type AppData, type FollowUp, localDate } from '@tiny-schedule/shared';

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

// 跟进中列表：到期/逾期的在前按日期升序，其余（未来日期或无日期）在后按开始等待时间升序。
export function openFollowUps(data: AppData, now = Date.now()): FollowUp[] {
  return Object.values(data.followUps)
    .filter((f) => !f.isResolved)
    .sort((a, b) => {
      const aDue = isFollowUpDue(a, now);
      const bDue = isFollowUpDue(b, now);
      if (aDue && bDue) return (a.nextFollowUpDay ?? '').localeCompare(b.nextFollowUpDay ?? '');
      if (aDue) return -1;
      if (bDue) return 1;
      return a.createdAt - b.createdAt;
    });
}

// 今日提醒区与侧栏角标共用：未办结且已到跟进日期。
export function dueFollowUps(data: AppData, now = Date.now()): FollowUp[] {
  return Object.values(data.followUps)
    .filter((f) => isFollowUpDue(f, now))
    .sort((a, b) => (a.nextFollowUpDay ?? '').localeCompare(b.nextFollowUpDay ?? ''));
}

export function resolvedFollowUps(data: AppData): FollowUp[] {
  return Object.values(data.followUps)
    .filter((f) => f.isResolved)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
}

export function waitingDays(f: FollowUp, now = Date.now()): number {
  return Math.max(0, Math.floor((now - f.createdAt) / 86_400_000));
}
