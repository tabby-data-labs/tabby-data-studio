import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window/create-window';
import { trackWindowState } from './window/window-state';
import { applySecurityGuards } from './security/navigation';
import { registerIpcHandlers } from './ipc/router';
import { SettingsStore } from './store/settings-store';
import { safeStorageCipher } from './store/cipher';
import { createDbServices, type DbServices } from './db/services';
import { logError, logInfo, logWarn } from './log';

let mainWindow: BrowserWindow | null = null;
let disposeIpc: (() => void) | null = null;
let disposeWindowTracking: (() => void) | null = null;
let db: DbServices | null = null;

/** How long to wait for pools to close before forcing the process down. */
const SHUTDOWN_GRACE_MS = 2_000;

function openWindow(settings: SettingsStore): void {
  mainWindow = createMainWindow({ state: settings.current.window });
  disposeWindowTracking = trackWindowState(mainWindow, settings);

  mainWindow.on('closed', () => {
    disposeWindowTracking?.();
    disposeWindowTracking = null;
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Must be installed before the first window so every webContents is covered.
  applySecurityGuards(app.isPackaged ? 'prod' : 'dev');

  const settings = new SettingsStore({
    dir: app.getPath('userData'),
    cipher: safeStorageCipher,
  });

  if (settings.loadWarning) {
    // Surfaced, not swallowed: silently resetting someone's saved connections
    // would be far worse than telling them it happened.
    logWarn('settings', settings.loadWarning);
  }
  if (!safeStorageCipher.available) {
    logWarn(
      'settings',
      'OS keychain unavailable — connection passwords cannot be saved on this machine',
    );
  }

  db = createDbServices({
    settings,
    emit: (channel, payload) => {
      const win = mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });

  disposeIpc = registerIpcHandlers({
    settings,
    window: () => mainWindow,
    connections: db.connections,
    schemas: db.schemas,
    queries: db.queries,
  });
  logInfo('main', `IPC registered; userData=${app.getPath('userData')}`);

  openWindow(settings);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow(settings);
  });
});

app.on('window-all-closed', () => {
  // macOS keeps the app alive with no windows; quitting here would break Cmd+Tab return.
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', (event) => {
  disposeWindowTracking?.();
  disposeIpc?.();
  disposeWindowTracking = null;
  disposeIpc = null;

  const services = db;
  db = null;
  if (!services) return;

  // Pools hold sockets; quitting without ending them leaves the server with
  // idle backends — and open cursors — until its own timeout reaps them.
  event.preventDefault();
  const forced = setTimeout(() => app.exit(0), SHUTDOWN_GRACE_MS);
  services
    .dispose()
    .catch((error: unknown) => logError('main', error))
    .finally(() => {
      clearTimeout(forced);
      app.exit(0);
    });
});

// A renderer crash must not take the app down silently.
app.on('render-process-gone', (_event, _contents, details) => {
  logError('main', new Error(`renderer gone: ${details.reason} (exit ${details.exitCode})`));
});
