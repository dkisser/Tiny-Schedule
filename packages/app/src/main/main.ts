import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { applySettlement, Ipc, settleTimer } from '@tiny-schedule/shared';
import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import type { Logger } from 'pino';
import { DataStore } from './dataStore';
import { registerIpcHandlers } from './ipcHandlers';
import { createLogger } from './logger';
import { migrateRemoveTodayTag } from './migrations';

let win: BrowserWindow | null = null;
let store: DataStore | null = null;
let logger: Logger | null = null;
// Set only after the user confirms quitting with a running timer; never latched
// on the no-timer path, so a later quit attempt still triggers the confirmation.
let allowQuit = false;
let quitConfirmOpen = false;

function settleActiveTimer(dataStore: DataStore, log: Logger): void {
  const timer = dataStore.get().activeTimer;
  if (!timer) return;
  const settlement = settleTimer(timer, Date.now());
  dataStore.update((d) => {
    const task = d.tasks[timer.taskId];
    if (!task) return { ...d, activeTimer: null };
    return {
      ...d,
      tasks: { ...d.tasks, [task.id]: applySettlement(task, settlement) },
      activeTimer: null,
    };
  });
  log.info({ action: 'timer:settle:quit', taskId: timer.taskId, ms: settlement.ms });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.on('ready-to-show', () => window.show());
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
}

function trackWindow(window: BrowserWindow): void {
  win = window;
  window.on('closed', () => {
    win = null;
  });
  window.on('close', (e) => {
    if (allowQuit || !store) return;
    const timer = store.get().activeTimer;
    if (!timer) return;
    e.preventDefault();
    if (quitConfirmOpen) return;
    quitConfirmOpen = true;
    void dialog
      .showMessageBox(window, {
        type: 'question',
        buttons: ['结算并退出', '取消'],
        defaultId: 0,
        cancelId: 1,
        message: '计时器正在运行',
        detail: '退出将中断计时，已消耗的时间会结算到任务耗时。',
      })
      .then(({ response }) => {
        quitConfirmOpen = false;
        if (response !== 0) return;
        if (store && logger) settleActiveTimer(store, logger);
        allowQuit = true;
        app.quit();
      })
      .catch(() => {
        quitConfirmOpen = false;
      });
  });
}

function buildMenu(sendNewTask: () => void): Menu {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: '任务',
      submenu: [{ label: '新建任务', accelerator: 'CmdOrCtrl+N', click: sendNewTask }],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

// macOS Cmd+Q / application-quit paths emit before-quit first; make sure the
// running-timer confirmation also applies there by routing through the window
// close handler (or settling directly when no window exists).
app.on('before-quit', (e) => {
  if (allowQuit || !store) return;
  if (!store.get().activeTimer) return;
  e.preventDefault();
  if (win && !win.isDestroyed()) {
    win.close();
  } else {
    if (logger) settleActiveTimer(store, logger);
    allowQuit = true;
    app.quit();
  }
});

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  logger = createLogger(join(userData, 'logs'));
  store = new DataStore(userData);
  store.load();
  const migrated = migrateRemoveTodayTag(store.get());
  if (migrated !== store.get()) store.save(migrated);
  logger.info({ action: 'app:start', activeTimer: store.get().activeTimer?.taskId ?? null });
  registerIpcHandlers({ store, logger, getWindow: () => win });
  Menu.setApplicationMenu(
    buildMenu(() => {
      if (win && !win.isDestroyed()) win.webContents.send(Ipc.uiNewTask);
    }),
  );
  trackWindow(createWindow());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      trackWindow(createWindow());
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
