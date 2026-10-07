import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ConnSaveRequest } from '@shared/ipc-contract';
import type { ConnectionSummary } from '@shared/domain';
import type { TabbyError } from '@shared/errors';
import { invoke } from '@/data/ipc';

/**
 * Saved connections and which ones are open.
 *
 * Deliberately thin: every method is one IPC call plus a state update, and every
 * failure is stored rather than thrown, because there is no useful place for an
 * unhandled rejection to go in a renderer. The interesting logic — pooling,
 * hardening, teardown — lives in main.
 */
export const useConnectionsStore = defineStore('connections', () => {
  const list = ref<readonly ConnectionSummary[]>([]);
  const activeId = ref<string | null>(null);
  /** Ids main has a live pool for. Tracked here so the UI can show state. */
  const opened = ref<readonly string[]>([]);
  const busy = ref(false);
  const error = ref<TabbyError | null>(null);
  /** Non-null when `settings.json` was corrupt and had to be reset. */
  const loadWarning = ref<string | null>(null);
  const notice = ref<string | null>(null);

  const active = computed(() => list.value.find((c) => c.id === activeId.value) ?? null);
  const hasAny = computed(() => list.value.length > 0);

  function isOpen(connectionId: string): boolean {
    return opened.value.includes(connectionId);
  }

  /**
   * The one-line label for a connection, used by the tree's root and by query
   * history.
   *
   * A function rather than a computed on `active`, because history has to label
   * connections that are no longer selected — and, being denormalised into the
   * stored record, ones that no longer exist.
   */
  function labelFor(connectionId: string): string {
    const summary = list.value.find((candidate) => candidate.id === connectionId);
    return summary === undefined
      ? connectionId
      : `${summary.name} · ${summary.host}:${summary.port}/${summary.database}`;
  }

  function fail(next: TabbyError | null): void {
    error.value = next;
  }

  async function load(): Promise<void> {
    busy.value = true;
    try {
      const result = await invoke(() => window.tabby.db.getSettings(), 'NOT_CONNECTED');
      if (!result.ok) {
        fail(result.error);
        return;
      }
      list.value = result.value.connections;
      loadWarning.value = result.value.loadWarning;
      // A connection that disappeared from settings cannot still be active.
      if (activeId.value !== null && !list.value.some((c) => c.id === activeId.value)) {
        activeId.value = null;
      }
    } finally {
      busy.value = false;
    }
  }

  async function save(request: ConnSaveRequest): Promise<boolean> {
    busy.value = true;
    fail(null);
    try {
      const result = await invoke(() => window.tabby.db.saveConnection(request), 'NOT_CONNECTED');
      if (!result.ok) {
        fail(result.error);
        return false;
      }
      await load();
      activeId.value = result.value.id;
      return true;
    } finally {
      busy.value = false;
    }
  }

  async function remove(connectionId: string): Promise<boolean> {
    busy.value = true;
    fail(null);
    try {
      const result = await invoke(
        () => window.tabby.db.deleteConnection(connectionId),
        'NOT_CONNECTED',
      );
      if (!result.ok) {
        fail(result.error);
        return false;
      }
      opened.value = opened.value.filter((id) => id !== connectionId);
      if (activeId.value === connectionId) activeId.value = null;
      await load();
      return true;
    } finally {
      busy.value = false;
    }
  }

  /** Verifies credentials without leaving a session open. */
  async function test(connectionId: string): Promise<boolean> {
    busy.value = true;
    fail(null);
    notice.value = null;
    try {
      const result = await invoke(
        () => window.tabby.db.testConnection(connectionId),
        'NOT_CONNECTED',
      );
      if (!result.ok) {
        fail(result.error);
        return false;
      }
      notice.value = result.value.serverVersion;
      return true;
    } finally {
      busy.value = false;
    }
  }

  async function open(connectionId: string): Promise<boolean> {
    busy.value = true;
    fail(null);
    try {
      const result = await invoke(
        () => window.tabby.db.openConnection(connectionId),
        'NOT_CONNECTED',
      );
      if (!result.ok) {
        fail(result.error);
        return false;
      }
      opened.value = [...new Set([...opened.value, connectionId])];
      activeId.value = connectionId;
      return true;
    } finally {
      busy.value = false;
    }
  }

  async function close(connectionId: string): Promise<void> {
    busy.value = true;
    try {
      // A failure to close is worth recording but not worth blocking on: the pool
      // is gone either way as far as the user is concerned.
      const result = await invoke(
        () => window.tabby.db.closeConnection(connectionId),
        'NOT_CONNECTED',
      );
      if (!result.ok) fail(result.error);
      opened.value = opened.value.filter((id) => id !== connectionId);
      if (activeId.value === connectionId) activeId.value = null;
    } finally {
      busy.value = false;
    }
  }

  function select(connectionId: string | null): void {
    activeId.value = connectionId;
  }

  return {
    list,
    activeId,
    active,
    hasAny,
    opened,
    busy,
    error,
    notice,
    loadWarning,
    isOpen,
    labelFor,
    load,
    save,
    remove,
    test,
    open,
    close,
    select,
  };
});
