/**
 * `RemoteDataSource` — the IPC-backed `DataSource` that replaces `FakeDataSource`
 * (PLAN Phase 5).
 *
 * Tier 1 under AGENTS.md ("data-windowing logic"), written test-first. The bridge
 * and the clock are injected, so the whole retry/error state machine is testable
 * without Electron or a database.
 *
 * The property that matters most is the one the grid forces on us: `DataWindowController`
 * re-requests any block that is neither cached nor in flight, and it calls `update()`
 * on every frame. A range that fails therefore gets re-requested **60 times a
 * second** unless the source refuses. Against a dead server that is a retry storm
 * the user cannot see and cannot stop. So backoff lives here, not in the grid —
 * the grid's public API is frozen by Phase 5's exit criterion.
 *
 * Expectations come from that constraint and from the error codes main actually
 * returns, not from the implementation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ColumnMeta, RowBlock } from '@shared/domain';
import { encodeBlock } from '@shared/columnar';
import type { Result, TabbyError } from '@shared/errors';
import type { EncodedRowBlock, ResultMeta } from '@shared/domain';
import type { ResultSortRequest, ResultWindowRequest } from '@shared/ipc-contract';
import type { DataSource } from '@/grid/types';
import {
  DEFAULT_RETRY,
  RemoteDataSource,
  RemoteSourceError,
  type ResultBridge,
  type SourceState,
} from '@/data/remote-source';

const RESULT_ID = 'res-1';

const COLUMNS: ColumnMeta[] = [
  { name: 'id', typeName: 'int8', typeOid: 20, nullable: false, widthHint: 90 },
  { name: 'label', typeName: 'text', typeOid: 25, nullable: true, widthHint: 170 },
];

function meta(overrides: Partial<ResultMeta> = {}): ResultMeta {
  return {
    resultId: RESULT_ID,
    columns: COLUMNS,
    rowCount: 1_000,
    rowCountIsEstimate: false,
    elapsedMs: 12,
    ...overrides,
  };
}

/** Builds a real encoded block, so decoding is exercised rather than stubbed. */
function encoded(startRow: number, rowCount: number, idOffset = 0): EncodedRowBlock {
  const rows: (readonly unknown[])[] = Array.from({ length: rowCount }, (_, i) => [
    String(startRow + i + 1 + idOffset),
    `row-${startRow + i + idOffset}`,
  ]);
  return encodeBlock(rows, COLUMNS, startRow);
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failure<T>(code: TabbyError['code'], message = 'failed'): Result<T> {
  return { ok: false, error: { code, message } };
}

interface FakeBridge extends ResultBridge {
  readonly windowCalls: ResultWindowRequest[];
  readonly sortCalls: ResultSortRequest[];
  readonly metaCalls: string[];
  windowResult: Result<EncodedRowBlock>;
  sortResult: Result<ResultMeta>;
  metaResult: Result<ResultMeta>;
}

function fakeBridge(initial: Result<EncodedRowBlock> = ok(encoded(0, 200))): FakeBridge {
  const state: FakeBridge = {
    windowCalls: [],
    sortCalls: [],
    metaCalls: [],
    windowResult: initial,
    sortResult: ok(meta()),
    metaResult: ok(meta()),
    resultWindow: (req) => {
      state.windowCalls.push(req);
      return Promise.resolve(state.windowResult);
    },
    resultSort: (req) => {
      state.sortCalls.push(req);
      return Promise.resolve(state.sortResult);
    },
    resultMeta: (resultId) => {
      state.metaCalls.push(resultId);
      return Promise.resolve(state.metaResult);
    },
  };
  return state;
}

let clock: number;
let states: SourceState[];

function makeSource(bridge: ResultBridge = fakeBridge(), initial = meta()) {
  return new RemoteDataSource({
    resultId: RESULT_ID,
    bridge,
    meta: initial,
    now: () => clock,
    onStateChange: (state) => states.push(state),
  });
}

function signal(aborted = false): AbortSignal {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return controller.signal;
}

/** Settles a promise without an unhandled rejection warning. */
async function settled<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

beforeEach(() => {
  clock = 1_000_000;
  states = [];
});

describe('DataSource conformance', () => {
  it('satisfies the grid interface without the grid knowing about IPC', () => {
    // Compile-time proof of Phase 5's whole premise: the boundary held.
    const source: DataSource = makeSource();
    expect(source.rowCount).toBe(1_000);
    expect(source.rowCountIsEstimate).toBe(false);
    expect(source.columns).toBe(COLUMNS);
    expect(typeof source.getBlock).toBe('function');
    expect(typeof source.sort).toBe('function');
  });

  it('exposes columns and rowCount live, since the grid re-reads them every frame', () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge, meta({ rowCount: 500 }));
    expect(source.rowCount).toBe(500);

    bridge.metaResult = ok(meta({ rowCount: 1_000_000, rowCountIsEstimate: true }));
    return source.refreshMeta().then(() => {
      expect(source.rowCount).toBe(1_000_000);
      expect(source.rowCountIsEstimate).toBe(true);
    });
  });
});

describe('getBlock', () => {
  it('requests exactly the range the grid asked for', async () => {
    const bridge = fakeBridge(ok(encoded(400, 200)));
    const source = makeSource(bridge);
    await source.getBlock(400, 200, signal());
    expect(bridge.windowCalls).toEqual([{ resultId: RESULT_ID, startRow: 400, rowCount: 200 }]);
  });

  it('decodes the columnar block into the RowBlock the grid consumes', async () => {
    const source = makeSource(fakeBridge(ok(encoded(0, 3))));
    const block: RowBlock = await source.getBlock(0, 3, signal());

    expect(block.startRow).toBe(0);
    expect(block.rowCount).toBe(3);
    expect(block.columns).toHaveLength(2);
    // int8 keeps its exact text: the whole reason the codec carries `raw`.
    expect(block.columns[0]![0]).toMatchObject({ kind: 'number', raw: '1' });
    expect(block.columns[1]![2]).toEqual({ kind: 'text', value: 'row-2' });
  });

  it('returns a short block at the end of the result without padding it', async () => {
    const source = makeSource(fakeBridge(ok(encoded(998, 2))));
    const block = await source.getBlock(998, 200, signal());
    expect(block.rowCount).toBe(2);
    expect(block.columns[0]).toHaveLength(2);
  });

  it('returns an empty block for an empty page', async () => {
    const source = makeSource(fakeBridge(ok(encoded(0, 0))));
    const block = await source.getBlock(0, 200, signal());
    expect(block.rowCount).toBe(0);
    expect(block.columns[0]).toEqual([]);
  });

  it('clears a range’s failure record once it succeeds', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);
    await settled(source.getBlock(0, 200, signal()));
    expect(source.state.failedRanges).toBe(1);

    bridge.windowResult = ok(encoded(0, 200));
    clock += DEFAULT_RETRY.baseMs + 1;
    await source.getBlock(0, 200, signal());
    expect(source.state.failedRanges).toBe(0);
    expect(source.state.lastError).toBeNull();
  });
});

describe('abort and stale responses', () => {
  it('does not call the bridge when the signal is already aborted', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge);
    const outcome = await settled(source.getBlock(0, 200, signal(true)));
    expect(outcome.ok).toBe(false);
    expect(bridge.windowCalls).toEqual([]);
  });

  it('rejects when the signal aborts mid-flight and drops the late result', async () => {
    const bridge = fakeBridge();
    const controller = new AbortController();
    // Held on an object: a `let` assigned inside a promise executor stays
    // narrowed to null as far as the compiler is concerned, so the call below
    // would not typecheck.
    const pending: { resolve: ((value: Result<EncodedRowBlock>) => void) | null } = {
      resolve: null,
    };
    bridge.resultWindow = () =>
      new Promise<Result<EncodedRowBlock>>((resolve) => {
        pending.resolve = resolve;
      });

    const source = makeSource(bridge);
    const outcome = settled(source.getBlock(0, 200, controller.signal));
    controller.abort();

    // The server eventually answers; that answer must not reach the caller.
    pending.resolve?.(ok(encoded(0, 200)));
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(RemoteSourceError);
      expect((result.error as RemoteSourceError).kind).toBe('aborted');
    }
  });

  it('does not treat an abort as a failure, so fast scrolling cannot poison the source', async () => {
    const bridge = fakeBridge();
    const controller = new AbortController();
    // Held on an object: a `let` assigned inside a promise executor stays
    // narrowed to null as far as the compiler is concerned, so the call below
    // would not typecheck.
    const pending: { resolve: ((value: Result<EncodedRowBlock>) => void) | null } = {
      resolve: null,
    };
    bridge.resultWindow = () =>
      new Promise<Result<EncodedRowBlock>>((resolve) => {
        pending.resolve = resolve;
      });

    const source = makeSource(bridge);
    const outcome = settled(source.getBlock(0, 200, controller.signal));
    controller.abort();
    pending.resolve?.(ok(encoded(0, 200)));
    await outcome;

    expect(source.state.failedRanges).toBe(0);
    expect(source.state.lastError).toBeNull();
    expect(source.state.terminal).toBeNull();
  });

  it('rejects with an abort error, not a server error, when both happen', async () => {
    // The common real case: the user scrolls away from a range that was about to
    // fail. Reporting a server error would put a retry banner up for nothing.
    const bridge = fakeBridge(failure('INTERNAL'));
    const controller = new AbortController();
    controller.abort();
    const source = makeSource(bridge);
    const outcome = await settled(source.getBlock(0, 200, controller.signal));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect((outcome.error as RemoteSourceError).kind).toBe('aborted');
  });
});

describe('retry backoff', () => {
  it('does not re-request a range on every frame', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);

    // The grid calls update() every frame, so an unbacked-off failure is 60 IPC
    // round trips a second against a server that is already struggling.
    for (let frame = 0; frame < 60; frame += 1) {
      await settled(source.getBlock(0, 200, signal()));
      clock += 16;
    }
    // One second spans a few backoff windows, so a handful of attempts is correct;
    // 60 would be the storm.
    expect(bridge.windowCalls.length).toBeGreaterThanOrEqual(1);
    expect(bridge.windowCalls.length).toBeLessThan(10);
  });

  it('makes exactly one attempt inside the base backoff window', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);

    for (let frame = 0; frame < 10; frame += 1) {
      // 10 frames at 60fps ≈ 160ms, inside the 250ms base backoff.
      await settled(source.getBlock(0, 200, signal()));
      clock += 16;
    }
    expect(bridge.windowCalls).toHaveLength(1);
  });

  it('retries once the backoff has elapsed', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);
    await settled(source.getBlock(0, 200, signal()));
    expect(bridge.windowCalls).toHaveLength(1);

    clock += DEFAULT_RETRY.baseMs + 1;
    await settled(source.getBlock(0, 200, signal()));
    expect(bridge.windowCalls).toHaveLength(2);
  });

  it('grows the backoff exponentially and caps it', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);

    for (let i = 0; i < 8; i += 1) {
      await settled(source.getBlock(0, 200, signal()));
      clock += DEFAULT_RETRY.maxMs + 1;
    }

    // Never more than maxAttempts calls, however long the grid keeps asking.
    expect(bridge.windowCalls.length).toBeLessThanOrEqual(DEFAULT_RETRY.maxAttempts);
    expect(source.state.failedRanges).toBe(1);
  });

  it('stops retrying a range permanently after maxAttempts', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);

    for (let i = 0; i < DEFAULT_RETRY.maxAttempts + 5; i += 1) {
      await settled(source.getBlock(0, 200, signal()));
      clock += DEFAULT_RETRY.maxMs + 1;
    }
    const callsAfterGiveUp = bridge.windowCalls.length;

    for (let i = 0; i < 20; i += 1) {
      await settled(source.getBlock(0, 200, signal()));
      clock += DEFAULT_RETRY.maxMs + 1;
    }
    expect(bridge.windowCalls).toHaveLength(callsAfterGiveUp);
    expect(callsAfterGiveUp).toBe(DEFAULT_RETRY.maxAttempts);
  });

  it('keeps per-range records separate, so one bad range cannot block a good one', async () => {
    const bridge = fakeBridge();
    bridge.resultWindow = (req) => {
      bridge.windowCalls.push(req);
      return Promise.resolve(
        req.startRow === 0
          ? failure<EncodedRowBlock>('QUERY_TIMEOUT')
          : ok(encoded(req.startRow, req.rowCount)),
      );
    };
    const source = makeSource(bridge);

    await settled(source.getBlock(0, 200, signal()));
    expect(source.state.failedRanges).toBe(1);

    const good = await source.getBlock(200, 200, signal());
    expect(good.rowCount).toBe(200);
    expect(source.state.failedRanges).toBe(1);
  });

  it('retryFailed() clears the backoff so the next frame tries again', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);

    for (let i = 0; i < DEFAULT_RETRY.maxAttempts + 2; i += 1) {
      await settled(source.getBlock(0, 200, signal()));
      clock += DEFAULT_RETRY.maxMs + 1;
    }
    const before = bridge.windowCalls.length;

    source.retryFailed();
    await settled(source.getBlock(0, 200, signal()));
    expect(bridge.windowCalls.length).toBe(before + 1);
  });

  it('reports a backoff rejection distinctly, so the UI does not show it as an error', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);
    await settled(source.getBlock(0, 200, signal()));

    const outcome = await settled(source.getBlock(0, 200, signal()));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect((outcome.error as RemoteSourceError).kind).toBe('backoff');
  });
});

describe('terminal errors', () => {
  const cases: [TabbyError['code'], SourceState['terminal']][] = [
    ['RESULT_EVICTED', 'evicted'],
    ['RESULT_NOT_FOUND', 'evicted'],
    ['CURSOR_CLOSED', 'cursor-closed'],
    ['CONN_LOST', 'connection-lost'],
    ['QUERY_CANCELLED', 'cancelled'],
  ];

  it.each(cases)('%s becomes terminal as %s', async (code, terminal) => {
    const bridge = fakeBridge(failure(code));
    const source = makeSource(bridge);

    const outcome = await settled(source.getBlock(0, 200, signal()));
    expect(outcome.ok).toBe(false);
    expect(source.state.terminal).toBe(terminal);
  });

  it('never calls the bridge again once terminal, for any range', async () => {
    const bridge = fakeBridge(failure('RESULT_EVICTED'));
    const source = makeSource(bridge);
    await settled(source.getBlock(0, 200, signal()));
    const calls = bridge.windowCalls.length;

    for (const startRow of [0, 200, 800_000]) {
      clock += DEFAULT_RETRY.maxMs + 1;
      await settled(source.getBlock(startRow, 200, signal()));
    }
    expect(bridge.windowCalls).toHaveLength(calls);
  });

  it('rejects a terminal fetch with the server error attached, so the UI can explain it', async () => {
    const bridge = fakeBridge({
      ok: false,
      error: { code: 'RESULT_EVICTED', message: 'expired; re-run' },
    });
    const source = makeSource(bridge);
    const outcome = await settled(source.getBlock(0, 200, signal()));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const error = outcome.error as RemoteSourceError;
      expect(error.kind).toBe('terminal');
      expect(error.error?.code).toBe('RESULT_EVICTED');
      expect(error.message).toContain('expired; re-run');
    }
  });

  it('does not treat an ordinary failure as terminal', async () => {
    for (const code of ['QUERY_TIMEOUT', 'INTERNAL', 'SYNTAX_ERROR'] as const) {
      const bridge = fakeBridge(failure(code));
      const source = makeSource(bridge);
      await settled(source.getBlock(0, 200, signal()));
      expect(source.state.terminal, code).toBeNull();
      expect(source.state.failedRanges, code).toBe(1);
    }
  });

  it('goes terminal when the app reports the connection was lost', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge);
    source.markConnectionLost();
    expect(source.state.terminal).toBe('connection-lost');

    const outcome = await settled(source.getBlock(0, 200, signal()));
    expect(outcome.ok).toBe(false);
    expect(bridge.windowCalls).toEqual([]);
  });

  it('goes terminal when the app reports this result was evicted', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge);
    source.markEvicted('capacity');
    expect(source.state.terminal).toBe('evicted');
    await settled(source.getBlock(0, 200, signal()));
    expect(bridge.windowCalls).toEqual([]);
  });

  it('ignores an eviction notice for a different result', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge);
    source.markEvicted('expired', 'some-other-result');
    expect(source.state.terminal).toBeNull();
    await source.getBlock(0, 200, signal());
    expect(bridge.windowCalls).toHaveLength(1);
  });
});

describe('sorting is always server-side', () => {
  it('sends the sort to main rather than reordering a partial window', () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge);
    return source.sort(1, 'desc').then(() => {
      expect(bridge.sortCalls).toEqual([
        { resultId: RESULT_ID, sort: { columnIndex: 1, direction: 'desc' } },
      ]);
    });
  });

  it('sends a null sort to clear the ordering', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge);
    await source.sort(-1, null);
    expect(bridge.sortCalls).toEqual([{ resultId: RESULT_ID, sort: null }]);
  });

  it('adopts the columns and row count main returns', async () => {
    const sorted = meta({
      columns: [...COLUMNS].reverse(),
      rowCount: 42,
      rowCountIsEstimate: true,
    });
    const bridge = fakeBridge();
    bridge.sortResult = ok(sorted);
    const source = makeSource(bridge);

    await source.sort(0, 'asc');
    expect(source.columns.map((c) => c.name)).toEqual(['label', 'id']);
    expect(source.rowCount).toBe(42);
    expect(source.rowCountIsEstimate).toBe(true);
  });

  it('drops range backoffs after a sort, since the old failures were about other data', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);
    await settled(source.getBlock(0, 200, signal()));
    expect(source.state.failedRanges).toBe(1);

    bridge.windowResult = ok(encoded(0, 200));
    await source.sort(0, 'asc');
    expect(source.state.failedRanges).toBe(0);
  });

  it('refuses to sort once terminal', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge);
    source.markConnectionLost();
    const outcome = await settled(source.sort(0, 'asc'));
    expect(outcome.ok).toBe(false);
    expect(bridge.sortCalls).toEqual([]);
  });

  it('surfaces a failed sort instead of silently keeping the old order', async () => {
    const bridge = fakeBridge();
    bridge.sortResult = failure('QUERY_TIMEOUT', 'sort timed out');
    const source = makeSource(bridge);
    const outcome = await settled(source.sort(0, 'asc'));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect((outcome.error as Error).message).toContain('sort timed out');
  });

  it('treats a terminal sort failure as terminal for the whole source', async () => {
    const bridge = fakeBridge();
    bridge.sortResult = failure('CURSOR_CLOSED');
    const source = makeSource(bridge);
    await settled(source.sort(0, 'asc'));
    expect(source.state.terminal).toBe('cursor-closed');
  });
});

describe('metadata refresh', () => {
  it('picks up the exact row count once the background count lands', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge, meta({ rowCount: 9_999_884, rowCountIsEstimate: true }));
    expect(source.rowCountIsEstimate).toBe(true);

    bridge.metaResult = ok(meta({ rowCount: 10_000_000, rowCountIsEstimate: false }));
    await source.refreshMeta();
    expect(source.rowCount).toBe(10_000_000);
    expect(source.rowCountIsEstimate).toBe(false);
    expect(bridge.metaCalls).toEqual([RESULT_ID]);
  });

  it('keeps the estimate when the refresh fails', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge, meta({ rowCount: 500, rowCountIsEstimate: true }));
    bridge.metaResult = failure('CONN_LOST');
    await source.refreshMeta();
    expect(source.rowCount).toBe(500);
    expect(source.rowCountIsEstimate).toBe(true);
  });

  it('does not refresh once terminal', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge);
    source.markEvicted('expired');
    await source.refreshMeta();
    expect(bridge.metaCalls).toEqual([]);
  });
});

describe('state notifications', () => {
  it('notifies when a range starts failing and when it recovers', async () => {
    const bridge = fakeBridge(failure('QUERY_TIMEOUT'));
    const source = makeSource(bridge);

    await settled(source.getBlock(0, 200, signal()));
    expect(states.at(-1)?.failedRanges).toBe(1);
    expect(states.at(-1)?.lastError?.code).toBe('QUERY_TIMEOUT');

    bridge.windowResult = ok(encoded(0, 200));
    clock += DEFAULT_RETRY.baseMs + 1;
    await source.getBlock(0, 200, signal());
    expect(states.at(-1)?.failedRanges).toBe(0);
    expect(states.at(-1)?.lastError).toBeNull();
  });

  it('notifies on a terminal transition exactly once', async () => {
    const bridge = fakeBridge(failure('CONN_LOST'));
    const source = makeSource(bridge);
    await settled(source.getBlock(0, 200, signal()));
    await settled(source.getBlock(200, 200, signal()));

    const terminalNotices = states.filter((state) => state.terminal !== null);
    expect(terminalNotices).toHaveLength(1);
    expect(terminalNotices[0]?.terminal).toBe('connection-lost');
  });

  it('does not notify when nothing changed', async () => {
    const bridge = fakeBridge();
    const source = makeSource(bridge);
    await source.getBlock(0, 200, signal());
    await source.getBlock(200, 200, signal());
    expect(states).toEqual([]);
  });

  it('exposes a human-readable reason per terminal state', () => {
    const source = makeSource();
    expect(source.terminalMessage).toBeNull();

    source.markEvicted('capacity');
    expect(source.terminalMessage).toMatch(/re-run/i);

    const lost = makeSource();
    lost.markConnectionLost();
    expect(lost.terminalMessage).toMatch(/connection/i);

    const expired = makeSource();
    expired.markEvicted('expired');
    expect(expired.terminalMessage).toMatch(/expired/i);
  });
});

describe('construction', () => {
  it('starts with no failures and no terminal state', () => {
    const source = makeSource();
    expect(source.state).toEqual({
      failedRanges: 0,
      lastError: null,
      terminal: null,
    });
  });

  it('accepts an empty result', () => {
    const source = makeSource(fakeBridge(), meta({ rowCount: 0, columns: [] }));
    expect(source.rowCount).toBe(0);
    expect(source.columns).toEqual([]);
  });
});
