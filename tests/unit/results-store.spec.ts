/**
 * The results store (PLAN Phase 5).
 *
 * Tier 2 under AGENTS.md — it is an adapter over the IPC bridge — so it is written
 * after the implementation rather than before. What is worth testing is not the
 * plumbing but the three event paths, because each one silently corrupts the UI if
 * it is wrong:
 *
 *  - an eviction notice for result A must not kill result B;
 *  - a connection-lost notice must kill **every** result on that connection and no
 *    result on any other;
 *  - a `done` progress event must replace the `reltuples` estimate with the exact
 *    count, which is the only way the scrollbar ever stops lying.
 *
 * `window.tabby` is stubbed rather than mocked at module level, so the store's own
 * code path — reading the bridge off `window` — is what runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { encodeBlock } from '@shared/columnar';
import type { ColumnMeta, EncodedRowBlock, ResultMeta } from '@shared/domain';
import type { Result } from '@shared/errors';
import type {
  ConnectionLostEvent,
  QueryProgressEvent,
  ResultEvictedEvent,
} from '@shared/ipc-contract';
import { useResultsStore } from '@/stores/results';

const COLUMNS: ColumnMeta[] = [
  { name: 'id', typeName: 'int8', typeOid: 20, nullable: false, widthHint: 90 },
  { name: 'label', typeName: 'text', typeOid: 25, nullable: true, widthHint: 170 },
];

function meta(overrides: Partial<ResultMeta> = {}): ResultMeta {
  return {
    resultId: 'res-1',
    columns: COLUMNS,
    rowCount: 1_000,
    rowCountIsEstimate: false,
    elapsedMs: 8,
    ...overrides,
  };
}

function encoded(startRow: number, rowCount: number): EncodedRowBlock {
  const rows: (readonly unknown[])[] = Array.from({ length: rowCount }, (_, i) => [
    String(startRow + i + 1),
    `row-${startRow + i}`,
  ]);
  return encodeBlock(rows, COLUMNS, startRow);
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

interface Stub {
  readonly runCalls: unknown[];
  readonly windowCalls: unknown[];
  readonly disposeCalls: string[];
  readonly metaCalls: string[];
  runResult: Result<{ resultId: string; meta: ResultMeta }>;
  /** Null means "echo the request", which is what the real service does. */
  windowFailure: Result<EncodedRowBlock> | null;
  metaResult: Result<ResultMeta>;
  listeners: {
    evicted: ((event: ResultEvictedEvent) => void)[];
    lost: ((event: ConnectionLostEvent) => void)[];
    progress: ((event: QueryProgressEvent) => void)[];
  };
  unsubscribes: number;
}

function stubApi(): Stub {
  const stub: Stub = {
    runCalls: [],
    windowCalls: [],
    disposeCalls: [],
    metaCalls: [],
    runResult: ok({ resultId: 'res-1', meta: meta() }),
    windowFailure: null,
    metaResult: ok(meta()),
    listeners: { evicted: [], lost: [], progress: [] },
    unsubscribes: 0,
  };

  const tabby = {
    versions: { electron: '0', chrome: '0', node: '0' },
    db: {
      queryRun: (req: unknown) => {
        stub.runCalls.push(req);
        return Promise.resolve(stub.runResult);
      },
      resultWindow: (req: unknown) => {
        stub.windowCalls.push(req);
        const { startRow, rowCount } = req as { startRow: number; rowCount: number };
        return Promise.resolve(stub.windowFailure ?? ok(encoded(startRow, rowCount)));
      },
      resultSort: () => Promise.resolve(ok(meta())),
      resultMeta: (resultId: string) => {
        stub.metaCalls.push(resultId);
        return Promise.resolve(stub.metaResult);
      },
      resultDispose: (resultId: string) => {
        stub.disposeCalls.push(resultId);
        return Promise.resolve(ok(undefined));
      },
    },
    events: {
      onResultEvicted: (listener: (event: ResultEvictedEvent) => void) => {
        stub.listeners.evicted.push(listener);
        return () => {
          stub.unsubscribes += 1;
        };
      },
      onConnectionLost: (listener: (event: ConnectionLostEvent) => void) => {
        stub.listeners.lost.push(listener);
        return () => {
          stub.unsubscribes += 1;
        };
      },
      onQueryProgress: (listener: (event: QueryProgressEvent) => void) => {
        stub.listeners.progress.push(listener);
        return () => {
          stub.unsubscribes += 1;
        };
      },
    },
  };

  vi.stubGlobal('window', { tabby });
  return stub;
}

let stub: Stub;

/** Lets queued microtasks and one macrotask drain, for the async event handlers. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  stub = stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Runs a query through the store and returns its result id. */
async function runOne(resultId: string, connectionId = 'conn-1'): Promise<string> {
  stub.runResult = ok({ resultId, meta: meta({ resultId }) });
  const outcome = await useResultsStore().run({
    connectionId,
    sql: `select * from t /* ${resultId} */`,
    title: resultId,
  });
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.value;
}

describe('run', () => {
  it('registers a source, its metadata and its owning connection', async () => {
    const results = useResultsStore();
    const id = await runOne('res-1');

    expect(id).toBe('res-1');
    expect(results.ids).toEqual(['res-1']);
    expect(results.count).toBe(1);
    expect(results.sourceOf('res-1')).not.toBeNull();
    expect(results.stateOf('res-1')?.meta.rowCount).toBe(1_000);
    expect(results.stateOf('res-1')?.source.terminal).toBeNull();
  });

  it('forwards the browse target only when one was given', async () => {
    const results = useResultsStore();
    await results.run({ connectionId: 'c1', sql: 'select 1', title: 't' });
    expect(stub.runCalls[0]).toEqual({ connectionId: 'c1', sql: 'select 1' });

    await results.run({
      connectionId: 'c1',
      sql: 'select * from s.t',
      title: 't',
      browse: { schema: 's', table: 't' },
      initialRows: 500,
    });
    expect(stub.runCalls[1]).toEqual({
      connectionId: 'c1',
      sql: 'select * from s.t',
      browse: { schema: 's', table: 't' },
      initialRows: 500,
    });
  });

  it('records the error and registers nothing when the query fails', async () => {
    const results = useResultsStore();
    stub.runResult = {
      ok: false,
      error: { code: 'RELATION_NOT_FOUND', message: 'no such table' },
    };
    const outcome = await results.run({ connectionId: 'c1', sql: 'select 1', title: 't' });

    expect(outcome.ok).toBe(false);
    expect(results.count).toBe(0);
    expect(results.runError?.code).toBe('RELATION_NOT_FOUND');
    expect(results.running).toBe(false);
  });

  it('clears a previous run error on the next attempt', async () => {
    const results = useResultsStore();
    stub.runResult = { ok: false, error: { code: 'CONN_LOST', message: 'gone' } };
    await results.run({ connectionId: 'c1', sql: 'select 1', title: 't' });
    expect(results.runError).not.toBeNull();

    await runOne('res-9');
    expect(results.runError).toBeNull();
  });
});

describe('close', () => {
  it('drops every trace and tells main to release the cursor', async () => {
    const results = useResultsStore();
    await runOne('res-1');
    results.close('res-1');

    expect(results.count).toBe(0);
    expect(results.sourceOf('res-1')).toBeNull();
    expect(results.stateOf('res-1')).toBeNull();
    expect(stub.disposeCalls).toEqual(['res-1']);
  });

  it('ignores an unknown result id', () => {
    const results = useResultsStore();
    expect(() => results.close('nope')).not.toThrow();
    expect(stub.disposeCalls).toEqual(['nope']);
  });
});

describe('the grid reads through the source', () => {
  it('fetches a block over the bridge and decodes it', async () => {
    const results = useResultsStore();
    await runOne('res-1');
    const source = results.sourceOf('res-1');
    expect(source).not.toBeNull();

    const block = await source!.getBlock(0, 3, new AbortController().signal);
    expect(stub.windowCalls).toEqual([{ resultId: 'res-1', startRow: 0, rowCount: 3 }]);
    expect(block.rowCount).toBe(3);
    expect(block.columns[0]![0]).toMatchObject({ kind: 'number', raw: '1' });
  });

  it('mirrors the source row count into reactive state after syncMeta', async () => {
    const results = useResultsStore();
    await runOne('res-1');
    stub.metaResult = ok(meta({ rowCount: 10_000_000, rowCountIsEstimate: false }));

    await results.refreshMeta('res-1');
    expect(results.stateOf('res-1')?.meta.rowCount).toBe(10_000_000);
    expect(stub.metaCalls).toEqual(['res-1']);
  });

  it('retryFailed lets a backed-off range be requested again', async () => {
    const results = useResultsStore();
    await runOne('res-1');
    const source = results.sourceOf('res-1')!;

    stub.windowFailure = { ok: false, error: { code: 'QUERY_TIMEOUT', message: 'slow' } };
    await expect(source.getBlock(0, 200, new AbortController().signal)).rejects.toThrow();
    expect(results.stateOf('res-1')?.source.failedRanges).toBe(1);

    // Immediately retrying is refused by backoff — that is the point of it.
    stub.windowFailure = null;
    await expect(source.getBlock(0, 200, new AbortController().signal)).rejects.toThrow();
    const callsBeforeRetry = stub.windowCalls.length;

    results.retry('res-1');
    await source.getBlock(0, 200, new AbortController().signal);
    expect(stub.windowCalls.length).toBe(callsBeforeRetry + 1);
    expect(results.stateOf('res-1')?.source.failedRanges).toBe(0);
  });
});

describe('event wiring', () => {
  it('subscribe registers one listener per event and is idempotent', () => {
    const results = useResultsStore();
    results.subscribe();
    results.subscribe();
    expect(stub.listeners.evicted).toHaveLength(1);
    expect(stub.listeners.lost).toHaveLength(1);
    expect(stub.listeners.progress).toHaveLength(1);
  });

  it('unsubscribe detaches all three', () => {
    const results = useResultsStore();
    results.subscribe();
    results.unsubscribe();
    expect(stub.unsubscribes).toBe(3);
  });

  it('an eviction notice kills only the result it names', async () => {
    const results = useResultsStore();
    results.subscribe();
    await runOne('res-1');
    await runOne('res-2');

    stub.listeners.evicted[0]!({ resultId: 'res-1', reason: 'capacity' });

    expect(results.stateOf('res-1')?.source.terminal).toBe('evicted');
    expect(results.stateOf('res-2')?.source.terminal).toBeNull();
  });

  it('an eviction for an unknown result is ignored rather than throwing', async () => {
    const results = useResultsStore();
    results.subscribe();
    expect(() =>
      stub.listeners.evicted[0]!({ resultId: 'ghost', reason: 'expired' }),
    ).not.toThrow();
  });

  it('connection loss kills every result on that connection and no others', async () => {
    const results = useResultsStore();
    results.subscribe();
    await runOne('res-a', 'conn-1');
    await runOne('res-b', 'conn-1');
    await runOne('res-c', 'conn-2');

    stub.listeners.lost[0]!({ connectionId: 'conn-1' });

    expect(results.stateOf('res-a')?.source.terminal).toBe('connection-lost');
    expect(results.stateOf('res-b')?.source.terminal).toBe('connection-lost');
    expect(results.stateOf('res-c')?.source.terminal).toBeNull();
  });

  it('a done progress event replaces the estimate with the exact count', async () => {
    const results = useResultsStore();
    results.subscribe();
    stub.runResult = ok({
      resultId: 'res-1',
      meta: meta({ rowCount: 9_999_884, rowCountIsEstimate: true }),
    });
    await results.run({
      connectionId: 'c1',
      sql: 'select * from fixtures.big',
      title: 'big',
      browse: { schema: 'fixtures', table: 'big' },
    });
    expect(results.stateOf('res-1')?.meta.rowCountIsEstimate).toBe(true);

    stub.metaResult = ok(meta({ rowCount: 10_000_000, rowCountIsEstimate: false }));
    stub.listeners.progress[0]!({ resultId: 'res-1', phase: 'done', rowsReceived: 10_000_000 });
    await flush();

    expect(results.stateOf('res-1')?.meta.rowCount).toBe(10_000_000);
    expect(results.stateOf('res-1')?.meta.rowCountIsEstimate).toBe(false);
  });

  it('ignores progress phases that do not carry a final count', async () => {
    const results = useResultsStore();
    results.subscribe();
    await runOne('res-1');
    stub.listeners.progress[0]!({ resultId: 'res-1', phase: 'streaming', rowsReceived: 200 });
    await flush();
    expect(stub.metaCalls).toEqual([]);
  });

  it('a closed result stops receiving refreshes', async () => {
    const results = useResultsStore();
    results.subscribe();
    await runOne('res-1');
    results.close('res-1');
    stub.listeners.progress[0]!({ resultId: 'res-1', phase: 'done', rowsReceived: 1 });
    await flush();
    expect(stub.metaCalls).toEqual([]);
  });
});

describe('lookups', () => {
  it('returns null for an unknown result rather than throwing', () => {
    const results = useResultsStore();
    expect(results.sourceOf('ghost')).toBeNull();
    expect(results.stateOf('ghost')).toBeNull();
  });

  it('exposes the live source so the grid can be handed it directly', async () => {
    const results = useResultsStore();
    await runOne('res-1');
    const source = results.sourceOf('res-1')!;
    expect(source.rowCount).toBe(1_000);
    expect(source.columns).toBe(COLUMNS);
  });
});
