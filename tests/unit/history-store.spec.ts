/**
 * The query-history store (PLAN Phase 7).
 *
 * Tier 2 under AGENTS.md — an adapter over the IPC bridge — so written after the
 * implementation, like `schema-store.spec.ts`. The retention rules and the JSONL
 * format are covered test-first in `history-codec.spec.ts` and `history-file.spec.ts`;
 * what is worth testing here is the async behaviour, because each of these is a way
 * the panel can quietly show the wrong thing:
 *
 *  - a record must land in the list **without** re-reading the log, or every Run
 *    click costs a parse of up to 3 MiB;
 *  - a failed write must not fail the query it describes;
 *  - the panel must not read the log until it is opened;
 *  - a filter must find a statement regardless of how it was indented.
 *
 * `window.tabby` is stubbed rather than mocked at module level, so the store's own
 * code path — reading the bridge off `window` — is what runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { HISTORY_LIMITS, type HistoryEntry } from '@shared/history';
import type { HistoryListResponse } from '@shared/ipc-contract';
import type { Result, TabbyErrorCode } from '@shared/errors';
import { useHistoryStore } from '@/stores/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h1',
    sql: 'select 1',
    truncated: false,
    connectionId: 'c1',
    connectionLabel: 'Local · localhost:5432/postgres',
    ranAt: 1_700_000_000_000,
    elapsedMs: 4,
    rowCount: 1,
    status: 'ok',
    ...overrides,
  };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failure<T>(code: TabbyErrorCode, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function listing(entries: readonly HistoryEntry[], extra: Partial<HistoryListResponse> = {}) {
  return ok<HistoryListResponse>({ entries, skipped: 0, warning: null, ...extra });
}

interface Stub {
  readonly listCalls: (number | undefined)[];
  readonly addCalls: Record<string, unknown>[];
  readonly deleteCalls: string[];
  clearCalls: number;
  listResult: Result<HistoryListResponse>;
  addResult: Result<HistoryEntry>;
  deleteResult: Result<void>;
  clearResult: Result<number>;
}

function stubApi(): Stub {
  const stub: Stub = {
    listCalls: [],
    addCalls: [],
    deleteCalls: [],
    clearCalls: 0,
    listResult: listing([]),
    addResult: ok(entry()),
    deleteResult: ok(undefined),
    clearResult: ok(0),
  };

  vi.stubGlobal('window', {
    tabby: {
      versions: { electron: '0', chrome: '0', node: '0' },
      db: {
        historyList: (limit?: number) => {
          stub.listCalls.push(limit);
          return Promise.resolve(stub.listResult);
        },
        historyAdd: (request: Record<string, unknown>) => {
          stub.addCalls.push(request);
          return Promise.resolve(stub.addResult);
        },
        historyDelete: (historyId: string) => {
          stub.deleteCalls.push(historyId);
          return Promise.resolve(stub.deleteResult);
        },
        historyClear: () => {
          stub.clearCalls += 1;
          return Promise.resolve(stub.clearResult);
        },
      },
      events: {},
    },
  });

  return stub;
}

let stub: Stub;

beforeEach(() => {
  setActivePinia(createPinia());
  stub = stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('panel visibility', () => {
  it('does not read the log until the panel is opened', async () => {
    const history = useHistoryStore();
    expect(stub.listCalls).toEqual([]);
    expect(history.loaded).toBe(false);

    history.show();
    await Promise.resolve();
    expect(stub.listCalls).toHaveLength(1);
  });

  it('reads once, however many times the panel is opened', async () => {
    const history = useHistoryStore();
    history.show();
    await Promise.resolve();
    history.hide();
    history.show();
    await Promise.resolve();
    expect(stub.listCalls).toHaveLength(1);
    expect(history.loaded).toBe(true);
  });

  it('toggles', () => {
    const history = useHistoryStore();
    expect(history.open).toBe(false);
    history.toggle();
    expect(history.open).toBe(true);
    history.toggle();
    expect(history.open).toBe(false);
  });

  it('clears the filter on open, so a stale one cannot hide the log', async () => {
    // Reopening narrowed to last session's search reads as "my history is gone",
    // which is the opposite of what the panel is for.
    stub.listResult = listing([entry({ id: 'a', sql: 'select a' }), entry({ id: 'b' })]);
    const history = useHistoryStore();
    await history.refresh();
    history.search('select a');
    expect(history.filtered).toHaveLength(1);

    history.show();
    expect(history.query).toBe('');
    expect(history.filtered).toHaveLength(2);
  });
});

describe('refresh', () => {
  it('adopts the entries, the skipped count and the warning from main', async () => {
    stub.listResult = listing([entry({ id: 'a' }), entry({ id: 'b' })], {
      skipped: 2,
      warning: 'could not read history.1.jsonl',
    });
    const history = useHistoryStore();
    await history.refresh();

    expect(history.entries.map((each) => each.id)).toEqual(['a', 'b']);
    expect(history.skipped).toBe(2);
    expect(history.warning).toBe('could not read history.1.jsonl');
    expect(history.error).toBeNull();
  });

  it('records a failure and keeps whatever was already listed', async () => {
    const history = useHistoryStore();
    stub.listResult = listing([entry({ id: 'kept' })]);
    await history.refresh();

    stub.listResult = failure('INTERNAL', 'disk on fire');
    await history.refresh();

    expect(history.error?.message).toBe('disk on fire');
    expect(history.entries.map((each) => each.id)).toEqual(['kept']);
  });

  it('clears a previous error once a refresh succeeds', async () => {
    const history = useHistoryStore();
    stub.listResult = failure('NOT_CONNECTED', 'nobody home');
    await history.refresh();
    expect(history.error).not.toBeNull();

    stub.listResult = listing([]);
    await history.refresh();
    expect(history.error).toBeNull();
  });
});

describe('record', () => {
  it('prepends what main stored, using main’s id and timestamp', async () => {
    const history = useHistoryStore();
    stub.listResult = listing([entry({ id: 'older', sql: 'select 0' })]);
    await history.refresh();

    stub.addResult = ok(entry({ id: 'from-main', ranAt: 1_800_000_000_000 }));
    const stored = await history.record({
      sql: 'select 1',
      connectionId: 'c1',
      connectionLabel: 'Local',
      status: 'ok',
      elapsedMs: 3,
      rowCount: 1,
    });

    expect(stored).toBe(true);
    expect(history.entries.map((each) => each.id)).toEqual(['from-main', 'older']);
  });

  it('does not re-read the log to do it', async () => {
    // The whole point: a Run click must not cost a parse of every rotation.
    const history = useHistoryStore();
    history.show();
    await Promise.resolve();
    expect(stub.listCalls).toHaveLength(1);

    await history.record({
      sql: 'select 1',
      connectionId: 'c1',
      connectionLabel: 'Local',
      status: 'ok',
      elapsedMs: 3,
      rowCount: 1,
    });
    expect(stub.listCalls).toHaveLength(1);
  });

  it('sends the run to main exactly as given', async () => {
    const history = useHistoryStore();
    await history.record({
      sql: "select 'a'",
      connectionId: 'c9',
      connectionLabel: 'Prod',
      status: 'failed',
      elapsedMs: -1,
      rowCount: -1,
    });
    expect(stub.addCalls).toEqual([
      {
        sql: "select 'a'",
        connectionId: 'c9',
        connectionLabel: 'Prod',
        status: 'failed',
        elapsedMs: -1,
        rowCount: -1,
      },
    ]);
  });

  it('reports a failure without touching the list', async () => {
    const history = useHistoryStore();
    stub.listResult = listing([entry({ id: 'kept' })]);
    await history.refresh();

    stub.addResult = failure('INTERNAL', 'the query history could not be written');
    const stored = await history.record({
      sql: 'select 1',
      connectionId: 'c1',
      connectionLabel: 'Local',
      status: 'ok',
      elapsedMs: 3,
      rowCount: 1,
    });

    expect(stored).toBe(false);
    expect(history.error?.code).toBe('INTERNAL');
    expect(history.entries.map((each) => each.id)).toEqual(['kept']);
  });

  it('keeps the local list within the retention cap, dropping the oldest', async () => {
    const history = useHistoryStore();
    // Newest first, which is the order `history:list` returns and therefore the
    // order the list is in: the cap has to fall off the *end*, or a long session
    // would push out the query the user just ran.
    const full = Array.from({ length: HISTORY_LIMITS.maxEntriesReturned }, (_, index) =>
      entry({ id: `h${HISTORY_LIMITS.maxEntriesReturned - 1 - index}`, ranAt: 2_000 - index }),
    );
    stub.listResult = listing(full);
    await history.refresh();
    expect(history.entries[0]?.id).toBe(`h${HISTORY_LIMITS.maxEntriesReturned - 1}`);

    stub.addResult = ok(entry({ id: 'newest', ranAt: 3_000 }));
    await history.record({
      sql: 'select 1',
      connectionId: 'c1',
      connectionLabel: 'Local',
      status: 'ok',
      elapsedMs: 3,
      rowCount: 1,
    });

    expect(history.entries).toHaveLength(HISTORY_LIMITS.maxEntriesReturned);
    expect(history.entries[0]?.id).toBe('newest');
    // The oldest is gone from the panel; main still has it until rotation drops it.
    expect(history.entries.some((each) => each.id === 'h0')).toBe(false);
    expect(history.entries.at(-1)?.id).toBe('h1');
  });
});

describe('remove', () => {
  it('drops one entry locally', async () => {
    const history = useHistoryStore();
    stub.listResult = listing([entry({ id: 'a' }), entry({ id: 'b' })]);
    await history.refresh();

    expect(await history.remove('a')).toBe(true);
    expect(stub.deleteCalls).toEqual(['a']);
    expect(history.entries.map((each) => each.id)).toEqual(['b']);
  });

  it('reports a failure and keeps the entry', async () => {
    const history = useHistoryStore();
    stub.listResult = listing([entry({ id: 'a' })]);
    await history.refresh();

    stub.deleteResult = failure('NOT_FOUND', 'no history entry with id a');
    expect(await history.remove('a')).toBe(false);
    expect(history.entries.map((each) => each.id)).toEqual(['a']);
    expect(history.error?.code).toBe('NOT_FOUND');
  });
});

describe('clear', () => {
  it('empties the list, the skipped count and the warning, and returns the count', async () => {
    const history = useHistoryStore();
    stub.listResult = listing([entry({ id: 'a' }), entry({ id: 'b' })], {
      skipped: 3,
      warning: 'something',
    });
    await history.refresh();

    stub.clearResult = ok(2);
    expect(await history.clear()).toBe(2);
    expect(history.entries).toEqual([]);
    expect(history.skipped).toBe(0);
    expect(history.warning).toBeNull();
    expect(stub.clearCalls).toBe(1);
  });

  it('returns null on failure and keeps the entries', async () => {
    const history = useHistoryStore();
    stub.listResult = listing([entry({ id: 'a' })]);
    await history.refresh();

    stub.clearResult = failure('INTERNAL', 'nope');
    expect(await history.clear()).toBeNull();
    expect(history.entries).toHaveLength(1);
  });
});

describe('filtered', () => {
  async function loaded(): Promise<ReturnType<typeof useHistoryStore>> {
    stub.listResult = listing([
      entry({ id: 'a', sql: 'SELECT * FROM fixtures.big', connectionLabel: 'Prod · db1' }),
      entry({ id: 'b', sql: 'select  count(*)\n  from  fixtures.wide', connectionLabel: 'Local' }),
      entry({ id: 'c', sql: "select 'literal'", connectionLabel: 'Staging' }),
    ]);
    const history = useHistoryStore();
    await history.refresh();
    return history;
  }

  it('returns everything while the filter is empty', async () => {
    const history = await loaded();
    expect(history.filtered.map((each) => each.id)).toEqual(['a', 'b', 'c']);
  });

  it('matches a statement case-insensitively', async () => {
    const history = await loaded();
    history.search('SELECT * FROM fixtures.big');
    expect(history.filtered.map((each) => each.id)).toEqual(['a']);
  });

  it('matches a statement written across several lines', async () => {
    // The search collapses the stored statement, so a user typing one line finds a
    // query that was written as three.
    const history = await loaded();
    history.search('select count(*) from fixtures.wide');
    expect(history.filtered.map((each) => each.id)).toEqual(['b']);
  });

  it('matches on the connection label', async () => {
    const history = await loaded();
    history.search('staging');
    expect(history.filtered.map((each) => each.id)).toEqual(['c']);
  });

  it('matches a fragment that spans the statement and the label', async () => {
    const history = await loaded();
    history.search('fixtures.wide');
    expect(history.filtered.map((each) => each.id)).toEqual(['b']);
  });

  it('returns nothing, not everything, when no entry matches', async () => {
    const history = await loaded();
    history.search('no such table anywhere');
    expect(history.filtered).toEqual([]);
    expect(history.isEmpty).toBe(false);
  });

  it('ignores surrounding whitespace in the filter', async () => {
    const history = await loaded();
    history.search('   staging   ');
    expect(history.filtered.map((each) => each.id)).toEqual(['c']);
  });

  it('reports the unfiltered count separately from the visible one', async () => {
    const history = await loaded();
    history.search('staging');
    expect(history.count).toBe(3);
    expect(history.filtered).toHaveLength(1);
  });
});
