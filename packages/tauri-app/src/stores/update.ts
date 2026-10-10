import type { CheckUpdateResult } from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';

export type UpdateStatus = 'idle' | 'checking' | 'upToDate' | 'available' | 'error';

interface UpdateState {
  status: UpdateStatus;
  result: CheckUpdateResult | null;
  /**
   * The bundle's own version, read once at bootstrap. Separate from `result`
   * so the settings page can show it before any update check has run —
   * `result` only exists after a manual check or an available-update push.
   */
  currentVersion: string | null;
  dialogOpen: boolean;
  check: () => Promise<void>;
  notify: (result: CheckUpdateResult) => void;
  setCurrentVersion: (version: string) => void;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: 'idle',
  result: null,
  currentVersion: null,
  dialogOpen: false,
  check: async () => {
    set({ status: 'checking' });
    const result = await api().appCheckUpdate();
    set({
      status: result.hasUpdate ? 'available' : result.error ? 'error' : 'upToDate',
      result,
    });
  },
  // Startup push from main; only an available update is ever delivered.
  notify: (result) => {
    if (!result.hasUpdate) return;
    set({ status: 'available', result, dialogOpen: true });
  },
  setCurrentVersion: (version) => set({ currentVersion: version }),
  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));
