import type {
  AiAnalyzeReq,
  AiStreamEvent,
  ExportMarkdownReq,
  ExportMarkdownResult,
  ImportRunResult,
  ProviderInfo,
  SettingsUpdateReq,
  TaskPayload,
  TimerSyncReq,
} from './ipc';
import type { AppData } from './models';

export interface RendererApi {
  dataLoad(): Promise<AppData>;
  taskUpsert(task: TaskPayload): Promise<AppData>;
  taskDelete(id: string): Promise<AppData>;
  settingsUpdate(patch: SettingsUpdateReq): Promise<AppData>;
  finishDay(date: string): Promise<AppData>;
  timerSync(req: TimerSyncReq): Promise<void>;
  importRun(): Promise<ImportRunResult>;
  exportMarkdown(req: ExportMarkdownReq): Promise<ExportMarkdownResult>;
  selectAvatar(): Promise<string | null>; // data URL
  aiRegistry(): Promise<ProviderInfo[]>;
  aiTestProvider(providerId: string): Promise<{ ok: boolean; error?: string }>;
  aiAnalyze(req: AiAnalyzeReq): Promise<{ requestId: string }>;
  onAiEvent(cb: (ev: AiStreamEvent) => void): () => void;
}

export const RENDERER_API_KEY = 'tinyApi';

declare global {
  interface Window {
    tinyApi: RendererApi;
  }
}
