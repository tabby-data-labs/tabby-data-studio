import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  HISTORY_LIMITS,
  collapseSql,
  type HistoryEntry,
  type HistoryStatus,
} from '@shared/history';
import type { TabbyError } from '@shared/errors';
import { invoke } from '@/data/ipc';

/** What the editor tells history about one run. */
export interface RecordInput {
  readonly sql: string;
  readonly connectionId: string;
  readonly connectionLabel: string;
  readonly status: HistoryStatus;
  readonly elapsedMs: number;
  readonly rowCount: number;
}

/**
 * Query history (PLAN Phase 7).
 *
 * Two decisions shape this store:
 *
 *  - **Recording never blocks or fails a run.** `record` is awaited only so the
 *    returned entry — with main's id and timestamp — can be prepended without a
 *    full re-read, but its failure is stored in `error` and never rethrown. The
 *    query the user asked for already happened; a full disk is not allowed to
 *    rewrite that outcome.
 *  - **The list is updated in place, not re-read.** A refresh would parse up to
 *    3 MiB of JSONL on every Run click. `record`, `remove` and `clear` each apply
 *    their own delta, and `refresh` is for opening the panel and for recovering
 *    after an error.
 *
 * `warning` comes from main and is the only channel a failed write has to reach
 * the user, which is why the panel shows it rather than the store swallowing it.
 */
export const useHistoryStore = defineStore('history', () => {
  const entries = ref<readonly HistoryEntry[]>([]);
  const skipped = ref(0);
  const warning = ref<string | null>(null);
  const error = ref<TabbyError | null>(null);
  const loading = ref(false);
  /** Panel visibility. UI state, but it belongs with the data it shows. */
  const open = ref(false);
  const query = ref('');

  /** True once the panel has pulled the log at least once this session. */
  const loaded = ref(false);

  const count = computed(() => entries.value.length);
  const isEmpty = computed(() => entries.value.length === 0);

  /**
   * The visible rows.
   *
   * Matching on the collapsed statement and the connection label, so a search for
   * `fixtures.big` finds the query regardless of how it was indented, and a search
   * for a connection name finds everything run against it. Case-insensitive: this
   * is a substring search over text the user wrote, not a SQL identifier lookup.
   */
  const filtered = computed<readonly HistoryEntry[]>(() => {
    const needle = query.value.trim().toLowerCase();
    if (needle === '') return entries.value;
    return entries.value.filter((entry) => {
      const haystack = `${collapseSql(entry.sql)} ${entry.connectionLabel}`.toLowerCase();
      return haystack.includes(needle);
    });
  });

  function cap(list: readonly HistoryEntry[]): readonly HistoryEntry[] {
    return list.length > HISTORY_LIMITS.maxEntriesReturned
      ? list.slice(0, HISTORY_LIMITS.maxEntriesReturned)
      : list;
  }

  /** Reads the log from main. Safe to call repeatedly; the panel calls it on open. */
  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      const result = await invoke(() => window.tabby.db.historyList(), 'NOT_CONNECTED');
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      entries.value = result.value.entries;
      skipped.value = result.value.skipped;
      warning.value = result.value.warning;
      error.value = null;
      loaded.value = true;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Appends one run to the log and to the head of the list.
   *
   * Returns whether it was stored, so a caller that wants to say "history is full"
   * can — but no caller should treat `false` as a failure of the query itself.
   */
  async function record(input: RecordInput): Promise<boolean> {
    const result = await invoke(
      () =>
        window.tabby.db.historyAdd({
          sql: input.sql,
          connectionId: input.connectionId,
          connectionLabel: input.connectionLabel,
          status: input.status,
          elapsedMs: input.elapsedMs,
          rowCount: input.rowCount,
        }),
      'NOT_CONNECTED',
    );
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    error.value = null;
    entries.value = cap([result.value, ...entries.value]);
    return true;
  }

  async function remove(historyId: string): Promise<boolean> {
    const result = await invoke(() => window.tabby.db.historyDelete(historyId), 'NOT_CONNECTED');
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    error.value = null;
    entries.value = entries.value.filter((entry) => entry.id !== historyId);
    return true;
  }

  /**
   * The privacy action PLAN asks for. Returns the number of records main removed,
   * or `null` if it could not — the count is what makes the action confirmable.
   */
  async function clear(): Promise<number | null> {
    const result = await invoke(() => window.tabby.db.historyClear(), 'NOT_CONNECTED');
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    entries.value = [];
    skipped.value = 0;
    warning.value = null;
    error.value = null;
    return result.value;
  }

  function show(): void {
    open.value = true;
    // Reset the filter on open. Keeping it would reopen the panel narrowed to
    // whatever was typed last time, and a history panel that silently hides most
    // of the log reads exactly like "my history is gone".
    query.value = '';
    // Pulled on open rather than at startup: the log can be megabytes, and a user
    // who never opens the panel should never pay for reading it.
    //
    // `loading` is checked as well as `loaded`, because `loaded` only becomes true
    // once the read resolves — opening the panel twice in quick succession would
    // otherwise fire two reads of the same file. `refresh` sets it synchronously
    // before its first await, so this guard holds from the moment `show` returns.
    if (loaded.value || loading.value) return;
    void refresh();
  }

  function hide(): void {
    open.value = false;
  }

  function toggle(): void {
    if (open.value) hide();
    else show();
  }

  function search(text: string): void {
    query.value = text;
  }

  return {
    entries,
    filtered,
    skipped,
    warning,
    error,
    loading,
    loaded,
    open,
    query,
    count,
    isEmpty,
    refresh,
    record,
    remove,
    clear,
    show,
    hide,
    toggle,
    search,
  };
});
