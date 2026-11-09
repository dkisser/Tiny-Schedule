/**
 * Copy for the plugin's two tabs.
 *
 * The harness ships a bilingual shell; the plugin follows it. Chinese is the
 * primary wording — the retired app's labels.
 */

export const NS = 'tinySchedule';

export const zh = {
  'view.tasks': '任务',
  'view.ideas': '想法',
  'panel.today': '今日',
  'panel.quadrant': '四象限',
  'panel.longTerm': '长期池',
  'panel.inbox': '收集箱',
  'panel.incubating': '验证中',
  'panel.resolved': '已了结',
  'label.empty': '这里还没有内容',
  'label.doneToday': '今天完成',
  'label.open': '待办',
  'label.overdue': '已逾期',
  'label.timeToday': '今日投入',
  'label.important': '重要',
  'label.urgent': '紧急',
  'label.noTimer': '没有运行中的计时',
  'label.timerRunning': '正在计时',
  'label.noDueDay': '未定日期',
  'label.pendingVerdict': '待结论',
  'action.complete': '完成',
  'action.reopen': '重新打开',
  'action.discard': '废弃',
  'action.close': '下结论',
  'label.unscheduled': '未安排',
  'label.farFuture': '远期',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'view.tasks': 'Tasks',
  'view.ideas': 'Ideas',
  'panel.today': 'Today',
  'panel.quadrant': 'Quadrant',
  'panel.longTerm': 'Long term',
  'panel.inbox': 'Inbox',
  'panel.incubating': 'Validating',
  'panel.resolved': 'Resolved',
  'label.empty': 'Nothing here yet',
  'label.doneToday': 'Done today',
  'label.open': 'Open',
  'label.overdue': 'Overdue',
  'label.timeToday': 'Time today',
  'label.important': 'Important',
  'label.urgent': 'Urgent',
  'label.noTimer': 'No running timer',
  'label.timerRunning': 'Timer running',
  'label.noDueDay': 'No due day',
  'label.pendingVerdict': 'Awaiting verdict',
  'action.complete': 'Complete',
  'action.reopen': 'Reopen',
  'action.discard': 'Discard',
  'action.close': 'Close',
  'label.unscheduled': 'Unscheduled',
  'label.farFuture': 'Far future',
};

export type TinyScheduleKey = keyof typeof zh;
