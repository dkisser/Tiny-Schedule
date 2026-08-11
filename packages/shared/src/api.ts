import type { AiStreamEvent, ChatEvent, CheckUpdateResult, IpcInvokeFn, IpcInvokeKey } from './ipc';

// Derived from IpcInvokeContract so the renderer-facing signatures can never
// drift from the request schemas or response types declared in the contract.
export type RendererApi = {
  [K in IpcInvokeKey]: IpcInvokeFn<K>;
} & {
  onAiEvent(cb: (ev: AiStreamEvent) => void): () => void;
  onChatEvent(cb: (ev: ChatEvent) => void): () => void;
  onNewTask(cb: () => void): () => void;
  onUpdateAvailable(cb: (result: CheckUpdateResult) => void): () => void;
};

export const RENDERER_API_KEY = 'tinyApi';

declare global {
  interface Window {
    tinyApi: RendererApi;
  }
}
