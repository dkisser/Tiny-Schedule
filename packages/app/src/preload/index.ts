import { RENDERER_API_KEY, type RendererApi } from '@tiny-schedule/shared';
import { contextBridge } from 'electron';

const api: RendererApi = {
  dataLoad: () => Promise.reject(new Error('not wired')),
  taskUpsert: () => Promise.reject(new Error('not wired')),
  taskDelete: () => Promise.reject(new Error('not wired')),
  settingsUpdate: () => Promise.reject(new Error('not wired')),
  finishDay: () => Promise.reject(new Error('not wired')),
  timerSync: () => Promise.reject(new Error('not wired')),
  importRun: () => Promise.reject(new Error('not wired')),
  exportMarkdown: () => Promise.reject(new Error('not wired')),
  selectAvatar: () => Promise.reject(new Error('not wired')),
  aiRegistry: () => Promise.reject(new Error('not wired')),
  aiTestProvider: () => Promise.reject(new Error('not wired')),
  aiAnalyze: () => Promise.reject(new Error('not wired')),
  onAiEvent: () => () => {},
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, api);
