import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  AiAnalyzeReqSchema,
  AiTestReqSchema,
  type AppData,
  ExportMarkdownReqSchema,
  type ImportRunResult,
  Ipc,
  localDate,
  maskDataForRenderer,
  SettingsUpdateReqSchema,
  SYSTEM_TAG_IDS,
  TaskDeleteReqSchema,
  TaskSchema,
  TimerSyncReqSchema,
} from '@tiny-schedule/shared';
import { type BrowserWindow, dialog as electronDialog, ipcMain } from 'electron';
import type { Logger } from 'pino';
import { streamChat, testConnection } from './ai/client';
import { buildAnalysisData, renderPrompt } from './ai/prompts';
import { getProviderDef, PROVIDER_REGISTRY, toProviderInfo } from './ai/providers';
import type { DataStore } from './dataStore';
import { exportProjectTaskList, exportWorklog } from './exporter';
import { mergeImport, normalizeBackup } from './importer';
import { decryptKey, encryptKey } from './keys';

export interface IpcDeps {
  store: DataStore;
  logger: Logger;
  getWindow: () => BrowserWindow | null;
}

function masked(data: AppData): AppData {
  return maskDataForRenderer(data);
}

function sendSafe(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { store, logger, getWindow } = deps;

  ipcMain.handle(Ipc.dataLoad, () => masked(store.get()));

  ipcMain.handle(Ipc.taskUpsert, (_e, raw: unknown) => {
    const task = TaskSchema.parse(raw);
    const next = store.update((d) => ({ ...d, tasks: { ...d.tasks, [task.id]: task } }));
    logger.info({ action: 'task:upsert', taskId: task.id, title: task.title });
    return masked(next);
  });

  ipcMain.handle(Ipc.taskDelete, (_e, raw: unknown) => {
    const { id } = TaskDeleteReqSchema.parse(raw);
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
  });

  ipcMain.handle(Ipc.settingsUpdate, (_e, raw: unknown) => {
    const patch = SettingsUpdateReqSchema.parse(raw);
    const next = store.update((d) => {
      const settings = { ...d.settings };
      if (patch.userName !== undefined) settings.userName = patch.userName;
      if (patch.avatar !== undefined) settings.avatar = patch.avatar;
      if (patch.theme !== undefined) settings.theme = patch.theme;
      if (patch.aiPrompt !== undefined) settings.aiPrompt = patch.aiPrompt;
      if (patch.autoAiAnalyzeOnFinishDay !== undefined) {
        settings.autoAiAnalyzeOnFinishDay = patch.autoAiAnalyzeOnFinishDay;
      }
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
  });

  ipcMain.handle(Ipc.timerSync, (_e, raw: unknown) => {
    const { timer } = TimerSyncReqSchema.parse(raw);
    store.update((d) => ({ ...d, activeTimer: timer }));
    if (timer)
      logger.info({ action: 'timer:sync', taskId: timer.taskId, isPaused: timer.isPaused });
  });

  ipcMain.handle(Ipc.finishDay, () => {
    const today = localDate(Date.now());
    const next = store.update((d) => {
      const tasks = { ...d.tasks };
      for (const t of Object.values(tasks)) {
        if (!t.isDone && t.tagIds.includes(SYSTEM_TAG_IDS.today)) {
          tasks[t.id] = { ...t, tagIds: t.tagIds.filter((id) => id !== SYSTEM_TAG_IDS.today) };
        }
      }
      return { ...d, tasks, misc: { ...d.misc, lastFinishDay: today } };
    });
    logger.info({ action: 'day:finish', date: today });
    return masked(next);
  });

  ipcMain.handle(Ipc.importRun, async (): Promise<ImportRunResult> => {
    const win = getWindow();
    if (!win) return { ok: false, error: 'NO_WINDOW' };
    const picked = await electronDialog.showOpenDialog(win, {
      title: '导入 Super Productivity 备份',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: 'CANCELLED' };
    try {
      const raw = JSON.parse(await readFile(picked.filePaths[0] as string, 'utf8'));
      const { data: imported, counts } = normalizeBackup(raw);
      const next = store.update((d) => mergeImport(d, imported));
      logger.info({ action: 'import:run', counts, file: picked.filePaths[0] });
      void next;
      return { ok: true, counts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ action: 'import:run', error: message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(Ipc.exportMarkdown, async (_e, raw: unknown) => {
    const req = ExportMarkdownReqSchema.parse(raw);
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
  });

  ipcMain.handle(Ipc.selectAvatar, async () => {
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
  });

  ipcMain.handle(Ipc.aiRegistry, () => PROVIDER_REGISTRY.map(toProviderInfo));

  ipcMain.handle(Ipc.aiTestProvider, async (_e, raw: unknown) => {
    const { providerId } = AiTestReqSchema.parse(raw);
    const cfg = store.get().settings.aiProviders.find((p) => p.id === providerId);
    if (!cfg) return { ok: false, error: 'PROVIDER_NOT_CONFIGURED' };
    const def = getProviderDef(cfg.registryId);
    const baseUrl = cfg.baseUrl ?? def?.baseUrl ?? '';
    if (!baseUrl) return { ok: false, error: 'MISSING_BASE_URL' };
    const result = await testConnection(baseUrl, decryptKey(cfg.apiKeyEncrypted));
    logger.info({ action: 'ai:testProvider', providerId, ok: result.ok });
    return result;
  });

  ipcMain.handle(Ipc.aiAnalyze, async (_e, raw: unknown) => {
    const req = AiAnalyzeReqSchema.parse(raw);
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
        sendSafe(win, Ipc.aiDone, { requestId, full });
        logger.info({ action: 'ai:analyze:done', requestId, length: full.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendSafe(win, Ipc.aiError, { requestId, error: message, full });
        logger.error({ action: 'ai:analyze:error', requestId, error: message });
      }
    })();
    return { requestId };
  });
}
