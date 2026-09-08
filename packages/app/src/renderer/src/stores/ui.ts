import { create } from 'zustand';

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

interface UiState {
  view: View;
  selectedTaskId: string | null;
  selectedFollowUpId: string | null;
  selectedIdeaId: string | null;
  // 想法升级/闭环弹窗：值为目标想法 id，null 表示关闭。
  upgradeIdeaId: string | null;
  closingIdeaId: string | null;
  aiAutoRun: AiAutoRun | null;
  aiView: 'report' | 'chat';
  collapsedGroups: Record<SidebarGroup, boolean>;
  setView: (view: View) => void;
  selectTask: (taskId: string | null) => void;
  selectFollowUp: (followUpId: string | null) => void;
  selectIdea: (ideaId: string | null) => void;
  setUpgradeIdea: (ideaId: string | null) => void;
  setClosingIdea: (ideaId: string | null) => void;
  setAiView: (v: 'report' | 'chat') => void;
  toggleSidebarGroup: (group: SidebarGroup) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: { type: 'today' },
  selectedTaskId: null,
  selectedFollowUpId: null,
  selectedIdeaId: null,
  upgradeIdeaId: null,
  closingIdeaId: null,
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
  setAiView: (aiView) => set({ aiView }),
  toggleSidebarGroup: (group) =>
    set((s) => ({
      collapsedGroups: { ...s.collapsedGroups, [group]: !s.collapsedGroups[group] },
    })),
}));
