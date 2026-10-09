import type { ActiveTimer } from '../domain/task';
import type {
  AiStreamEvent,
  ChatEvent,
  CheckUpdateResult,
  IpcInvokeFn,
  IpcInvokeKey,
  StoreWritablePayload,
} from './ipc';

// Derived from IpcInvokeContract so the renderer-facing signatures can never
// drift from the request schemas or response types declared in the contract.
export type RendererApi = {
  [K in IpcInvokeKey]: IpcInvokeFn<K>;
} & {
  onAiEvent(cb: (ev: AiStreamEvent) => void): () => void;
  onChatEvent(cb: (ev: ChatEvent) => void): () => void;
  onNewTask(cb: () => void): () => void;
  onUpdateAvailable(cb: (result: CheckUpdateResult) => void): () => void;
  onTimerChanged(cb: (timer: ActiveTimer | null) => void): () => void;
  /**
   * The store's read-only mode (ADR-0004). Fires immediately with the current
   * state on subscribe, so a renderer that mounts late does not start out
   * believing it can save.
   */
  onStoreWritable(cb: (payload: StoreWritablePayload) => void): () => void;
};

export const RENDERER_API_KEY = 'tinyApi';

declare global {
  interface Window {
    tinyApi: RendererApi;
  }
}
