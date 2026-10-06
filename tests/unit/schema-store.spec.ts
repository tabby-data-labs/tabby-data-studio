/**
 * The schema store (PLAN Phase 6).
 *
 * Tier 2 under AGENTS.md — it is an adapter over the IPC bridge — so it is written
 * after the implementation, like `results-store.spec.ts`. The pure tree logic it
 * feeds is tested test-first in `schema-tree-model.spec.ts`; what is worth testing
 * here is the async behaviour around it, because each of these is a way the pane
 * can quietly show the wrong thing:
 *
 *  - a caret clicked twice must produce **one** catalog read, not two racing writes
 *    to `children` where whichever lands last wins;
 *  - a slow detail response for a row the user already clicked away from must not
 *    overwrite the pane;
 *  - a failed load must leave the node retryable rather than permanently blank;
 *  - a refresh must reload the schemas that were open, so the user keeps their place;
 *  - a `connection-lost` event for another connection must not clear this one.
 *
 * `window.tabby` is stubbed rather than mocked at module level, so the store's own
 * code path — reading the bridge off `window` — is what runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { SchemaNode, TableDetail } from '@shared/domain';
import type { Result, TabbyErrorCode } from '@shared/errors';
import type { ConnectionLostEvent } from '@shared/ipc-contract';
import { useSchemaStore } from '@/stores/schema';
import { childNodeId, connectionNodeId } from '@/schema/tree-model';

function node(overrides: Partial<SchemaNode> = {}): SchemaNode {
  return {
    kind: 'table',
    name: 'big',
    schema: 'fixtures',
    oid: 1,
    comment: null,
    rowEstimate: -1,
    hasChildren: false,
    ...overrides,
  };
}

function schemaNode(name: string): SchemaNode {
  return node({ kind: 'schema', name, schema: name, oid: 2, hasChildren: true });
}

function detail(name: string): TableDetail {
  return {
    meta: {
      schema: 'fixtures',
      name,
      columns: [],
      primaryKey: [],
      uniqueIndexes: [],
      comment: null,
      rowEstimate: -1,
    },
    kind: 'table',
    indexes: [],
    constraints: [],
    ddl: [],
  };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failure<T>(code: TabbyErrorCode, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

/** `null` is the key for the root's schemas; a string keys one schema's relations. */
type ChildrenByKey = Record<string, Result<readonly SchemaNode[]>>;

interface Stub {
  readonly childrenCalls: { connectionId: string; parentSchema: string | null }[];
  readonly detailCalls: { connectionId: string; schema: string; table: string }[];
  readonly refreshCalls: string[];
  readonly lostListeners: ((event: ConnectionLostEvent) => void)[];
  children: ChildrenByKey;
  detailResult: Result<TableDetail>;
  refreshResult: Result<number>;
  /** While true, `schemaChildren` parks until the test calls `releaseChildren`. */
  holdChildren: boolean;
  releaseChildren: ((value: Result<readonly SchemaNode[]>) => void) | null;
  unsubscribes: number;
}

const ROOT_KEY = 'null';

function stubApi(): Stub {
  const stub: Stub = {
    childrenCalls: [],
    detailCalls: [],
    refreshCalls: [],
    lostListeners: [],
    children: {
      [ROOT_KEY]: ok([schemaNode('fixtures'), schemaNode('public')]),
      fixtures: ok([node({ name: 'big' }), node({ name: 'wide' })]),
      public: ok([node({ name: 'plain_table', schema: 'public' })]),
    },
    detailResult: ok(detail('big')),
    refreshResult: ok(3),
    holdChildren: false,
    releaseChildren: null,
    unsubscribes: 0,
  };

  const tabby = {
    versions: { electron: '0', chrome: '0', node: '0' },
    db: {
      schemaChildren: (req: { connectionId: string; parentSchema: string | null }) => {
        stub.childrenCalls.push(req);
        const value = stub.children[req.parentSchema ?? ROOT_KEY] ?? ok([]);
        if (stub.holdChildren) {
          return new Promise<Result<readonly SchemaNode[]>>((resolve) => {
            stub.releaseChildren = resolve;
          });
        }
        return Promise.resolve(value);
      },
      schemaTable: (req: { connectionId: string; schema: string; table: string }) => {
        stub.detailCalls.push(req);
        return Promise.resolve(stub.detailResult);
      },
      refreshSchema: (connectionId: string) => {
        stub.refreshCalls.push(connectionId);
        return Promise.resolve(stub.refreshResult);
      },
    },
    events: {
      onConnectionLost: (listener: (event: ConnectionLostEvent) => void) => {
        stub.lostListeners.push(listener);
        return () => {
          stub.unsubscribes += 1;
        };
      },
      onResultEvicted: () => () => undefined,
      onQueryProgress: () => () => undefined,
    },
  };

  vi.stubGlobal('window', { tabby });
  return stub;
}

let stub: Stub;

/** Lets queued microtasks and one macrotask drain, for the async store actions. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const CONN = 'conn-1';
const LABEL = 'local · localhost:5432/tabby';
const ROOT = connectionNodeId(CONN);
const FIXTURES = childNodeId(ROOT, 'fixtures');
const PUBLIC = childNodeId(ROOT, 'public');

beforeEach(() => {
  setActivePinia(createPinia());
  stub = stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Attaches, waits for the root load, and returns the store. */
async function attached() {
  const schema = useSchemaStore();
  schema.attach(CONN, LABEL);
  await flush();
  return schema;
}

function rowOf(schema: ReturnType<typeof useSchemaStore>, id: string) {
  const row = schema.rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no row with id ${JSON.stringify(id)}`);
  return row;
}

/** Attaches and expands `fixtures`, so relation rows exist. */
async function withTables() {
  const schema = await attached();
  schema.toggle(rowOf(schema, FIXTURES));
  await flush();
  return schema;
}

describe('attach', () => {
  it('builds one root, expands it and reads the schemas with a null parent', async () => {
    const schema = await attached();
    expect(schema.isAttached).toBe(true);
    expect(schema.rows.map((row) => row.label)).toEqual([LABEL, 'fixtures', 'public']);
    expect(stub.childrenCalls).toEqual([{ connectionId: CONN, parentSchema: null }]);
    expect(schema.rows[0]).toMatchObject({ depth: 0, kind: 'connection', expanded: true });
  });

  it('is idempotent for the same connection, so a re-render cannot re-read the catalog', async () => {
    const schema = await attached();
    schema.attach(CONN, LABEL);
    await flush();
    expect(stub.childrenCalls).toHaveLength(1);
    expect(schema.rows).toHaveLength(3);
  });

  it('resets when pointed at a different connection', async () => {
    const schema = await attached();
    stub.children = { [ROOT_KEY]: ok([schemaNode('other')]) };
    schema.attach('conn-2', 'second');
    await flush();
    expect(schema.rows.map((row) => row.label)).toEqual(['second', 'other']);
    expect(stub.childrenCalls[1]).toEqual({ connectionId: 'conn-2', parentSchema: null });
  });

  it('does nothing when detached', async () => {
    const schema = useSchemaStore();
    expect(schema.isAttached).toBe(false);
    expect(schema.rows).toEqual([]);
    await schema.refresh();
    expect(stub.refreshCalls).toEqual([]);
  });
});

describe('toggle and lazy loading', () => {
  it('reads a schema by name when it is first expanded', async () => {
    const schema = await attached();
    expect(rowOf(schema, FIXTURES).unloaded).toBe(true);

    schema.toggle(rowOf(schema, FIXTURES));
    await flush();

    expect(stub.childrenCalls).toEqual([
      { connectionId: CONN, parentSchema: null },
      { connectionId: CONN, parentSchema: 'fixtures' },
    ]);
    expect(schema.rows.map((row) => row.label)).toEqual([
      LABEL,
      'fixtures',
      'big',
      'wide',
      'public',
    ]);
  });

  it('never re-reads a node whose children are already loaded', async () => {
    const schema = await withTables();
    const callsBefore = stub.childrenCalls.length;

    schema.toggle(rowOf(schema, FIXTURES)); // collapse
    await flush();
    schema.toggle(rowOf(schema, FIXTURES)); // expand again
    await flush();

    expect(stub.childrenCalls).toHaveLength(callsBefore);
    expect(schema.rows.map((row) => row.label)).toContain('big');
  });

  it('collapses without touching the network', async () => {
    const schema = await withTables();
    const callsBefore = stub.childrenCalls.length;

    schema.toggle(rowOf(schema, FIXTURES));
    await flush();
    expect(schema.rows.map((row) => row.label)).toEqual([LABEL, 'fixtures', 'public']);
    expect(stub.childrenCalls).toHaveLength(callsBefore);
  });

  it('dedupes concurrent loads of the same node into one request', async () => {
    // The failure this prevents: two clicks in flight, two responses, two writes to
    // `children`, and whichever lands last wins — so a slow first response can
    // replace a fresh second one.
    const schema = await attached();
    const row = rowOf(schema, FIXTURES);

    stub.holdChildren = true;
    const first = schema.ensureLoaded(row);
    const second = schema.ensureLoaded(row);

    await flush();
    // The dedupe is observable where it matters: only one request reached the
    // bridge. Promise *identity* is not assertable here, because Pinia wraps
    // setup-store actions and hands back the wrapper's promise, not `inFlight`'s.
    expect(stub.childrenCalls.filter((call) => call.parentSchema === 'fixtures')).toHaveLength(1);
    expect(rowOf(schema, FIXTURES).loading).toBe(true);

    stub.holdChildren = false;
    stub.releaseChildren?.(ok([node({ name: 'big' })]));
    await Promise.all([first, second]);
    await flush();

    expect(rowOf(schema, FIXTURES)).toMatchObject({ loading: false, childCount: 1, failed: false });
  });

  it('records a failure on the node and leaves it retryable', async () => {
    const schema = await attached();
    stub.children['fixtures'] = failure('CONN_LOST', 'server closed the connection');

    schema.toggle(rowOf(schema, FIXTURES));
    await flush();

    expect(rowOf(schema, FIXTURES)).toMatchObject({ failed: true, loading: false, childCount: -1 });
    expect(schema.error?.code).toBe('CONN_LOST');

    stub.children['fixtures'] = ok([node({ name: 'big' })]);
    schema.toggle(rowOf(schema, FIXTURES)); // collapse
    schema.toggle(rowOf(schema, FIXTURES)); // retry
    await flush();

    expect(rowOf(schema, FIXTURES)).toMatchObject({ failed: false, childCount: 1 });
    expect(schema.error).toBeNull();
  });

  it('ignores a toggle of a leaf', async () => {
    const schema = await withTables();
    const callsBefore = stub.childrenCalls.length;
    const big = schema.rows.find((row) => row.label === 'big')!;
    expect(big.expandable).toBe(false);

    schema.toggle(big);
    await flush();
    expect(stub.childrenCalls).toHaveLength(callsBefore);
  });
});

describe('selection and the detail pane', () => {
  it('loads the detail for a relation and clears it for a schema', async () => {
    const schema = await withTables();
    const big = schema.rows.find((row) => row.label === 'big')!;

    schema.select(big);
    await flush();
    expect(stub.detailCalls).toEqual([{ connectionId: CONN, schema: 'fixtures', table: 'big' }]);
    expect(schema.detail?.meta.name).toBe('big');
    expect(schema.selectedRow?.label).toBe('big');

    schema.select(rowOf(schema, FIXTURES));
    await flush();
    expect(schema.detail).toBeNull();
    expect(stub.detailCalls).toHaveLength(1);

    schema.select(null);
    expect(schema.selectedId).toBeNull();
    expect(schema.selectedRow).toBeNull();
  });

  it('does not let a late response overwrite a pane the user has moved on from', async () => {
    // Arrival order is not selection order. Without this guard, clicking `big` then
    // `wide` before the first response lands would show wide's columns with big's
    // DDL — a wrong answer that looks like a right one.
    const schema = await withTables();
    const big = schema.rows.find((row) => row.label === 'big')!;
    const wide = schema.rows.find((row) => row.label === 'wide')!;

    stub.detailResult = ok(detail('big'));
    const slow = schema.loadDetail(big);

    schema.selectedId = wide.id;
    stub.detailResult = ok(detail('wide'));
    await schema.loadDetail(wide);
    await slow;
    await flush();

    expect(schema.detail?.meta.name).toBe('wide');
  });

  it('records a detail failure separately from a tree failure', async () => {
    const schema = await withTables();
    const big = schema.rows.find((row) => row.label === 'big')!;
    stub.detailResult = failure('PERMISSION_DENIED', 'permission denied for table big');

    schema.select(big);
    await flush();

    expect(schema.detail).toBeNull();
    expect(schema.detailError?.code).toBe('PERMISSION_DENIED');
    // The tree itself is fine; conflating the two would blank the whole sidebar.
    expect(schema.error).toBeNull();
    expect(schema.rows.length).toBeGreaterThan(0);
  });
});

describe('filter', () => {
  it('prunes to matches and their ancestors, expanding loaded nodes to reach them', async () => {
    const schema = await withTables();
    schema.filter = 'wide';
    expect(schema.filtering).toBe(true);
    expect(schema.rows.map((row) => row.label)).toEqual([LABEL, 'fixtures', 'wide']);
    // expandAll is what makes the match reachable without hunting for the caret.
    expect(schema.rows.every((row) => !row.expandable || row.expanded)).toBe(true);
  });

  it('clearing the filter restores the tree without a reload', async () => {
    const schema = await withTables();
    const callsBefore = stub.childrenCalls.length;
    schema.filter = 'wide';
    schema.filter = '';
    await flush();
    expect(schema.filtering).toBe(false);
    expect(schema.rows.map((row) => row.label)).toEqual([
      LABEL,
      'fixtures',
      'big',
      'wide',
      'public',
    ]);
    expect(stub.childrenCalls).toHaveLength(callsBefore);
  });

  it('counts the schemas a filter cannot have searched, even when it matched nothing', async () => {
    // The count comes from the unfiltered tree. Deriving it from the filtered rows
    // would make the warning disappear exactly when the filter returns nothing —
    // the one moment the user needs to be told the search was partial.
    const schema = await attached();
    schema.filter = 'big';
    expect(schema.rows).toEqual([]);
    expect(schema.unsearchedSchemas).toBe(2);
    expect(schema.filterIsIncomplete).toBe(true);

    // Expanding is done with the filter off: while filtering, `rows` holds only
    // matches, so the node to toggle is not in it.
    schema.filter = '';
    schema.toggle(rowOf(schema, FIXTURES));
    await flush();
    schema.filter = 'big';
    expect(schema.rows.map((row) => row.label)).toEqual([LABEL, 'fixtures', 'big']);
    expect(schema.unsearchedSchemas).toBe(1);
    expect(schema.filterIsIncomplete).toBe(true);

    schema.filter = '';
    schema.toggle(rowOf(schema, PUBLIC));
    await flush();
    schema.filter = 'big';
    expect(schema.unsearchedSchemas).toBe(0);
    expect(schema.filterIsIncomplete).toBe(false);
  });

  it('reports no incompleteness when nothing is being filtered', async () => {
    const schema = await attached();
    expect(schema.unsearchedSchemas).toBe(2);
    expect(schema.filterIsIncomplete).toBe(false);
  });
});

describe('refresh', () => {
  it("drops main's cache and ours, then reloads the schemas that were open", async () => {
    const schema = await withTables();
    stub.childrenCalls.length = 0;

    await schema.refresh();
    await flush();

    expect(stub.refreshCalls).toEqual([CONN]);
    expect(schema.lastRefreshed).toBe(3);
    // Root first, then exactly the schema that was expanded — the user's place in
    // the tree survives, which is the difference between a refresh and a reset.
    expect(stub.childrenCalls).toEqual([
      { connectionId: CONN, parentSchema: null },
      { connectionId: CONN, parentSchema: 'fixtures' },
    ]);
    expect(schema.rows.map((row) => row.label)).toEqual([
      LABEL,
      'fixtures',
      'big',
      'wide',
      'public',
    ]);
  });

  it("re-reads the selected relation's detail, since its cache is gone too", async () => {
    const schema = await withTables();
    schema.select(schema.rows.find((row) => row.label === 'big')!);
    await flush();
    expect(stub.detailCalls).toHaveLength(1);

    await schema.refresh();
    await flush();
    expect(stub.detailCalls).toHaveLength(2);
    expect(schema.detail?.meta.name).toBe('big');
  });

  it('is not re-entrant, so a double click cannot interleave two invalidations', async () => {
    const schema = await attached();
    await Promise.all([schema.refresh(), schema.refresh()]);
    expect(stub.refreshCalls).toEqual([CONN]);
  });

  it('records a failed invalidation rather than leaving a half-cleared tree', async () => {
    const schema = await attached();
    stub.refreshResult = failure('CONN_LOST', 'server closed the connection');

    await schema.refresh();

    expect(schema.error?.code).toBe('CONN_LOST');
    // The tree is untouched: main never dropped its cache, so clearing ours would
    // have made the two disagree about what exists.
    expect(schema.rows).toHaveLength(3);
  });
});

describe('detach and connection-lost', () => {
  it('clears everything on detach', async () => {
    const schema = await attached();
    schema.detach();
    expect(schema.isAttached).toBe(false);
    expect(schema.rows).toEqual([]);
    expect(schema.selectedId).toBeNull();
    expect(schema.detail).toBeNull();
  });

  it('clears the catalog when its own connection is lost', async () => {
    const schema = await attached();
    schema.subscribe();
    expect(stub.lostListeners).toHaveLength(1);

    stub.lostListeners[0]!({ connectionId: CONN });
    await flush();

    expect(schema.error?.code).toBe('CONN_LOST');
    // The root stays — the connection is still the selected one — but its catalog
    // is gone, so the pane cannot show rows from a server that is no longer there.
    expect(schema.rows).toHaveLength(1);
    expect(schema.detail).toBeNull();
  });

  it('ignores a connection-lost event for some other connection', async () => {
    const schema = await attached();
    schema.subscribe();
    stub.lostListeners[0]!({ connectionId: 'someone-else' });
    await flush();

    expect(schema.error).toBeNull();
    expect(schema.rows).toHaveLength(3);
  });

  it('subscribes once and unsubscribes cleanly', async () => {
    const schema = await attached();
    schema.subscribe();
    schema.subscribe();
    expect(stub.lostListeners).toHaveLength(1);

    schema.unsubscribe();
    expect(stub.unsubscribes).toBe(1);
    schema.unsubscribe();
    expect(stub.unsubscribes).toBe(1);
  });
});

describe('without a preload', () => {
  it('survives a missing bridge instead of throwing into a render', async () => {
    // The smoke harness boots the renderer with no router registered, and both
    // harnesses treat an uncaught rejection as a failure.
    vi.stubGlobal('window', {});
    setActivePinia(createPinia());
    const schema = useSchemaStore();
    schema.attach(CONN, LABEL);
    await flush();

    expect(schema.error?.code).toBe('NOT_CONNECTED');
    expect(schema.rows).toHaveLength(1);
    expect(schema.rows[0]).toMatchObject({ failed: true, childCount: -1 });
    schema.subscribe();
    schema.unsubscribe();
  });
});
