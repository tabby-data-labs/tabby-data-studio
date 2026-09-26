/**
 * The renderer-facing API surface, exposed by the preload via contextBridge.
 *
 * This module is imported by preload (to build the object), by the renderer
 * (to type `window.tabby`), and by tests. It must stay free of runtime imports.
 */

export interface TabbyVersions {
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
}

export interface TabbyApi {
  readonly versions: TabbyVersions;
}
