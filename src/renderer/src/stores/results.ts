import { computed, ref, shallowReactive } from 'vue';
import { defineStore } from 'pinia';
import { RemoteDataSource, type ResultBridge, type SourceState } from '@/data/remote-source';
import { invoke, invokeDetached } from '@/data/ipc';
import type { ResultMeta } from '@shared/domain';
import type { Result, TabbyError } from '@shared/errors';
import type { Unsubscribe } from '@shared/renderer-api';

export interface RunInput {
  readonly connectionId: string;
  readonly sql: string;
  readonly title: string;
  /**
   * Set when `sql` is a plain scan of one table, which lets main page without
   * holding a transaction open. Names only — main picks the key columns.
   */
  readonly browse?: { readonly schema: string; readonly table: string };
  readonly initialRows?: number;
}

export interface ResultTabState {
  readonly meta: ResultMeta;
  readonly source: SourceState;
}

/**
 * Live query results: one `RemoteDataSource` per result, plus the wiring that
 * keeps them honest when main decides something has gone away.
 *
 * The maps are `shallowReactive`, not `ref`: Vue tracks `set`/`delete` on them so
 * the UI updates, while the values stay untouched. Deep-proxying a
 * `RemoteDataSource` would wrap the typed arrays it hands to the grid, which is
 * both slow and a source of identity bugs.
 *
 * Three events from main change what a result means, and all three are handled
 * here rather than in a component so no tab can miss one:
 *  - `result-evicted`  — the registry dropped it (capacity or idle TTL)
 *  - `connection-lost` — every result on that connection is unusable
 *  - `query-progress`  — `done` means the exact row count has replaced the estimate
 */
export const useResultsStore = defineStore('results', () => {
  const sources = shallowReactive(new Map<string, RemoteDataSource>());
  const metas = shallowReactive(new Map<string, ResultMeta>());
  const states = shallowReactive(new Map<string, SourceState>());
  /** resultId → connectionId, so a connection-lost event only hits its own results. */
  const owners = shallowReactive(new Map<string, string>());

  const running = ref(false);
  const runError = ref<TabbyError | null>(null);
  /** Per-result sort failure, kept out of `runError` so it does not look like a new query failed. */
  const sortError = ref<TabbyError | null>(null);

  let detached: Unsubscribe[] = [];

  const ids = computed(() => [...sources.keys()]);
  const count = computed(() => sources.size);

  function bridge(): ResultBridge {
    const db = window.tabby.db;
    // Routed through `invoke` so a missing handler — a version skew, or a harness
    // that boots the renderer without the router — becomes a tagged error the
    // source can back off from, instead of a rejection nobody is awaiting.
    return {
      resultWindow: (req) => invoke(() => db.resultWindow(req), 'NOT_CONNECTED'),
      resultSort: (req) => invoke(() => db.resultSort(req), 'NOT_CONNECTED'),
      resultMeta: (resultId) => invoke(() => db.resultMeta(resultId), 'NOT_CONNECTED'),
    };
  }

  function sourceOf(resultId: string): RemoteDataSource | null {
    return sources.get(resultId) ?? null;
  }

  function stateOf(resultId: string): ResultTabState | null {
    const meta = metas.get(resultId);
    const source = states.get(resultId);
    if (!meta || !source) return null;
    return { meta, source };
  }

  /**
   * Copies the source's live values into the reactive mirror.
   *
   * Called by the app after anything that can change them — a sort (the grid owns
   * the sort path, so the store does not see it) and a metadata refresh.
   */
  function syncMeta(resultId: string): void {
    const source = sources.get(resultId);
    const previous = metas.get(resultId);
    if (!source || !previous) return;
    metas.set(resultId, {
      ...previous,
      columns: source.columns,
      rowCount: source.rowCount,
      rowCountIsEstimate: source.rowCountIsEstimate,
    });
  }

  function attach(resultId: string, connectionId: string, meta: ResultMeta): RemoteDataSource {
    const source = new RemoteDataSource({
      resultId,
      bridge: bridge(),
      meta,
      onStateChange: (state) => states.set(resultId, state),
    });
    sources.set(resultId, source);
    owners.set(resultId, connectionId);
    metas.set(resultId, meta);
    states.set(resultId, source.state);
    return source;
  }

  async function run(input: RunInput): Promise<Result<string>> {
    running.value = true;
    runError.value = null;
    try {
      const result = await invoke(
        () =>
          window.tabby.db.queryRun({
            connectionId: input.connectionId,
            sql: input.sql,
            ...(input.initialRows === undefined ? {} : { initialRows: input.initialRows }),
            ...(input.browse === undefined ? {} : { browse: input.browse }),
          }),
        'NOT_CONNECTED',
      );
      if (!result.ok) {
        runError.value = result.error;
        return result;
      }
      attach(result.value.resultId, input.connectionId, result.value.meta);
      return { ok: true, value: result.value.resultId };
    } finally {
      running.value = false;
    }
  }

  /**
   * Sorting goes through the grid, not through here: `DataGrid.setSort` is what
   * updates the column-header indicator, and it calls `source.sort()` itself. The
   * app catches a rejection and records it in `sortError`, then calls `syncMeta`
   * so the row count follows whatever main returned.
   */

  /** Clears backoff so the grid's next frame re-requests the failed ranges. */
  function retry(resultId: string): void {
    sources.get(resultId)?.retryFailed();
  }

  async function refreshMeta(resultId: string): Promise<void> {
    const source = sources.get(resultId);
    if (!source) return;
    await source.refreshMeta();
    syncMeta(resultId);
  }

  /**
   * Drops the local state and tells main to release the cursor.
   *
   * The dispose call is fire-and-forget on purpose: the tab is already gone from
   * the user's point of view, and a failure to release would be reported by main's
   * own logging rather than by blocking the UI.
   */
  function close(resultId: string): void {
    sources.delete(resultId);
    metas.delete(resultId);
    states.delete(resultId);
    owners.delete(resultId);
    invokeDetached(() => window.tabby.db.resultDispose(resultId), `resultDispose(${resultId})`);
  }

  function subscribe(): void {
    if (detached.length > 0) return;
    const events = window.tabby.events;

    detached.push(
      events.onResultEvicted((event) => {
        // Only this result's source may be told; the event names one resultId.
        sources.get(event.resultId)?.markEvicted(event.reason, event.resultId);
      }),
      events.onConnectionLost((event) => {
        for (const [resultId, connectionId] of owners) {
          if (connectionId === event.connectionId) {
            sources.get(resultId)?.markConnectionLost();
          }
        }
      }),
      events.onQueryProgress((event) => {
        // `done` is emitted when the background count(*) lands.
        if (event.phase === 'done') void refreshMeta(event.resultId);
      }),
    );
  }

  function unsubscribe(): void {
    for (const detach of detached) detach();
    detached = [];
  }

  return {
    sources,
    metas,
    states,
    ids,
    count,
    running,
    runError,
    sortError,
    sourceOf,
    stateOf,
    syncMeta,
    run,
    retry,
    refreshMeta,
    close,
    subscribe,
    unsubscribe,
  };
});
