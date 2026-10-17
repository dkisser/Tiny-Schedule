import type { Task } from '@tiny-schedule/shared';
import { create } from 'zustand';
import { useDataStore } from './data';
import { useTimerStore } from './timer';

export type View =
  | { type: 'home' }
  | { type: 'today' }
  | { type: 'project'; id: string }
  | { type: 'tag'; id: string }
  | { type: 'upcoming' }
  | { type: 'followUps' }
  | { type: 'ideas' }
  | { type: 'scheduledTasks' }
  | { type: 'ai' }
  | { type: 'export' }
  | { type: 'settings' };

export interface AiAutoRun {
  scope: 'today' | 'week' | 'project';
  providerId: string;
}

export type SidebarGroup = 'projects' | 'tags' | 'archived';

export interface PendingComplete {
  taskId: string;
  /** True only when opening this dialog is what stopped the clock. */
  pausedByDialog: boolean;
}

interface UiState {
  view: View;
  selectedTaskId: string | null;
  selectedFollowUpId: string | null;
  selectedIdeaId: string | null;
  // 定时任务详情面板。与其它三个选中项共用右侧区域，所以必须互斥。
  selectedScheduledTaskId: string | null;
  // 想法升级/闭环弹窗：值为目标想法 id，null 表示关闭。
  upgradeIdeaId: string | null;
  closingIdeaId: string | null;
  // 完成任务确认弹窗：仅当该任务正在被计时时出现。
  completing: PendingComplete | null;
  aiAutoRun: AiAutoRun | null;
  aiView: 'report' | 'chat';
  collapsedGroups: Record<SidebarGroup, boolean>;
  /**
   * 运行历史变更的版本号。
   *
   * 运行记录进 AppData 但不随数据集变化推给界面，所以没有任何变化可以驱动刷新。详情
   * 面板与列表页都靠这个计数器重新拉取历史——它只增不减，界面读它的当前值就够。
   *
   * bump 的时机是运行开始与结束各一次（`bootstrap.ts` 订阅 `scheduledTasks/runEvents`
   * 后调用），所以界面在按下去的那一刻就能看见那条 running，而不只是结束后才看见一条
   * 终态。手动与定时触发走的是同一个信号——定时触发才是没人盯着的那种运行。
   */
  runsRevision: number;
  setView: (view: View) => void;
  selectTask: (taskId: string | null) => void;
  selectFollowUp: (followUpId: string | null) => void;
  selectIdea: (ideaId: string | null) => void;
  selectScheduledTask: (scheduledTaskId: string | null) => void;
  setUpgradeIdea: (ideaId: string | null) => void;
  setClosingIdea: (ideaId: string | null) => void;
  /**
   * The one entry point for completing or un-completing a task, whatever
   * surface it was triggered from. Freezes the clock on the way into the
   * confirmation and puts it back on the way out, so the invariant holds for
   * every caller instead of only the one that remembers to.
   */
  requestComplete: (task: Task) => void;
  /** Back out of a confirmation, restoring a clock this dialog paused. */
  cancelComplete: () => void;
  setAiView: (v: 'report' | 'chat') => void;
  toggleSidebarGroup: (group: SidebarGroup) => void;
  bumpRunsRevision: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  view: { type: 'home' },
  selectedTaskId: null,
  selectedFollowUpId: null,
  selectedIdeaId: null,
  selectedScheduledTaskId: null,
  upgradeIdeaId: null,
  closingIdeaId: null,
  completing: null,
  aiAutoRun: null,
  aiView: 'report',
  collapsedGroups: { projects: false, tags: false, archived: true },
  runsRevision: 0,
  setView: (view) =>
    set({
      view,
      selectedTaskId: null,
      selectedFollowUpId: null,
      selectedIdeaId: null,
      selectedScheduledTaskId: null,
    }),
  // Task / FollowUp / Idea / ScheduledTask 详情面板共用右侧 380px 区域，选中必须互斥。
  selectTask: (taskId) =>
    set({
      selectedTaskId: taskId,
      selectedFollowUpId: null,
      selectedIdeaId: null,
      selectedScheduledTaskId: null,
    }),
  selectFollowUp: (followUpId) =>
    set({
      selectedFollowUpId: followUpId,
      selectedTaskId: null,
      selectedIdeaId: null,
      selectedScheduledTaskId: null,
    }),
  selectIdea: (ideaId) =>
    set({
      selectedIdeaId: ideaId,
      selectedTaskId: null,
      selectedFollowUpId: null,
      selectedScheduledTaskId: null,
    }),
  selectScheduledTask: (scheduledTaskId) =>
    set({
      selectedScheduledTaskId: scheduledTaskId,
      selectedTaskId: null,
      selectedFollowUpId: null,
      selectedIdeaId: null,
    }),
  setUpgradeIdea: (upgradeIdeaId) => set({ upgradeIdeaId }),
  setClosingIdea: (closingIdeaId) => set({ closingIdeaId }),
  requestComplete: (task) => {
    // Un-completing leaves the task clean: its time is already settled and is
    // deliberately not restored.
    if (task.isDone) {
      void useDataStore.getState().upsertTask({ ...task, isDone: false, doneAt: undefined });
      return;
    }
    const timing = useTimerStore.getState().timer;
    // A timer on a different task is irrelevant here: completing this one must
    // not settle someone else's time, and needs no confirmation.
    if (timing?.taskId !== task.id) {
      // doneAt is stamped by the main process, which knows the stored value.
      void useDataStore.getState().upsertTask({ ...task, isDone: true });
      return;
    }
    // Freeze the clock at the moment the user chose to complete, so deliberation
    // is never billed as work. Only a clock this dialog stopped gets resumed.
    const pausedByDialog = !timing.isPaused;
    if (pausedByDialog) useTimerStore.getState().pause();
    set({ completing: { taskId: task.id, pausedByDialog } });
  },
  cancelComplete: () => {
    const pending = get().completing;
    set({ completing: null });
    if (pending?.pausedByDialog) useTimerStore.getState().resume();
  },
  setAiView: (aiView) => set({ aiView }),
  toggleSidebarGroup: (group) =>
    set((s) => ({
      collapsedGroups: { ...s.collapsedGroups, [group]: !s.collapsedGroups[group] },
    })),
  bumpRunsRevision: () => set((s) => ({ runsRevision: s.runsRevision + 1 })),
}));
