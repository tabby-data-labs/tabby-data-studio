import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel, type DatabaseApi } from '../shared/ipc-contract';
import type { Result } from '../shared/errors';
import type { TabbyApi, TabbyEvents, Unsubscribe } from '../shared/renderer-api';

/**
 * The only bridge between the sandboxed renderer and the outside world.
 *
 * `ipcRenderer` itself is never exposed — not as a property, and not reachable
 * through a returned object. Every capability is an explicit method listed here
 * and typed in `src/shared/ipc-contract.ts`, so the renderer can only ask for
 * something main has decided to serve, and main validates each payload before
 * acting on it.
 */
function invoke<T>(channel: string, payload?: unknown): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<Result<T>>;
}

/**
 * Subscribes to a main → renderer event and returns an unsubscribe function.
 *
 * The channel is fixed at the call site rather than supplied by the renderer, so
 * there is no way to subscribe to an arbitrary channel. The listener is wrapped
 * so a throwing handler cannot break the emitter, and `removeListener` receives
 * the wrapper rather than the caller's function.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const wrapped = (_event: unknown, payload: T): void => {
    try {
      listener(payload);
    } catch {
      // A broken renderer listener must not take down the emitter.
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const db: DatabaseApi = {
  getSettings: () => invoke(IpcChannel.settingsGet),
  patchSettings: (patch) => invoke(IpcChannel.settingsPatch, patch),
  getWindowState: () => invoke(IpcChannel.windowState),

  listConnections: () => invoke(IpcChannel.connList),
  saveConnection: (req) => invoke(IpcChannel.connSave, req),
  deleteConnection: (connectionId) => invoke(IpcChannel.connDelete, connectionId),
  testConnection: (connectionId) => invoke(IpcChannel.connTest, connectionId),
  openConnection: (connectionId) => invoke(IpcChannel.connOpen, connectionId),
  closeConnection: (connectionId) => invoke(IpcChannel.connClose, connectionId),

  schemaChildren: (req) => invoke(IpcChannel.schemaChildren, req),
  schemaTable: (req) => invoke(IpcChannel.schemaTable, req),

  queryRun: (req) => invoke(IpcChannel.queryRun, req),
  queryCancel: (resultId) => invoke(IpcChannel.queryCancel, resultId),
  resultWindow: (req) => invoke(IpcChannel.resultWindow, req),
  resultSort: (req) => invoke(IpcChannel.resultSort, req),
  resultDispose: (resultId) => invoke(IpcChannel.resultDispose, resultId),
};

const events: TabbyEvents = {
  onQueryProgress: (listener) => subscribe(IpcChannel.evQueryProgress, listener),
  onConnectionLost: (listener) => subscribe(IpcChannel.evConnectionLost, listener),
  onResultEvicted: (listener) => subscribe(IpcChannel.evResultEvicted, listener),
};

const api: TabbyApi = {
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
  },
  db,
  events,
};

// Frozen so a compromised renderer cannot monkey-patch a method to intercept
// another call. contextBridge clones what it exposes, but freezing the source
// too makes the intent explicit and survives a future refactor.
contextBridge.exposeInMainWorld('tabby', Object.freeze(api));
