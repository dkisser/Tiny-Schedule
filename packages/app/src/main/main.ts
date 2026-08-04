import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { app, BrowserWindow } from 'electron';
import { DataStore } from './dataStore';
import { registerIpcHandlers } from './ipcHandlers';
import { createLogger } from './logger';

let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.on('ready-to-show', () => window.show());
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return window;
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const logger = createLogger(join(userData, 'logs'));
  const store = new DataStore(userData);
  store.load();
  logger.info({ action: 'app:start', activeTimer: store.get().activeTimer?.taskId ?? null });
  registerIpcHandlers({ store, logger, getWindow: () => win });
  win = createWindow();
  win.on('closed', () => {
    win = null;
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow();
      win.on('closed', () => {
        win = null;
      });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
