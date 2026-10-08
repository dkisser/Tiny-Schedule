import { type AppData, maskDataForRenderer } from '@tiny-schedule/shared';
import type { BrowserWindow } from 'electron';
import type { Logger } from 'pino';
import type { ChatEventSink } from '../services/chatService';
import type { FollowUpService } from '../services/followUpService';
import type { IdeaService } from '../services/ideaService';
import type { ProjectService } from '../services/projectService';
import type { TaskService } from '../services/taskService';

/**
 * handler 层与 service 层的接缝。handler 只做请求处理与转调：不写 store、
 * 不调 domain 纯函数、不判断领域规则（ADR-0003）。例外是系统级通道
 * （窗口/通知/更新检查/文件选择）——它们不属于任何聚合，直接用注入的机制。
 *
 * 写 store 的例外只有两处，都不在这里：settings 有自己的写规则（明文入、
 * 密文落盘），留在 handler 层；而导入合并与 AI 历史是整批写，交给
 * importService / aiHistoryService。新增通道前先看这两处，不要就地写 store。
 */
export interface HandlerDeps {
  logger: Logger;
  getWindow: () => BrowserWindow | null;
  getVersion: () => string;
  tasks: TaskService;
  ideas: IdeaService;
  followUps: FollowUpService;
  projects: ProjectService;
  chatSink: ChatEventSink;
}

/** AppData sent to the renderer never contains real keys. */
export function masked(data: AppData): AppData {
  return maskDataForRenderer(data);
}

export function sendSafe(win: BrowserWindow | null, channel: string, payload: unknown): void {
  // check-ipc: ok — callers pass Ipc.* constants only
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
