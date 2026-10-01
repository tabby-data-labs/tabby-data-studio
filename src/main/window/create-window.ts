import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { WindowState } from '../../shared/domain';

/** Matches the renderer's --color-surface so there is no white flash on launch. */
const BACKGROUND = '#030b16';

export interface MainWindowOptions {
  readonly state: WindowState;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const { state } = options;

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
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

  // Restore maximised/full-screen after creation: passing them to the
  // constructor races with the initial bounds on some platforms.
  if (state.isFullScreen) win.setFullScreen(true);
  else if (state.isMaximized) win.maximize();

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
