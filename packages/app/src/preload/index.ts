import {
  type AiStreamEvent,
  type ChatEvent,
  Ipc,
  IpcChatEventChannels,
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
  projectUpdate: (req) => ipcRenderer.invoke(IpcInvokeContract.projectUpdate.ch, req),
  projectDelete: (req) => ipcRenderer.invoke(IpcInvokeContract.projectDelete.ch, req),
  tagCreate: (req) => ipcRenderer.invoke(IpcInvokeContract.tagCreate.ch, req),
  tagUpdate: (req) => ipcRenderer.invoke(IpcInvokeContract.tagUpdate.ch, req),
  tagDelete: (req) => ipcRenderer.invoke(IpcInvokeContract.tagDelete.ch, req),
  settingsUpdate: (patch) => ipcRenderer.invoke(IpcInvokeContract.settingsUpdate.ch, patch),
  finishDay: (req) => ipcRenderer.invoke(IpcInvokeContract.finishDay.ch, req),
  timerSync: (req) => ipcRenderer.invoke(IpcInvokeContract.timerSync.ch, req),
  importRun: () => ipcRenderer.invoke(IpcInvokeContract.importRun.ch),
  exportMarkdown: (req) => ipcRenderer.invoke(IpcInvokeContract.exportMarkdown.ch, req),
  selectAvatar: () => ipcRenderer.invoke(IpcInvokeContract.selectAvatar.ch),
  aiRegistry: () => ipcRenderer.invoke(IpcInvokeContract.aiRegistry.ch),
  aiTestProvider: (req) => ipcRenderer.invoke(IpcInvokeContract.aiTestProvider.ch, req),
  aiProviderKeyReveal: (req) => ipcRenderer.invoke(IpcInvokeContract.aiProviderKeyReveal.ch, req),
  aiAnalyze: (req) => ipcRenderer.invoke(IpcInvokeContract.aiAnalyze.ch, req),
  chatSessionsList: () => ipcRenderer.invoke(IpcInvokeContract.chatSessionsList.ch),
  chatSessionCreate: (req) => ipcRenderer.invoke(IpcInvokeContract.chatSessionCreate.ch, req),
  chatSessionDelete: (req) => ipcRenderer.invoke(IpcInvokeContract.chatSessionDelete.ch, req),
  chatSend: (req) => ipcRenderer.invoke(IpcInvokeContract.chatSend.ch, req),
  chatContinue: (req) => ipcRenderer.invoke(IpcInvokeContract.chatContinue.ch, req),
  chatStop: (req) => ipcRenderer.invoke(IpcInvokeContract.chatStop.ch, req),
  appCheckUpdate: () => ipcRenderer.invoke(IpcInvokeContract.appCheckUpdate.ch),
  calendarAddTask: (req) => ipcRenderer.invoke(IpcInvokeContract.calendarAddTask.ch, req),
  appOpenExternal: (req) => ipcRenderer.invoke(IpcInvokeContract.appOpenExternal.ch, req),
  notifyPhaseComplete: (req) => ipcRenderer.invoke(IpcInvokeContract.notifyPhaseComplete.ch, req),
  setAlwaysOnTopWindow: (req) => ipcRenderer.invoke(IpcInvokeContract.setAlwaysOnTopWindow.ch, req),
  onChatEvent: (cb) => {
    // check-ipc: ok — ch iterates IpcChatEventChannels
    const subs = IpcChatEventChannels.map((ch) => {
      const listener = (_e: unknown, payload: unknown) => cb({ channel: ch, payload } as ChatEvent);
      // check-ipc: ok — ch is the IpcChatEventChannels iterator
      ipcRenderer.on(ch, listener as never);
      return { ch, listener };
    });
    return () => {
      for (const { ch, listener } of subs) ipcRenderer.removeListener(ch, listener as never);
    };
  },
  onAiEvent: (cb) => {
    const listener = (_e: unknown, ev: AiStreamEvent) => cb(ev);
    // check-ipc: ok — ch iterates IpcEventChannels
    for (const ch of IpcEventChannels) ipcRenderer.on(ch, listener as never);
    return () => {
      for (const ch of IpcEventChannels) ipcRenderer.removeListener(ch, listener as never);
    };
  },
  onNewTask: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(Ipc.uiNewTask, listener);
    return () => ipcRenderer.removeListener(Ipc.uiNewTask, listener);
  },
  onUpdateAvailable: (cb) => {
    const listener = (_e: unknown, result: Parameters<typeof cb>[0]) => cb(result);
    ipcRenderer.on(Ipc.uiUpdateAvailable, listener);
    return () => ipcRenderer.removeListener(Ipc.uiUpdateAvailable, listener);
  },
  onTimerChanged: (cb) => {
    const listener = (_e: unknown, timer: Parameters<typeof cb>[0]) => cb(timer);
    // check-ipc: ok — Ipc.timerChanged constant
    ipcRenderer.on(Ipc.timerChanged, listener as never);
    return () => ipcRenderer.removeListener(Ipc.timerChanged, listener as never);
  },
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, api);
