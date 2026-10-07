import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { ThemeName, WindowState } from '../../shared/domain';

/**
 * Matches the renderer's `--color-surface` for each theme, so there is no flash of
 * the other theme between the window appearing and the first paint.
 *
 * Read from the persisted settings rather than defaulted to dark: a light-theme
 * user would otherwise get a dark rectangle for a frame on every launch, which is
 * exactly the artefact this constant exists to prevent.
 */
const BACKGROUND: Readonly<Record<ThemeName, string>> = {
  dark: '#030b16',
  light: '#ffffff',
};

export interface MainWindowOptions {
  readonly state: WindowState;
  readonly theme: ThemeName;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const { state, theme } = options;

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: BACKGROUND[theme],
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
