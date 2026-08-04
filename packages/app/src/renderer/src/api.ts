import type { RendererApi } from '@tiny-schedule/shared';

export function api(): RendererApi {
  if (!window.tinyApi) throw new Error('tinyApi not exposed — preload missing');
  return window.tinyApi;
}
