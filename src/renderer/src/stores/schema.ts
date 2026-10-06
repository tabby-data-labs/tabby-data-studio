import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { SchemaNode, TableDetail } from '@shared/domain';
import type { TabbyError } from '@shared/errors';
import type { Unsubscribe } from '@shared/renderer-api';
import { invoke } from '@/data/ipc';
import {
  childNodeId,
  connectionNodeId,
  filterRows,
  flattenRows,
  type LoadTarget,
  type TreeInput,
  type TreeRoot,
  type TreeRow,
} from '@/schema/tree-model';

/**
 * The schema explorer's state (PLAN Phase 6).
 *
 * The tree model in `@/schema/tree-model` is pure; this is the adapter that feeds
 * it and talks to main. Two decisions shape it:
 *
 * **`shallowRef` over whole snapshots, not `reactive` collections.** A schema with
 * 2,000 relations is read by `flattenRows` eight properties at a time, and a deep
 * reactive proxy would intercept every one of those reads. Replacing the Map on
 * change costs O(parents) — a handful of keys — while the 2,000-node arrays inside
 * it are shared by reference and never proxied at all.
 *
 * **Flatten on content change, window on scroll.** `rows` recomputes when the tree
 * changes; the scroll offset only feeds `virtualWindow`, which is O(1). That split
 * is what lets a 2,000-table schema scroll at the same cost as a 20-table one.
 */
export const useSchemaStore = defineStore('schema', () => {
  const connectionId = ref<string | null>(null);
  const connectionLabel = ref('');

  const children = shallowRef<ReadonlyMap<string, readonly SchemaNode[]>>(new Map());
  const expanded = shallowRef<ReadonlySet<string>>(new Set());
  const loading = shallowRef<ReadonlySet<string>>(new Set());
  const failed = shallowRef<ReadonlySet<string>>(new Set());

  const selectedId = ref<string | null>(null);
  const filter = ref('');
  const error = ref<TabbyError | null>(null);
  const refreshing = ref(false);
  const detail = shallowRef<TableDetail | null>(null);
  const detailLoading = ref(false);
  const detailError = ref<TabbyError | null>(null);
  /** Entries main dropped on the last refresh, so the UI can confirm it happened. */
  const lastRefreshed = ref<number | null>(null);

  /**
   * In-flight loads, keyed by node id. Not reactive: nothing renders it, and it
   * exists only so that two quick clicks on the same caret cannot produce two
   * catalog reads and two competing writes to `children`.
   */
  const inFlight = new Map<string, Promise<void>>();

  let detached: Unsubscribe | null = null;

  const roots = computed<readonly TreeRoot[]>(() =>
    connectionId.value === null
      ? []
      : [
          {
            id: connectionNodeId(connectionId.value),
            connectionId: connectionId.value,
            label: connectionLabel.value,
            expandable: true,
          },
        ],
  );

  const treeInput = computed<TreeInput>(() => ({
    roots: roots.value,
    children: children.value,
    expanded: expanded.value,
    loading: loading.value,
    failed: failed.value,
  }));

  const filtering = computed(() => filter.value.trim() !== '');

  /**
   * The whole loaded tree, flattened.
   *
   * While filtering, every loaded node renders expanded: a match whose ancestors
   * are collapsed is a match the user cannot see, and hunting for the caret that
   * hides it is exactly the friction a filter is supposed to remove.
   */
  const flatRows = computed<readonly TreeRow[]>(() =>
    flattenRows(treeInput.value, { expandAll: filtering.value }),
  );

  /** The rows the tree renders: `flatRows`, pruned while a filter is active. */
  const rows = computed<readonly TreeRow[]>(() =>
    filtering.value ? filterRows(flatRows.value, filter.value) : flatRows.value,
  );

  const selectedRow = computed<TreeRow | null>(
    () => rows.value.find((row) => row.id === selectedId.value) ?? null,
  );

  /**
   * How many schemas have never had their relations read, so a filter cannot have
   * searched them.
   *
   * Counted over the **unfiltered** tree on purpose. Deriving it from `rows` would
   * make the warning vanish at the exact moment it matters most: when the filter
   * matched nothing, which is when the user is about to conclude the table does
   * not exist rather than that it was never looked for.
   */
  const unsearchedSchemas = computed(
    () => flatRows.value.filter((row) => row.kind === 'schema' && row.unloaded).length,
  );

  const filterIsIncomplete = computed(() => filtering.value && unsearchedSchemas.value > 0);

  const isAttached = computed(() => connectionId.value !== null);

  function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
    if (set.has(id)) return set;
    const next = new Set(set);
    next.add(id);
    return next;
  }

  function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
    if (!set.has(id)) return set;
    const next = new Set(set);
    next.delete(id);
    return next;
  }

  function fail(next: TabbyError): void {
    error.value = next;
  }

  /** Points the tree at a connection. Cheap and idempotent while it is unchanged. */
  function attach(id: string, label: string): void {
    if (connectionId.value === id && connectionLabel.value === label) return;
    reset();
    connectionId.value = id;
    connectionLabel.value = label;
    // Expanding the root immediately saves a click: a connection the user has just
    // opened has exactly one thing to show.
    const rootId = connectionNodeId(id);
    expanded.value = new Set([rootId]);
    void ensureLoaded({ id: rootId, kind: 'connection', label, expandable: true });
  }

  function reset(): void {
    inFlight.clear();
    children.value = new Map();
    expanded.value = new Set();
    loading.value = new Set();
    failed.value = new Set();
    selectedId.value = null;
    filter.value = '';
    error.value = null;
    detail.value = null;
    detailError.value = null;
    lastRefreshed.value = null;
    connectionId.value = null;
    connectionLabel.value = '';
  }

  function detach(): void {
    reset();
  }

  /**
   * Fetches a node's children once. Concurrent calls for the same node share one
   * request; a node already in `children` is never re-read (invalidation is
   * explicit, via {@link refresh}).
   */
  function ensureLoaded(target: LoadTarget): Promise<void> {
    if (!target.expandable) return Promise.resolve();
    if (children.value.has(target.id)) return Promise.resolve();
    const pending = inFlight.get(target.id);
    if (pending) return pending;

    const id = connectionId.value;
    if (id === null) return Promise.resolve();

    // The root asks for schemas (parentSchema null); a schema asks for its
    // relations. Nothing else in this tree is expandable.
    const parentSchema = target.kind === 'schema' ? target.label : null;

    const request = (async (): Promise<void> => {
      loading.value = withId(loading.value, target.id);
      failed.value = withoutId(failed.value, target.id);
      try {
        const result = await invoke(
          () => window.tabby.db.schemaChildren({ connectionId: id, parentSchema }),
          'NOT_CONNECTED',
        );
        if (!result.ok) {
          fail(result.error);
          failed.value = withId(failed.value, target.id);
          return;
        }
        const next = new Map(children.value);
        next.set(target.id, result.value);
        children.value = next;
      } finally {
        loading.value = withoutId(loading.value, target.id);
        inFlight.delete(target.id);
      }
    })();

    inFlight.set(target.id, request);
    return request;
  }

  /** Expands or collapses. Expanding a never-loaded node triggers the read. */
  function toggle(row: TreeRow): void {
    if (!row.expandable) return;
    error.value = null;
    if (row.expanded) {
      expanded.value = withoutId(expanded.value, row.id);
      return;
    }
    expanded.value = withId(expanded.value, row.id);
    // Retrying a failed node must be possible: `toggle` clears `failed` through
    // `ensureLoaded`, so a second click is a second attempt rather than a no-op.
    void ensureLoaded(row);
  }

  function select(row: TreeRow | null): void {
    selectedId.value = row?.id ?? null;
    if (row === null) {
      detail.value = null;
      detailError.value = null;
      return;
    }
    if (row.kind === 'table' || row.kind === 'view' || row.kind === 'materializedView') {
      void loadDetail(row);
    } else {
      detail.value = null;
      detailError.value = null;
    }
  }

  /** The pane's payload. Cached per relation by main, so re-selecting is free. */
  async function loadDetail(row: TreeRow): Promise<void> {
    const id = connectionId.value;
    if (id === null || row.schema === '') return;
    detailLoading.value = true;
    detailError.value = null;
    try {
      const result = await invoke(
        () =>
          window.tabby.db.schemaTable({ connectionId: id, schema: row.schema, table: row.label }),
        'NOT_CONNECTED',
      );
      // A slower response for a row the user has already clicked away from must not
      // overwrite the pane. Selection is the authority, not arrival order.
      if (selectedId.value !== row.id) return;
      if (!result.ok) {
        detail.value = null;
        detailError.value = result.error;
        return;
      }
      detail.value = result.value;
    } finally {
      detailLoading.value = false;
    }
  }

  /**
   * Explicit invalidation: drops main's cache and ours, then reloads whatever was
   * open so the user's place in the tree survives.
   *
   * There is no time-based expiry anywhere in this path. A schema tree that changes
   * under the user mid-scroll is worse than one that needs a refresh button, which
   * is why `SchemaService` caches until told otherwise.
   */
  async function refresh(): Promise<void> {
    const id = connectionId.value;
    if (id === null || refreshing.value) return;
    refreshing.value = true;
    error.value = null;
    try {
      const dropped = await invoke(() => window.tabby.db.refreshSchema(id), 'NOT_CONNECTED');
      if (!dropped.ok) {
        fail(dropped.error);
        return;
      }
      lastRefreshed.value = dropped.value;

      // Only the schemas the user actually opened, read from the unfiltered tree
      // and the real `expanded` set. Using `rows` here would reload every schema
      // while a filter is active, because filtering renders them all expanded —
      // turning a refresh into a full catalog read nobody asked for.
      const openBefore = expanded.value;
      const openSchemas = flatRows.value
        .filter((row) => row.kind === 'schema' && openBefore.has(row.id))
        .map((row) => row.label);
      const rootId = connectionNodeId(id);

      inFlight.clear();
      children.value = new Map();
      failed.value = new Set();
      detail.value = null;
      detailError.value = null;

      await ensureLoaded({
        id: rootId,
        kind: 'connection',
        label: connectionLabel.value,
        expandable: true,
      });
      await Promise.all(
        openSchemas.map((schema) =>
          ensureLoaded({
            id: childNodeId(rootId, schema),
            kind: 'schema',
            label: schema,
            expandable: true,
          }),
        ),
      );

      // The selected relation's cached detail is gone on both sides; re-read it so
      // the pane does not show a table that may no longer exist.
      const selected = selectedRow.value;
      if (selected !== null) await loadDetail(selected);
    } finally {
      refreshing.value = false;
    }
  }

  /**
   * A connection that died takes its catalog with it. Main has already dropped its
   * own cache on the close and delete paths; this is the renderer's half.
   */
  function subscribe(): void {
    if (detached !== null || !window.tabby) return;
    detached = window.tabby.events.onConnectionLost((event) => {
      if (event.connectionId !== connectionId.value) return;
      inFlight.clear();
      children.value = new Map();
      failed.value = new Set();
      detail.value = null;
      error.value = {
        code: 'CONN_LOST',
        message: 'the connection was lost; the schema tree is stale',
        connectionId: event.connectionId,
      };
    });
  }

  function unsubscribe(): void {
    detached?.();
    detached = null;
  }

  return {
    connectionId,
    connectionLabel,
    roots,
    rows,
    selectedId,
    selectedRow,
    filter,
    filtering,
    filterIsIncomplete,
    unsearchedSchemas,
    isAttached,
    refreshing,
    lastRefreshed,
    detail,
    detailLoading,
    detailError,
    error,
    attach,
    detach,
    toggle,
    select,
    ensureLoaded,
    loadDetail,
    refresh,
    subscribe,
    unsubscribe,
  };
});
