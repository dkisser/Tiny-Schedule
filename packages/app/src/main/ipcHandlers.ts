import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  type AppData,
  addDays,
  type ChatSession,
  type ImportRunResult,
  INBOX_PROJECT_ID,
  Ipc,
  IpcInvokeContract,
  type IpcInvokeHandlers,
  type IpcInvokeKey,
  localDate,
  maskDataForRenderer,
} from '@tiny-schedule/shared';
import {
  type BrowserWindow,
  dialog as electronDialog,
  ipcMain,
  Notification,
  shell,
} from 'electron';
import type { Logger } from 'pino';
import { ChatAgentManager } from './ai/chatAgent';
import { streamChat, testConnection } from './ai/client';
import { buildAnalysisData, renderPrompt } from './ai/prompts';
import { getProviderDef, PROVIDER_REGISTRY, toProviderInfo } from './ai/providers';
import type { DataStore } from './dataStore';
import { exportProjectTaskList, exportWorklog } from './exporter';
import { mergeImport, normalizeBackup } from './importer';
import { decryptKey, encryptKey } from './keys';
import { addTaskToMacCalendar } from './macos/calendar';
import { migrateRemoveTodayTag } from './migrations';
import { checkForUpdate } from './updater';

export interface IpcDeps {
  store: DataStore;
  logger: Logger;
  getWindow: () => BrowserWindow | null;
  getVersion: () => string;
}

function masked(data: AppData): AppData {
  return maskDataForRenderer(data);
}

function sendSafe(win: BrowserWindow | null, channel: string, payload: unknown): void {
  // check-ipc: ok — callers pass Ipc.* constants only
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { store, logger, getWindow, getVersion } = deps;

  const chatManager = new ChatAgentManager({
    getSessions: () => (store.get().misc.chatSessions ?? []) as ChatSession[],
    saveSession: (s) => {
      store.update((d) => {
        const list = ((d.misc.chatSessions ?? []) as ChatSession[]).filter((x) => x.id !== s.id);
        return { ...d, misc: { ...d.misc, chatSessions: [s, ...list] } };
      });
    },
    deleteStoredSession: (id) => {
      let next: ChatSession[] = [];
      store.update((d) => {
        next = ((d.misc.chatSessions ?? []) as ChatSession[]).filter((x) => x.id !== id);
        return { ...d, misc: { ...d.misc, chatSessions: next } };
      });
      return next;
    },
    getProviders: () => store.get().settings.aiProviders,
    decryptKey,
    getData: () => store.get(),
    today: () => localDate(Date.now()),
    sink: {
      chunk: (sessionId, requestId, delta) =>
        sendSafe(getWindow(), Ipc.chatChunk, { sessionId, requestId, delta }),
      tool: (ev) => sendSafe(getWindow(), Ipc.chatToolEvent, ev),
      status: (ev) => sendSafe(getWindow(), Ipc.chatStatus, ev),
      done: (sessionId, requestId) => sendSafe(getWindow(), Ipc.chatDone, { sessionId, requestId }),
      error: (ev) => sendSafe(getWindow(), Ipc.chatError, ev),
    },
    logger,
  });

  // IpcInvokeHandlers is exhaustive over IpcInvokeContract: forgetting a
  // handler (or adding a contract entry without implementing it) is a
  // compile error.
  const handlers: IpcInvokeHandlers = {
    dataLoad: () => masked(store.get()),

    taskUpsert: (task) => {
      // 规范化完成时间：任何入口标记完成都保证有 doneAt，重开则清除
      const normalized = { ...task, doneAt: task.isDone ? (task.doneAt ?? Date.now()) : undefined };
      const next = store.update((d) => ({
        ...d,
        tasks: { ...d.tasks, [normalized.id]: normalized },
      }));
      logger.info({ action: 'task:upsert', taskId: task.id, title: task.title });
      return masked(next);
    },

    taskDelete: ({ id }) => {
      const next = store.update((d) => {
        const tasks = { ...d.tasks };
        delete tasks[id];
        // detach from parent's subTaskIds
        for (const t of Object.values(tasks)) {
          if (t.subTaskIds.includes(id)) {
            tasks[t.id] = { ...t, subTaskIds: t.subTaskIds.filter((s) => s !== id) };
          }
        }
        return { ...d, tasks };
      });
      logger.info({ action: 'task:delete', taskId: id });
      return masked(next);
    },

    orderSet: ({ viewKey, ids }) => {
      store.update((d) => {
        const taskOrder = (d.misc.taskOrder ?? {}) as Record<string, string[]>;
        return { ...d, misc: { ...d.misc, taskOrder: { ...taskOrder, [viewKey]: ids } } };
      });
      logger.info({ action: 'order:set', viewKey, count: ids.length });
    },

    projectCreate: (req) => {
      const next = store.update((d) => {
        const id = `p_${randomUUID()}`;
        return {
          ...d,
          projects: {
            ...d.projects,
            [id]: {
              id,
              title: req.title,
              icon: req.icon,
              isArchived: false,
              primaryColor: req.primaryColor,
            },
          },
        };
      });
      logger.info({ action: 'project:create', title: req.title });
      return masked(next);
    },

    projectUpdate: (req) => {
      const next = store.update((d) => {
        const prev = d.projects[req.id];
        // Inbox is a system project: never accept updates through the IPC.
        if (!prev || req.id === INBOX_PROJECT_ID) return d;
        // Partial-merge: only apply fields that are explicitly present in the
        // request. `null` clears (e.g. clearing a project color); `undefined`
        // leaves the existing value untouched. Mirrors `tagUpdate`.
        const patch: Partial<typeof prev> = {};
        if (req.title !== undefined) patch.title = req.title;
        if (req.primaryColor !== undefined) patch.primaryColor = req.primaryColor;
        if (req.isArchived !== undefined) patch.isArchived = req.isArchived;
        if (Object.keys(patch).length === 0) return d;
        return {
          ...d,
          projects: { ...d.projects, [req.id]: { ...prev, ...patch } },
        };
      });
      logger.info({
        action: 'project:update',
        id: req.id,
        keys: Object.keys(req).filter((k) => k !== 'id'),
      });
      return masked(next);
    },

    projectDelete: (req) => {
      if (req.id === INBOX_PROJECT_ID) return masked(store.get());
      const next = store.update((d) => {
        if (!d.projects[req.id]) return d;
        const projects = { ...d.projects };
        delete projects[req.id];
        // Tasks keep their projectTitle snapshot; only the grouping moves to Inbox.
        const tasks = { ...d.tasks };
        for (const t of Object.values(tasks)) {
          if (t.projectId === req.id) tasks[t.id] = { ...t, projectId: INBOX_PROJECT_ID };
        }
        return { ...d, projects, tasks };
      });
      logger.info({ action: 'project:delete', id: req.id });
      return masked(next);
    },

    tagCreate: (req) => {
      const next = store.update((d) => {
        const id = `tag_${randomUUID()}`;
        return { ...d, tags: { ...d.tags, [id]: { id, title: req.title, color: req.color } } };
      });
      logger.info({ action: 'tag:create', title: req.title });
      return masked(next);
    },

    tagUpdate: (req) => {
      const next = store.update((d) => {
        const prev = d.tags[req.id];
        if (!prev) return d;
        const updated = {
          ...prev,
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.color !== undefined ? { color: req.color } : {}),
        };
        return { ...d, tags: { ...d.tags, [req.id]: updated } };
      });
      logger.info({ action: 'tag:update', id: req.id, title: req.title });
      return masked(next);
    },

    tagDelete: (req) => {
      const next = store.update((d) => {
        if (!d.tags[req.id]) return d;
        const tags = { ...d.tags };
        delete tags[req.id];
        // Tasks keep tagIds + snapshot labels so their chips stay visible.
        return { ...d, tags };
      });
      logger.info({ action: 'tag:delete', id: req.id });
      return masked(next);
    },

    settingsUpdate: (patch) => {
      const next = store.update((d) => {
        const settings = { ...d.settings };
        if (patch.userName !== undefined) settings.userName = patch.userName;
        if (patch.avatar !== undefined) settings.avatar = patch.avatar;
        if (patch.theme !== undefined) settings.theme = patch.theme;
        if (patch.aiPrompt !== undefined) settings.aiPrompt = patch.aiPrompt;
        if (patch.autoAiAnalyzeOnFinishDay !== undefined) {
          settings.autoAiAnalyzeOnFinishDay = patch.autoAiAnalyzeOnFinishDay;
        }
        if (patch.idlePauseEnabled !== undefined)
          settings.idlePauseEnabled = patch.idlePauseEnabled;
        if (patch.idlePauseMinutes !== undefined)
          settings.idlePauseMinutes = patch.idlePauseMinutes;
        if (patch.aiProviders !== undefined) {
          settings.aiProviders = patch.aiProviders.map((p) => {
            const prev = d.settings.aiProviders.find((x) => x.id === p.id);
            return {
              id: p.id,
              registryId: p.registryId,
              baseUrl: p.baseUrl,
              apiKeyEncrypted:
                p.apiKey === '<unchanged>' && prev ? prev.apiKeyEncrypted : encryptKey(p.apiKey),
              model: p.model,
              isDefault: p.isDefault,
            };
          });
        }
        return { ...d, settings };
      });
      logger.info({ action: 'settings:update', keys: Object.keys(patch) });
      return masked(next);
    },

    timerSync: ({ timer }) => {
      store.update((d) => ({ ...d, activeTimer: timer }));
      if (timer)
        logger.info({ action: 'timer:sync', taskId: timer.taskId, isPaused: timer.isPaused });
    },

    finishDay: (_req) => {
      // payload date is validated but not used for logic: finishing always applies to the local "today"
      const today = localDate(Date.now());
      const tomorrow = addDays(today, 1);
      const next = store.update((d) => {
        const tasks = { ...d.tasks };
        for (const t of Object.values(tasks)) {
          // Roll unfinished tasks due today to tomorrow so they remain visible
          // in the dueDay-driven Today view instead of silently disappearing.
          if (!t.isDone && t.dueDay === today) {
            tasks[t.id] = { ...t, dueDay: tomorrow };
          }
        }
        return { ...d, tasks, misc: { ...d.misc, lastFinishDay: today } };
      });
      logger.info({ action: 'day:finish', date: today });
      return masked(next);
    },

    importRun: async (): Promise<ImportRunResult> => {
      const win = getWindow();
      if (!win) return { ok: false, error: 'NO_WINDOW' };
      const picked = await electronDialog.showOpenDialog(win, {
        title: '导入 Super Productivity 备份',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (picked.canceled || picked.filePaths.length === 0)
        return { ok: false, error: 'CANCELLED' };
      try {
        const raw = JSON.parse(await readFile(picked.filePaths[0] as string, 'utf8'));
        const { data: imported, counts } = normalizeBackup(raw);
        const taskCount = Object.keys(store.get().tasks).length;
        if (taskCount > 0) {
          const confirm = await electronDialog.showMessageBox(win, {
            type: 'question',
            buttons: ['合并', '取消'],
            defaultId: 0,
            cancelId: 1,
            message: '本地已有数据',
            detail: `导入将追加合并到当前 ${taskCount} 个任务中（ID 相同时以导入数据为准，现有 AI 会话与其余任务保留）。`,
          });
          if (confirm.response !== 0) return { ok: false, error: 'CANCELLED' };
        }
        const next = store.update((d) => migrateRemoveTodayTag(mergeImport(d, imported)));
        logger.info({ action: 'import:run', counts, file: picked.filePaths[0] });
        void next;
        return { ok: true, counts };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ action: 'import:run', error: message });
        return { ok: false, error: message };
      }
    },

    exportMarkdown: async (req) => {
      const win = getWindow();
      if (!win) return { savedPath: null, error: 'NO_WINDOW' };
      const data = store.get();
      let content: string;
      let defaultName: string;
      try {
        if (req.mode === 'projectList') {
          if (!req.projectId) return { savedPath: null, error: 'MISSING_PROJECT_ID' };
          content = exportProjectTaskList(data, req.projectId);
          defaultName = `${data.projects[req.projectId]?.title ?? 'project'}-任务清单.md`;
        } else {
          const from = req.from ?? '1970-01-01';
          const to = req.to ?? '2999-12-31';
          content = exportWorklog(data, { from, to, projectId: req.projectId });
          defaultName = `工作日志-${from}-${to}.md`;
        }
      } catch (err) {
        return { savedPath: null, error: err instanceof Error ? err.message : String(err) };
      }
      const save = await electronDialog.showSaveDialog(win, { defaultPath: defaultName });
      if (save.canceled || !save.filePath) return { savedPath: null };
      await writeFile(save.filePath, content, 'utf8');
      logger.info({ action: 'export:markdown', mode: req.mode, path: save.filePath });
      return { savedPath: save.filePath };
    },

    aiRegistry: () => PROVIDER_REGISTRY.map(toProviderInfo),

    selectAvatar: async () => {
      const win = getWindow();
      if (!win) return null;
      const picked = await electronDialog.showOpenDialog(win, {
        title: '选择头像图片',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
        properties: ['openFile'],
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      const filePath = picked.filePaths[0] as string;
      const buf = await readFile(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      return `data:${mime};base64,${buf.toString('base64')}`;
    },

    aiTestProvider: async ({ providerId }) => {
      const cfg = store.get().settings.aiProviders.find((p) => p.id === providerId);
      if (!cfg) return { ok: false, error: 'PROVIDER_NOT_CONFIGURED' };
      const def = getProviderDef(cfg.registryId);
      const baseUrl = cfg.baseUrl ?? def?.baseUrl ?? '';
      if (!baseUrl) return { ok: false, error: 'MISSING_BASE_URL' };
      const result = await testConnection(baseUrl, decryptKey(cfg.apiKeyEncrypted));
      logger.info({ action: 'ai:testProvider', providerId, ok: result.ok });
      return result;
    },

    aiProviderKeyReveal: ({ providerId }) => {
      const cfg = store.get().settings.aiProviders.find((p) => p.id === providerId);
      if (!cfg) return { apiKey: '' };
      return { apiKey: decryptKey(cfg.apiKeyEncrypted) };
    },

    aiAnalyze: async (req) => {
      const requestId = randomUUID();
      const data = store.get();
      const providers = data.settings.aiProviders;
      const cfg = req.providerId
        ? providers.find((p) => p.id === req.providerId)
        : (providers.find((p) => p.isDefault) ?? providers[0]);
      if (!cfg) {
        sendSafe(getWindow(), Ipc.aiError, { requestId, error: 'NO_PROVIDER_CONFIGURED' });
        return { requestId };
      }
      const def = getProviderDef(cfg.registryId);
      const baseUrl = cfg.baseUrl ?? def?.baseUrl ?? '';
      const today = localDate(Date.now());
      const prompt = renderPrompt(data.settings.aiPrompt, {
        date: today,
        data: buildAnalysisData(data, { scope: req.scope, date: today, projectId: req.projectId }),
      });
      logger.info({ action: 'ai:analyze', requestId, scope: req.scope, providerId: cfg.id });
      void (async () => {
        const win = getWindow();
        let full = '';
        try {
          for await (const delta of streamChat({
            baseUrl,
            apiKey: decryptKey(cfg.apiKeyEncrypted),
            model: cfg.model,
            messages: [{ role: 'user', content: prompt }],
          })) {
            full += delta;
            sendSafe(win, Ipc.aiChunk, { requestId, delta });
          }
          // Persist before signaling done so the renderer can reload and see the history entry.
          store.update((d) => {
            const history = [
              {
                id: randomUUID(),
                scope: req.scope,
                ...(req.projectId ? { projectId: req.projectId } : {}),
                createdAt: Date.now(),
                content: full,
              },
              ...((d.misc.aiHistory ?? []) as unknown[]),
            ].slice(0, 50);
            return { ...d, misc: { ...d.misc, aiHistory: history } };
          });
          sendSafe(win, Ipc.aiDone, { requestId, full });
          logger.info({ action: 'ai:analyze:done', requestId, length: full.length });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendSafe(win, Ipc.aiError, { requestId, error: message, full });
          logger.error({ action: 'ai:analyze:error', requestId, error: message });
        }
      })();
      return { requestId };
    },

    chatSessionsList: () => chatManager.listSessions(),
    chatSessionCreate: (req) => chatManager.createSession(req.providerId),
    chatSessionDelete: (req) => chatManager.deleteSession(req.sessionId),
    chatSend: (req) => chatManager.send(req.sessionId, req.text, req.providerId),
    chatContinue: (req) => chatManager.continue(req.sessionId),
    chatStop: async (req) => {
      chatManager.stop(req.sessionId);
      // 等 run 结算（含 aborted 尾部的 persist），渲染端随后 load() 才能看到中断内容
      await chatManager.waitForIdle(req.sessionId);
    },

    appCheckUpdate: () => checkForUpdate(getVersion()),

    calendarAddTask: async ({ taskId }) => {
      const snapshot = store.get();
      const task = snapshot.tasks[taskId];
      if (!task) {
        logger.warn({ action: 'calendar:addTask', taskId, reason: 'not-found' });
        return { ok: false, code: 'unknown', message: '任务不存在' } as const;
      }
      const project = snapshot.projects[task.projectId];
      const result = await addTaskToMacCalendar({ task, project });
      if (!result.ok) {
        logger.warn({
          action: 'calendar:addTask',
          taskId,
          code: result.code,
          message: result.message,
        });
      } else {
        logger.info({ action: 'calendar:addTask', taskId, eventId: result.eventId });
      }
      return result;
    },

    appOpenExternal: async ({ url }) => {
      // Only https: reaches shell.openExternal; other schemes (file:,
      // javascript:, ...) are refused so this channel cannot launch local apps.
      if (!url.startsWith('https://')) {
        logger.warn({ action: 'app:openExternal', url, blocked: true });
        return;
      }
      await shell.openExternal(url);
      logger.info({ action: 'app:openExternal', url });
    },

    notifyPhaseComplete: ({ phase, title, body }) => {
      // Use the OS notification so the user gets a sound + center-screen
      // banner even if the renderer is hidden or the user is on another
      // desktop. Notification is supported on macOS/Windows out of the box;
      // on Linux it depends on libnotify.
      if (!Notification.isSupported()) {
        logger.warn({ action: 'notify:phaseComplete', phase, supported: false });
        return;
      }
      const n = new Notification({ title, body, silent: false });
      n.show();
      logger.info({ action: 'notify:phaseComplete', phase });
    },

    setAlwaysOnTopWindow: ({ enabled }) => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      // 'screen-saver' floats above full-screen apps on macOS; 'floating'
      // is sufficient on Windows / Linux and avoids stealing focus.
      win.setAlwaysOnTop(enabled, enabled ? 'floating' : 'normal');
      if (enabled) win.show();
      logger.info({ action: 'window:setAlwaysOnTop', enabled });
    },
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
