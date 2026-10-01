/**
 * The renderer-facing API surface, exposed by the preload via contextBridge.
 *
 * Imported by the preload (to build the object), by the renderer (to type
 * `window.tabby`), and by tests. No runtime imports — this is types only.
 */
import type { DatabaseApi, QueryProgressEvent } from './ipc-contract';

export interface TabbyVersions {
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
}

/**
 * An unsubscribe function. Every event subscription returns one, because a
 * renderer that cannot detach a listener leaks one per result tab.
 */
export type Unsubscribe = () => void;

export interface TabbyEvents {
  onQueryProgress(listener: (event: QueryProgressEvent) => void): Unsubscribe;
  onConnectionLost(listener: (connectionId: string) => void): Unsubscribe;
  onResultEvicted(listener: (resultId: string) => void): Unsubscribe;
}

export interface TabbyApi {
  readonly versions: TabbyVersions;
  /** Invoke-style calls. Every one returns `Result<T>`; none throws. */
  readonly db: DatabaseApi;
  /** Main → renderer events. Raw `ipcRenderer` is never exposed. */
  readonly events: TabbyEvents;
}
