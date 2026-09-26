import { contextBridge } from 'electron';
import type { TabbyApi } from '../shared/renderer-api';

/**
 * The only bridge between the sandboxed renderer and the outside world.
 * `ipcRenderer` itself is never exposed — every capability must be an explicit
 * method added here and typed in src/shared/ipc-contract.ts.
 */
const api: TabbyApi = {
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
  },
};

contextBridge.exposeInMainWorld('tabby', api);
