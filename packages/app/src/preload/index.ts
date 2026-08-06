import {
  type AiStreamEvent,
  IpcEventChannels,
  IpcInvokeContract,
  RENDERER_API_KEY,
  type RendererApi,
} from '@tiny-schedule/shared';
import { contextBridge, ipcRenderer } from 'electron';

const api: RendererApi = {
  dataLoad: () => ipcRenderer.invoke(IpcInvokeContract.dataLoad.ch),
  taskUpsert: (task) => ipcRenderer.invoke(IpcInvokeContract.taskUpsert.ch, task),
  taskDelete: (req) => ipcRenderer.invoke(IpcInvokeContract.taskDelete.ch, req),
  orderSet: (req) => ipcRenderer.invoke(IpcInvokeContract.orderSet.ch, req),
  projectCreate: (req) => ipcRenderer.invoke(IpcInvokeContract.projectCreate.ch, req),
  tagCreate: (req) => ipcRenderer.invoke(IpcInvokeContract.tagCreate.ch, req),
  settingsUpdate: (patch) => ipcRenderer.invoke(IpcInvokeContract.settingsUpdate.ch, patch),
  finishDay: (req) => ipcRenderer.invoke(IpcInvokeContract.finishDay.ch, req),
  timerSync: (req) => ipcRenderer.invoke(IpcInvokeContract.timerSync.ch, req),
  importRun: () => ipcRenderer.invoke(IpcInvokeContract.importRun.ch),
  exportMarkdown: (req) => ipcRenderer.invoke(IpcInvokeContract.exportMarkdown.ch, req),
  selectAvatar: () => ipcRenderer.invoke(IpcInvokeContract.selectAvatar.ch),
  aiRegistry: () => ipcRenderer.invoke(IpcInvokeContract.aiRegistry.ch),
  aiTestProvider: (req) => ipcRenderer.invoke(IpcInvokeContract.aiTestProvider.ch, req),
  aiAnalyze: (req) => ipcRenderer.invoke(IpcInvokeContract.aiAnalyze.ch, req),
  onAiEvent: (cb) => {
    const listener = (_e: unknown, ev: AiStreamEvent) => cb(ev);
    // check-ipc: ok — ch iterates IpcEventChannels
    for (const ch of IpcEventChannels) ipcRenderer.on(ch, listener as never);
    return () => {
      for (const ch of IpcEventChannels) ipcRenderer.removeListener(ch, listener as never);
    };
  },
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, api);
