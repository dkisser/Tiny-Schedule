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

interface UiState {
  view: View;
  selectedTaskId: string | null;
  aiAutoRun: AiAutoRun | null;
  setView: (view: View) => void;
  selectTask: (taskId: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: { type: 'today' },
  selectedTaskId: null,
  aiAutoRun: null,
  setView: (view) => set({ view, selectedTaskId: null }),
  selectTask: (taskId) => set({ selectedTaskId: taskId }),
}));
