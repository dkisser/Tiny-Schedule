import { readFile, writeFile } from 'node:fs/promises';
import { type ImportRunResult, Ipc } from '@tiny-schedule/shared';
import { type BrowserWindow, dialog as electronDialog, Notification, shell } from 'electron';
import type { DataStore } from '../infra/dataStore';
import { exportProjectTaskList, exportWorklog } from '../infra/exporter';
import { normalizeBackup } from '../infra/importer';
import { addTaskToMacCalendar } from '../infra/macos/calendar';
import { checkForUpdate } from '../infra/updater';
import type { ImportService } from '../services/importService';
import { sendSafe } from './deps';

/**
 * 系统级通道：导入导出、头像、日历、外链、通知、窗口、更新检查。
 * 它们不属于任何聚合，因此没有 service——机制在 infra/，编排在这里。
 * 例外是导入：它不归属聚合，却是一条整批写路径，清扫陈旧计时的义务归
 * importService，handler 只负责对话框与广播。
 */
export function appHandlers({
  store,
  logger,
  getWindow,
  getVersion,
  imports,
}: {
  store: DataStore;
  logger: { info: (o: object) => void; warn: (o: object) => void; error: (o: object) => void };
  getWindow: () => BrowserWindow | null;
  getVersion: () => string;
  imports: ImportService;
}) {
  return {
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
        // The service owns the merge *and* the stale-timing sweep, so a done
        // task can never come back from an import still being timed. Announcing
        // the drop is ours: it is a message to the renderer's clock.
        const { data: next, droppedTimer } = imports.mergeImported(imported);
        if (droppedTimer) sendSafe(getWindow(), Ipc.timerChanged, null);
        logger.info({
          action: 'import:run',
          counts,
          file: picked.filePaths[0],
          keptTimer: !!next.activeTimer,
        });
        return { ok: true, counts };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ action: 'import:run', error: message });
        return { ok: false, error: message };
      }
    },

    exportMarkdown: async (req: {
      mode: 'projectList' | 'worklog';
      projectId?: string;
      from?: string;
      to?: string;
    }) => {
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

    appCheckUpdate: () => checkForUpdate(getVersion()),

    calendarAddTask: async ({ taskId }: { taskId: string }) => {
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

    appOpenExternal: async ({ url }: { url: string }) => {
      // Only https: reaches shell.openExternal; other schemes (file:,
      // javascript:, ...) are refused so this channel cannot launch local apps.
      if (!url.startsWith('https://')) {
        logger.warn({ action: 'app:openExternal', url, blocked: true });
        return;
      }
      await shell.openExternal(url);
      logger.info({ action: 'app:openExternal', url });
    },

    notifyPhaseComplete: ({
      phase,
      title,
      body,
    }: {
      phase: string;
      title: string;
      body: string;
    }) => {
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

    setAlwaysOnTopWindow: ({ enabled }: { enabled: boolean }) => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      // 'screen-saver' floats above full-screen apps on macOS; 'floating'
      // is sufficient on Windows / Linux and avoids stealing focus.
      win.setAlwaysOnTop(enabled, enabled ? 'floating' : 'normal');
      if (enabled) win.show();
      logger.info({ action: 'window:setAlwaysOnTop', enabled });
    },
  };
}
