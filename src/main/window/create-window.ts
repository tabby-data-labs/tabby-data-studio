import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

/** Matches the renderer's --color-surface so there is no white flash on launch. */
const BACKGROUND = '#030b16';

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: BACKGROUND,
    title: 'Tabby',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The four lines below are the security model. Do not relax any of them.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.on('ready-to-show', () => {
    win.show();
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}
