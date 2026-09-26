import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window/create-window';
import { applySecurityGuards } from './security/navigation';

app.whenReady().then(() => {
  // Must be installed before the first window so every webContents is covered.
  applySecurityGuards(app.isPackaged ? 'prod' : 'dev');

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // macOS keeps the app alive with no windows; quitting here would break Cmd+Tab return.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
