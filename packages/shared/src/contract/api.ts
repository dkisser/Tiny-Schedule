import type {
  AiStreamEvent,
  ChatEvent,
  CheckUpdateResult,
  IpcInvokeFn,
  IpcInvokeKey,
  StoreWritablePayload,
  TimerChangedPayload,
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
  /**
   * The main process changed the timer, or failed to. A discriminated union
   * rather than `ActiveTimer | null`: a refusal must not read as a drop, or the
   * renderer clears a clock main is still counting (see TimerChangedPayload).
   */
  onTimerChanged(cb: (payload: TimerChangedPayload) => void): () => void;
  /**
   * The store's read-only mode (ADR-0004). Fires immediately with the current
   * state on subscribe, so a renderer that mounts late does not start out
   * believing it can save.
   */
  onStoreWritable(cb: (payload: StoreWritablePayload) => void): () => void;
  /** Pull the current mode on mount; the push channel only covers later changes. */
  storeWritable(): Promise<StoreWritablePayload>;
};

export const RENDERER_API_KEY = 'tinyApi';

declare global {
  interface Window {
    tinyApi: RendererApi;
  }
}
