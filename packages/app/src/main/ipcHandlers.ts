import {
  Ipc,
  IpcInvokeContract,
  type IpcInvokeHandlers,
  type IpcInvokeKey,
} from '@tiny-schedule/shared';
import { type BrowserWindow, ipcMain } from 'electron';
import type { Logger } from 'pino';
import { aiHandlers } from './handlers/ai';
import { appHandlers } from './handlers/app';
import { chatHandlers } from './handlers/chat';
import type { HandlerDeps } from './handlers/deps';
import { masked, sendSafe } from './handlers/deps';
import { followUpHandlers } from './handlers/followUp';
import { ideaHandlers } from './handlers/idea';
import { projectHandlers } from './handlers/project';
import { settingsHandlers } from './handlers/settings';
import { taskHandlers } from './handlers/task';
import type { DataStore } from './infra/dataStore';
import { decryptKey } from './infra/keys';
import { type ChatEventSink, createChatService } from './services/chatService';
import { createFollowUpService } from './services/followUpService';
import { createIdeaService } from './services/ideaService';
import { createProjectService } from './services/projectService';
import { createTaskService } from './services/taskService';

export interface IpcDeps {
  store: DataStore;
  logger: Logger;
  getWindow: () => BrowserWindow | null;
  getVersion: () => string;
}

/**
 * 组装点，不是逻辑所在：这里只做三件事——建 services、拼 handlers、跑注册循环。
 * 每个 handler 模块只做 zod 校验（由注册循环统一执行）与转调；领域规则在 services。
 */
export function registerIpcHandlers(deps: IpcDeps): void {
  const { store, logger, getWindow, getVersion } = deps;

  const serviceDeps = { store, logger };
  const tasks = createTaskService(serviceDeps);
  const ideas = createIdeaService(serviceDeps);
  const followUps = createFollowUpService(serviceDeps);
  const projects = createProjectService(serviceDeps);
  const chatSink: ChatEventSink = {
    chunk: (sessionId, requestId, delta) =>
      sendSafe(getWindow(), Ipc.chatChunk, { sessionId, requestId, delta }),
    tool: (ev) => sendSafe(getWindow(), Ipc.chatToolEvent, ev),
    status: (ev) => sendSafe(getWindow(), Ipc.chatStatus, ev),
    done: (sessionId, requestId) => sendSafe(getWindow(), Ipc.chatDone, { sessionId, requestId }),
    error: (ev) => sendSafe(getWindow(), Ipc.chatError, ev),
  };

  const chatManager = createChatService({
    store,
    logger,
    tasks,
    projects,
    decryptKey,
    sink: chatSink,
  });

  const handlerDeps: HandlerDeps = {
    logger,
    getWindow,
    getVersion,
    tasks,
    ideas,
    followUps,
    projects,
    chatSink,
  };

  // IpcInvokeHandlers is exhaustive over IpcInvokeContract: forgetting a
  // handler (or adding a contract entry without implementing it) is a
  // compile error.
  const handlers: IpcInvokeHandlers = {
    dataLoad: () => masked(store.get()),
    ...taskHandlers(handlerDeps),
    ...ideaHandlers(handlerDeps),
    ...followUpHandlers(handlerDeps),
    ...projectHandlers(handlerDeps),
    ...settingsHandlers({ store, logger }),
    ...chatHandlers(chatManager),
    ...aiHandlers({ store, logger, getWindow }),
    ...appHandlers({ store, logger, getWindow, getVersion }),
  };

  type ContractEntry = { ch: string; req?: { parse(raw: unknown): unknown } };
  for (const [key, entry] of Object.entries(IpcInvokeContract) as [IpcInvokeKey, ContractEntry][]) {
    const handler = handlers[key] as ((req: unknown) => unknown) | undefined;
    // Runtime belt-and-braces for the compile-time exhaustiveness of
    // IpcInvokeHandlers: fail fast instead of registering a dead channel.
    if (!handler) throw new Error(`Missing IPC handler for ${key} (${entry.ch})`);
    // Every request is zod-parsed here, before the handler runs.
    // check-ipc: ok — entry.ch comes from IpcInvokeContract
    ipcMain.handle(entry.ch, (_e, raw: unknown) => handler(entry.req ? entry.req.parse(raw) : raw));
  }
}
