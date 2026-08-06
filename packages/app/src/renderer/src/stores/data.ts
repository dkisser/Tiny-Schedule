import type { AppData, AppSettings, Task } from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';

// Renderer-side provider draft carries plain-text apiKey for editing
export interface ProviderDraft {
  id: string;
  registryId: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  isDefault: boolean;
}

interface DataState {
  data: AppData | null;
  loading: boolean;
  load: () => Promise<void>;
  upsertTask: (task: Task) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  setTaskOrder: (viewKey: string, ids: string[]) => void;
  createProject: (title: string) => Promise<void>;
  createTag: (title: string) => Promise<void>;
  updateSettings: (
    patch: Omit<Partial<AppSettings>, 'aiProviders'> & { aiProviders?: ProviderDraft[] },
  ) => Promise<void>;
}

export const useDataStore = create<DataState>((set) => ({
  data: null,
  loading: false,
  load: async () => {
    set({ loading: true });
    const data = await api().dataLoad();
    set({ data, loading: false });
  },
  upsertTask: async (task) => {
    const data = await api().taskUpsert(task);
    set({ data });
  },
  deleteTask: async (id) => {
    const data = await api().taskDelete(id);
    set({ data });
  },
  setTaskOrder: (viewKey, ids) => {
    // Optimistic: apply locally first so dragging stays fluid, then persist.
    set((s) => {
      if (!s.data) return s;
      const taskOrder = (s.data.misc.taskOrder ?? {}) as Record<string, string[]>;
      return {
        data: { ...s.data, misc: { ...s.data.misc, taskOrder: { ...taskOrder, [viewKey]: ids } } },
      };
    });
    void api().orderSet({ viewKey, ids });
  },
  createProject: async (title) => {
    const data = await api().projectCreate({ title });
    set({ data });
  },
  createTag: async (title) => {
    const data = await api().tagCreate({ title });
    set({ data });
  },
  updateSettings: async (patch) => {
    const data = await api().settingsUpdate(patch);
    set({ data });
  },
}));
