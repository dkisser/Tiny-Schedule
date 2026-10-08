import { type AppData, maskDataForRenderer } from '@tiny-schedule/shared';
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

export function sendSafe(win: BrowserWindow | null, channel: string, payload: unknown): void {
  // check-ipc: ok — callers pass Ipc.* constants only
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
