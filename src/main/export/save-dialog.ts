/**
 * The save dialog for an export (PLAN Phase 8).
 *
 * Its only job is to be the sole source of a destination path. `ExportStartRequest`
 * carries no path field, so nothing the renderer sends can decide where bytes are
 * written — the user picks, through an OS dialog, every time.
 *
 * Separated from `ExportService` so the service stays testable without Electron: it
 * takes a `pickPath` function, and this is the production one.
 */
import { dialog, type BrowserWindow, type SaveDialogOptions } from 'electron';
import { defaultFileExtension, formatLabel, type ExportFormat } from '../../shared/export';

export type SavePathPicker = (
  suggestedFileName: string,
  format: ExportFormat,
) => Promise<string | null>;

export function createSavePathPicker(window: () => BrowserWindow | null): SavePathPicker {
  return async (suggestedFileName, format) => {
    const filters = [
      { name: formatLabel(format), extensions: [defaultFileExtension(format)] },
      { name: 'All files', extensions: ['*'] },
    ];
    // Annotated rather than inferred: without the type, `properties` widens to
    // `string[]` and no longer assigns to Electron's literal union.
    const options: SaveDialogOptions = {
      title: 'Export result',
      buttonLabel: 'Export',
      defaultPath: suggestedFileName,
      filters,
      properties: ['createDirectory', 'showHiddenFiles', 'dontAddToRecent'],
    };

    // Parented when there is a window: a sheet-modal on macOS, and on every
    // platform a dialog that cannot be lost behind the window it belongs to.
    const win = window();
    const result =
      win && !win.isDestroyed()
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);

    // `canceled` and an empty path are the same answer, and neither is an error.
    return result.canceled || result.filePath === '' ? null : result.filePath;
  };
}
