import { create } from 'zustand';

export type View =
  | { type: 'today' }
  | { type: 'project'; id: string }
  | { type: 'tag'; id: string }
  | { type: 'upcoming' }
  | { type: 'ai' }
  | { type: 'export' }
  | { type: 'settings' };

export interface AiAutoRun {
  scope: 'today' | 'week' | 'project';
  providerId: string;
}

export type SidebarGroup = 'projects' | 'tags';

interface UiState {
  view: View;
  selectedTaskId: string | null;
  aiAutoRun: AiAutoRun | null;
  aiView: 'report' | 'chat';
  collapsedGroups: Record<SidebarGroup, boolean>;
  setView: (view: View) => void;
  selectTask: (taskId: string | null) => void;
  setAiView: (v: 'report' | 'chat') => void;
  toggleSidebarGroup: (group: SidebarGroup) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: { type: 'today' },
  selectedTaskId: null,
  aiAutoRun: null,
  aiView: 'report',
  collapsedGroups: { projects: false, tags: false },
  setView: (view) => set({ view, selectedTaskId: null }),
  selectTask: (taskId) => set({ selectedTaskId: taskId }),
  setAiView: (aiView) => set({ aiView }),
  toggleSidebarGroup: (group) =>
    set((s) => ({
      collapsedGroups: { ...s.collapsedGroups, [group]: !s.collapsedGroups[group] },
    })),
}));
