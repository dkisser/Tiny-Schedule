import { type AppData, maskDataForRenderer, type WriteOutcome } from '@tiny-schedule/shared';
import type { BrowserWindow } from 'electron';
import type { Logger } from 'pino';
import type { FollowUpService } from '../services/followUpService';
import type { IdeaService } from '../services/ideaService';
import type { ProjectService } from '../services/projectService';
import type { TaskService } from '../services/taskService';

/**
 * handler 层与 service 层的接缝。handler 只做请求处理与转调：不写 store、
 * 不调 domain 纯函数、不判断领域规则（ADR-0003）。例外是系统级通道
 * （窗口/通知/更新检查/文件选择）——它们不属于任何聚合，直接用注入的机制。
 *
 * 写 store 必须经过 service，没有例外。HandlerDeps 里只列了四个聚合；完整
 * 清单在 registerIpcHandlers 的组装处（那里构造全部 service），还包括 settings
 * （自己的写规则：明文入、密文落盘）、导入合并、AI 历史与 chat 会话。新增通道前
 * 先看那份清单，不要就地写 store：encryptKey 那条规则是这么被守住的，漏一次就是
 * 把明文 key 写进 data.json。
 */
export interface HandlerDeps {
  logger: Logger;
  getWindow: () => BrowserWindow | null;
  getVersion: () => string;
  tasks: TaskService;
  ideas: IdeaService;
  followUps: FollowUpService;
  projects: ProjectService;
}

/**
 * AppData sent to the renderer never contains real keys.
 *
 * `maskedResult` is the same guarantee for the command envelopes, and it is
 * here rather than inlined per handler: forgetting the wrapper on one branch of
 * one command ships every provider's ciphertext across the contextBridge, and
 * the renderer adopts these datasets wholesale. One place to remember, so
 * there is one place to review.
 */
export function masked(data: AppData): AppData {
  return maskDataForRenderer(data);
}

export function maskedResult<T extends { ok: true; data: AppData } | { ok: false; error: string }>(
  result: T,
): T {
  return result.ok ? ({ ...result, data: masked(result.data) } as T) : result;
}

/**
 * The single place a refused write becomes a value a caller can branch on
 * (ADR-0004).
 *
 * Only for control-flow channels — the ones whose result decides whether a
 * dialog closes or an id gets navigated to. `{ ok: false, error: 'WRITE_REFUSED' }`
 * is deliberately the same shape as a domain rejection: the caller's response
 * is identical (nothing happened), so its existing `if (!result.ok)` needs no
 * change and there is no second flag it might forget.
 */
export function written(data: AppData): { ok: true; data: AppData } {
  return { ok: true, data: masked(data) };
}

/** The refusal a control-flow channel returns when the store dropped the write. */
export const REFUSED = { ok: false, error: 'WRITE_REFUSED' } as const;

/**
 * Map a service command result onto the wire shape, turning a refused write
 * into the same envelope as a domain rejection.
 *
 * One function so every command channel maps it identically. Doing this
 * per-channel is how a refused write ended up reported as a success: the
 * shape is uniform, so the mapping has to be too.
 */
export function asCommand<
  R extends { ok: true; data: AppData; persisted: boolean },
  E extends string,
>(
  result: R | { ok: false; error: E },
): Omit<R, 'persisted'> | { ok: false; error: E | 'WRITE_REFUSED' } {
  if (!result.ok) return result;
  // Drop only `persisted`; the rest (taskId, projectId, settledMs) is what the
  // caller needs to act on, and the renderer was told to expect it by contract.
  if (!result.persisted) return REFUSED;
  const { persisted: _dropped, ...rest } = result;
  return maskedResult(rest as { ok: true; data: AppData }) as Omit<R, 'persisted'>;
}

export function sendSafe(win: BrowserWindow | null, channel: string, payload: unknown): void {
  // check-ipc: ok — callers pass Ipc.* constants only
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
