import { invoke } from '@tauri-apps/api/core';
import { IpcInvokeContract, type RendererApi } from '@tiny-schedule/shared';

/**
 * The window-control slice: system glue that belongs to the native window
 * rather than the DOM, which is why it is implemented here instead of staying
 * a throwing stub.
 *
 * It exists in wave 2 rather than a later one because
 * `PomodoroPhaseDialog` calls `setAlwaysOnTopWindow` from a `useEffect` on
 * mount — an unimplemented invoke throws synchronously there and unmounts the
 * entire app, so leaving it stubbed meant a blank window.
 *
 * The request is parsed against the contract, as `api/data.ts` and
 * `api/timer.ts` do per call: with the ipcMain loop gone, the zod guard every
 * handler used to inherit lives at the call site. Rust's serde would reject a
 * wrong-typed field too, but as an opaque invoke error rather than the
 * contract's own message.
 */
export function createWindowApi(): Pick<RendererApi, 'setAlwaysOnTopWindow'> {
  const { req } = IpcInvokeContract.setAlwaysOnTopWindow;

  return {
    async setAlwaysOnTopWindow(raw): Promise<void> {
      const { enabled } = req.parse(raw);
      await invoke('set_always_on_top', { enabled });
    },
  };
}
