import type { BrowserWindow } from 'electron';
import type { WindowState } from '../../shared/domain';
import type { SettingsStore } from '../store/settings-store';

/** Long enough to coalesce a drag or resize, short enough to survive a crash. */
const PERSIST_DEBOUNCE_MS = 500;

export function readWindowState(win: BrowserWindow): WindowState {
  // getNormalBounds, not getBounds: for a maximised or full-screen window the
  // latter is the enlarged geometry, and restoring that on next launch would
  // leave the user with an un-maximised window the size of their whole screen.
  const bounds = win.getNormalBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  };
}

/**
 * Persists window geometry, debounced, and always on close.
 *
 * Returns a disposer. The debounce matters because `resize` fires per pixel
 * during a drag, and each persist is a synchronous file write — writing through
 * a window resize is exactly the kind of thing that makes an app feel cheap.
 */
export function trackWindowState(win: BrowserWindow, settings: SettingsStore): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persist = (): void => {
    if (win.isDestroyed()) return;
    settings.patch({ window: readWindowState(win) });
  };

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, PERSIST_DEBOUNCE_MS);
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('enter-full-screen', schedule);
  win.on('leave-full-screen', schedule);

  // Flush synchronously on close: the debounced timer will not fire after this.
  win.on('close', () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    persist();
  });

  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    win.removeListener('resize', schedule);
    win.removeListener('move', schedule);
    win.removeListener('maximize', schedule);
    win.removeListener('unmaximize', schedule);
    win.removeListener('enter-full-screen', schedule);
    win.removeListener('leave-full-screen', schedule);
  };
}
