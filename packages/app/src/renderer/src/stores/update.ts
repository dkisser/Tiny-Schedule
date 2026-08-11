import type { CheckUpdateResult } from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';

export type UpdateStatus = 'idle' | 'checking' | 'upToDate' | 'available' | 'error';

interface UpdateState {
  status: UpdateStatus;
  result: CheckUpdateResult | null;
  dialogOpen: boolean;
  check: () => Promise<void>;
  notify: (result: CheckUpdateResult) => void;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: 'idle',
  result: null,
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
  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));
