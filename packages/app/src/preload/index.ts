import { type AiStreamEvent, Ipc, RENDERER_API_KEY, type RendererApi } from '@tiny-schedule/shared';
import { contextBridge, ipcRenderer } from 'electron';

const api: RendererApi = {
  dataLoad: () => ipcRenderer.invoke(Ipc.dataLoad),
  taskUpsert: (task) => ipcRenderer.invoke(Ipc.taskUpsert, task),
  taskDelete: (id) => ipcRenderer.invoke(Ipc.taskDelete, { id }),
  orderSet: (req) => ipcRenderer.invoke(Ipc.orderSet, req),
  projectCreate: (req) => ipcRenderer.invoke(Ipc.projectCreate, req),
  tagCreate: (req) => ipcRenderer.invoke(Ipc.tagCreate, req),
  settingsUpdate: (patch) => ipcRenderer.invoke(Ipc.settingsUpdate, patch),
  finishDay: (date) => ipcRenderer.invoke(Ipc.finishDay, { date }),
  timerSync: (req) => ipcRenderer.invoke(Ipc.timerSync, req),
  importRun: () => ipcRenderer.invoke(Ipc.importRun),
  exportMarkdown: (req) => ipcRenderer.invoke(Ipc.exportMarkdown, req),
  selectAvatar: () => ipcRenderer.invoke(Ipc.selectAvatar),
  aiRegistry: () => ipcRenderer.invoke(Ipc.aiRegistry),
  aiTestProvider: (providerId) => ipcRenderer.invoke(Ipc.aiTestProvider, { providerId }),
  aiAnalyze: (req) => ipcRenderer.invoke(Ipc.aiAnalyze, req),
  onAiEvent: (cb) => {
    const listener = (_e: unknown, ev: AiStreamEvent) => cb(ev);
    ipcRenderer.on(Ipc.aiChunk, listener as never);
    ipcRenderer.on(Ipc.aiDone, listener as never);
    ipcRenderer.on(Ipc.aiError, listener as never);
    return () => {
      ipcRenderer.removeListener(Ipc.aiChunk, listener as never);
      ipcRenderer.removeListener(Ipc.aiDone, listener as never);
      ipcRenderer.removeListener(Ipc.aiError, listener as never);
    };
  },
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, api);
