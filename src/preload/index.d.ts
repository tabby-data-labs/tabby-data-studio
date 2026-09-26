import type { TabbyApi } from '../shared/renderer-api';

declare global {
  interface Window {
    readonly tabby: TabbyApi;
  }
}

export {};
