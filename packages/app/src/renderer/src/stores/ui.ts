import type { Task } from '@tiny-schedule/shared';
import { create } from 'zustand';
import { useDataStore } from './data';
import { useTimerStore } from './timer';

export type View =
  | { type: 'today' }
  | { type: 'project'; id: string }
  | { type: 'tag'; id: string }
  | { type: 'upcoming' }
  | { type: 'followUps' }
  | { type: 'ideas' }
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
  // 想法升级/闭环弹窗：值为目标想法 id，null 表示关闭。
  upgradeIdeaId: string | null;
  closingIdeaId: string | null;
  // 完成任务确认弹窗：仅当该任务正在被计时时出现。
  completing: PendingComplete | null;
  aiAutoRun: AiAutoRun | null;
  aiView: 'report' | 'chat';
  collapsedGroups: Record<SidebarGroup, boolean>;
  setView: (view: View) => void;
  selectTask: (taskId: string | null) => void;
  selectFollowUp: (followUpId: string | null) => void;
  selectIdea: (ideaId: string | null) => void;
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
}

export const useUiStore = create<UiState>((set, get) => ({
  view: { type: 'today' },
  selectedTaskId: null,
  selectedFollowUpId: null,
  selectedIdeaId: null,
  upgradeIdeaId: null,
  closingIdeaId: null,
  completing: null,
  aiAutoRun: null,
  aiView: 'report',
  collapsedGroups: { projects: false, tags: false, archived: true },
  setView: (view) =>
    set({ view, selectedTaskId: null, selectedFollowUpId: null, selectedIdeaId: null }),
  // Task / FollowUp / Idea 详情面板共用右侧 380px 区域，选中必须互斥。
  selectTask: (taskId) =>
    set({ selectedTaskId: taskId, selectedFollowUpId: null, selectedIdeaId: null }),
  selectFollowUp: (followUpId) =>
    set({ selectedFollowUpId: followUpId, selectedTaskId: null, selectedIdeaId: null }),
  selectIdea: (ideaId) =>
    set({ selectedIdeaId: ideaId, selectedTaskId: null, selectedFollowUpId: null }),
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
}));
