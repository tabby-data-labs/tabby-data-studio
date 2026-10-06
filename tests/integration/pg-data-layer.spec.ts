/**
 * Phase 4 exit criteria, verified against a live Postgres rather than a mock.
 *
 * A mock can only confirm that we asked for what we meant to ask for. The claims
 * that matter here are claims about the *server*: that read-only mode is actually
 * on, that a NO SCROLL cursor really cannot scan backward, that a 10M-row first
 * window really lands inside 500ms, and that cancelling really unblocks the caller
 * inside 200ms. None of those are knowable without a database.
 *
 * Skipped entirely when TABBY_TEST_PG_USER / _DATABASE are unset. See
 * helpers/pg-harness.ts for the environment contract; no credential is stored here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCell } from '../../src/shared/columnar';
import type { EncodedRowBlock, ResultMeta } from '../../src/shared/domain';
import { toTabbyError } from '../../src/main/db/pg-error';
import { READ_ONLY_PROBE_SQL } from '../../src/main/db/introspect';
import { selectFromTableSql } from '../../src/main/db/result-sql';
import { DEFAULT_SESSION_LIMITS } from '../../src/main/db/session';
import type { ResultRegistry } from '../../src/main/db/result-registry';
import type { LiveResult } from '../../src/main/db/query-service';
import {
  CONNECTION_ID,
  SCHEMA,
  createHarness,
  now,
  pgConfigured,
  report,
  type Harness,
} from './helpers/pg-harness';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function columnIndex(meta: ResultMeta, name: string): number {
  const index = meta.columns.findIndex((column) => column.name === name);
  expect(index, `column ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

function cell(block: EncodedRowBlock, meta: ResultMeta, name: string, row: number) {
  return decodeCell(block.columns[columnIndex(meta, name)]!, row);
}

async function runOk(h: Harness, sql: string, initialRows = 200) {
  const result = await h.queries.run({ connectionId: CONNECTION_ID, sql, initialRows });
  if (!result.ok) throw new Error(`queryRun failed: ${result.error.code} ${result.error.message}`);
  return result.value;
}

/** Counts our own backends that are sitting in an open transaction. */
async function idleInTransactionBackends(h: Harness): Promise<number> {
  const session = h.connections.session(CONNECTION_ID);
  if (!session) return -1;
  const result = await session.query(
    "select count(*) from pg_stat_activity where application_name = 'tabby' and state = 'idle in transaction'",
  );
  return Number(result.rows[0]?.[0] ?? -1);
}

describe.skipIf(!pgConfigured)('live postgres · session hardening', () => {
  let h: Harness;

  beforeAll(async () => {
    h = createHarness();
    const opened = await h.connections.open(CONNECTION_ID);
    expect(opened.ok, opened.ok ? '' : opened.error.message).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await h?.dispose();
  });

  it('reports a real server version', () => {
    const info = h.connections.info(CONNECTION_ID);
    expect(info?.serverVersion).toMatch(/PostgreSQL \d+/);
  });

  it('turns on default_transaction_read_only for every backend', async () => {
    const session = h.connections.session(CONNECTION_ID)!;
    const result = await session.query(READ_ONLY_PROBE_SQL);
    expect(result.rows[0]?.[0]).toBe('on');
  });

  it('applies every session characteristic, including on a client the pool created later', async () => {
    const session = h.connections.session(CONNECTION_ID)!;
    const result = await session.query(`
      select current_setting('default_transaction_read_only'),
             current_setting('statement_timeout'),
             current_setting('idle_in_transaction_session_timeout'),
             current_setting('lock_timeout'),
             current_setting('client_encoding'),
             current_setting('DateStyle'),
             current_setting('TimeZone'),
             current_setting('application_name')
    `);
    const [readOnly, statement, idle, lock, encoding, dateStyle, timezone, appName] =
      result.rows[0]!;

    expect(readOnly).toBe('on');
    // Postgres normalises the integer milliseconds we sent back into its own units.
    expect(statement).toBe(`${DEFAULT_SESSION_LIMITS.statementTimeoutMs / 1000}s`);
    expect(lock).toBe(`${DEFAULT_SESSION_LIMITS.lockTimeoutMs / 1000}s`);
    expect(idle).toBe('1min');
    expect(encoding).toBe('UTF8');
    expect(dateStyle).toBe('ISO, MDY');
    // The host timezone is not UTC, so this proves the SET took effect rather than
    // passing by accident.
    expect(timezone).toBe('UTC');
    expect(appName).toBe('tabby');
  });

  it('applies the same settings to a freshly created pool client, not just the first', async () => {
    // The pool creates clients lazily. Hardening only the first would leave a
    // writable backend behind, which is the failure mode this test exists for.
    const session = h.connections.session(CONNECTION_ID)!;
    const handles = await Promise.all([session.acquire(), session.acquire(), session.acquire()]);
    try {
      for (const handle of handles) {
        const result = await handle.query(READ_ONLY_PROBE_SQL);
        expect(result.rows[0]?.[0]).toBe('on');
      }
      const pids = handles.map((handle) => handle.backendPid);
      expect(new Set(pids).size, 'each handle should be a distinct backend').toBe(pids.length);
      expect(pids.every((pid) => pid > 0)).toBe(true);
    } finally {
      for (const handle of handles) handle.release();
    }
  });
});

describe.skipIf(!pgConfigured)('live postgres · read-only enforcement', () => {
  let h: Harness;

  beforeAll(async () => {
    h = createHarness();
    await h.connections.open(CONNECTION_ID);
  }, 30_000);

  afterAll(async () => {
    await h?.dispose();
  });

  it('refuses an INSERT with SQLSTATE 25006, mapped to READ_ONLY_VIOLATION', async () => {
    // The PLAN's Phase 4 exit criterion, asserted against the server rather than
    // against our own code's opinion of itself.
    const session = h.connections.session(CONNECTION_ID)!;
    let caught: unknown = null;
    try {
      await session.query("insert into fixtures.read_only_probe (note) values ('direct')");
    } catch (error) {
      caught = error;
    }

    expect(caught, 'the INSERT must not succeed').not.toBeNull();
    const mapped = toTabbyError(caught, { connectionId: CONNECTION_ID });
    expect(mapped.sqlState).toBe('25006');
    expect(mapped.code).toBe('READ_ONLY_VIOLATION');
    expect(mapped.message).toMatch(/read-only transaction/i);
  });

  it('refuses UPDATE, DELETE and DDL too, not only INSERT', async () => {
    const session = h.connections.session(CONNECTION_ID)!;
    const writes = [
      "update fixtures.plain_table set name = 'x' where id = 1",
      'delete from fixtures.plain_table',
      'create table fixtures.should_not_exist (id int)',
      'drop table fixtures.plain_table',
      'truncate fixtures.plain_table',
    ];
    for (const sql of writes) {
      let state: string | null = null;
      try {
        await session.query(sql);
      } catch (error) {
        state = toTabbyError(error).sqlState ?? null;
      }
      expect(state, sql).toBe('25006');
    }
  });

  it('rejects a write submitted through the query channel as well', async () => {
    // A cursor can only wrap a SELECT, so this fails at parse time with a syntax
    // error — a second, independent refusal in front of the read-only one.
    const result = await h.queries.run({
      connectionId: CONNECTION_ID,
      sql: "insert into fixtures.read_only_probe (note) values ('through queryRun')",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['SYNTAX_ERROR', 'READ_ONLY_VIOLATION']).toContain(result.error.code);
    }
  });

  it('rejects a second statement smuggled after the first', async () => {
    const result = await h.queries.run({
      connectionId: CONNECTION_ID,
      sql: "select 1; insert into fixtures.read_only_probe (note) values ('smuggled')",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('wrote nothing', async () => {
    const session = h.connections.session(CONNECTION_ID)!;
    const result = await session.query('select count(*) from fixtures.read_only_probe');
    expect(Number(result.rows[0]?.[0])).toBe(0);
  });
});

describe.skipIf(!pgConfigured)('live postgres · positionable results over 10M rows', () => {
  let h: Harness;
  let resultId: string;
  let meta: ResultMeta;

  beforeAll(async () => {
    h = createHarness();
    await h.connections.open(CONNECTION_ID);
  }, 30_000);

  afterAll(async () => {
    if (resultId) h?.queries.dispose(resultId);
    await h?.dispose();
  });

  it('returns the first 1000 rows of a 10M-row table in under 500ms of client overhead', async () => {
    const started = now();
    // `order by id` is not decoration: without it Postgres is free to return rows
    // in physical order, and every offset assertion below would be guessing. A
    // viewer must never add an ORDER BY the user did not ask for, so the test has
    // to be explicit about the order it depends on.
    const run = await h.queries.run({
      connectionId: CONNECTION_ID,
      sql: `select * from ${SCHEMA}.big order by id`,
      initialRows: 1000,
    });
    const elapsed = now() - started;

    expect(run.ok, run.ok ? '' : run.error.message).toBe(true);
    if (!run.ok) return;
    resultId = run.value.resultId;
    meta = run.value.meta;

    // The exit criterion. Measured with the connection already open, so it is the
    // cost of DECLARE + FETCH 1000 + columnar encode — the client overhead.
    report('first 1000 rows of a 10M-row table (cursor)', elapsed);
    expect(elapsed, `${elapsed}ms`).toBeLessThan(500);
    expect(meta.columns.map((c) => c.name)).toEqual(['id', 'bucket', 'label', 'payload']);
    expect(meta.elapsedMs).toBeLessThan(500);
  }, 30_000);

  it('serves the first window from the prefetch, without re-running the query', async () => {
    const started = now();
    const block = await h.queries.window({ resultId, startRow: 0, rowCount: 100 });
    const elapsed = now() - started;

    expect(block.ok).toBe(true);
    if (!block.ok) return;
    // No round trip at all: a re-declare would have cost tens of milliseconds.
    report('first window served from the prefetch', elapsed);
    expect(elapsed, `${elapsed}ms`).toBeLessThan(50);
    expect(block.value.rowCount).toBe(100);
    expect(cell(block.value, meta, 'id', 0)).toMatchObject({ kind: 'number', raw: '1' });
    expect(cell(block.value, meta, 'id', 99)).toMatchObject({ raw: '100' });
  });

  it('jumps to an arbitrary offset far beyond any cache', async () => {
    const started = now();
    const block = await h.queries.window({ resultId, startRow: 800_000, rowCount: 5 });
    report('forward jump to row 800,000 (MOVE ABSOLUTE)', now() - started);
    expect(block.ok).toBe(true);
    if (!block.ok) return;
    expect(block.value.startRow).toBe(800_000);
    expect(cell(block.value, meta, 'id', 0)).toMatchObject({ raw: '800001' });
    expect(cell(block.value, meta, 'id', 4)).toMatchObject({ raw: '800005' });
    expect(cell(block.value, meta, 'label', 0)).toMatchObject({ value: 'row-800001' });
  }, 30_000);

  it('jumps backwards, which a NO SCROLL cursor cannot do without re-declaring', async () => {
    // Verified against the server: `MOVE ABSOLUTE` to an earlier row fails with
    // "cursor can only scan forward" *and aborts the transaction*. The service
    // closes and re-declares instead; this asserts the outcome the user sees.
    const started = now();
    const block = await h.queries.window({ resultId, startRow: 10, rowCount: 3 });
    report('backward jump to row 10 (close + re-declare)', now() - started);
    expect(block.ok, block.ok ? '' : block.error.message).toBe(true);
    if (!block.ok) return;
    expect(cell(block.value, meta, 'id', 0)).toMatchObject({ raw: '11' });
    expect(cell(block.value, meta, 'id', 2)).toMatchObject({ raw: '13' });
  }, 30_000);

  it('still works forward after a backward jump, from the same snapshot', async () => {
    const block = await h.queries.window({ resultId, startRow: 9_999_995, rowCount: 10 });
    expect(block.ok).toBe(true);
    if (!block.ok) return;
    // The last five rows of the table, and then nothing: a short page at the end.
    expect(block.value.rowCount).toBe(5);
    expect(cell(block.value, meta, 'id', 0)).toMatchObject({ raw: '9999996' });
    expect(cell(block.value, meta, 'id', 4)).toMatchObject({ raw: '10000000' });
  }, 30_000);

  it('pins the exact row count once the cursor reaches the end', async () => {
    const current = h.queries.meta(resultId);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.value.rowCount).toBe(10_000_000);
    expect(current.value.rowCountIsEstimate).toBe(false);
  });

  it('holds a transaction open while the cursor is alive, and releases it on dispose', async () => {
    expect(await idleInTransactionBackends(h)).toBeGreaterThanOrEqual(1);
    h.queries.dispose(resultId);
    // ROLLBACK is issued on disposal; give the server a moment to update its view.
    await sleep(150);
    expect(await idleInTransactionBackends(h)).toBe(0);
  }, 30_000);
});

describe.skipIf(!pgConfigured)('live postgres · browse mode holds no transaction open', () => {
  let h: Harness;
  let resultId: string;
  let meta: ResultMeta;

  beforeAll(async () => {
    h = createHarness();
    await h.connections.open(CONNECTION_ID);
  }, 30_000);

  afterAll(async () => {
    if (resultId) h?.queries.dispose(resultId);
    await h?.dispose();
  });

  it('pages a keyed table without opening a transaction', async () => {
    const run = await h.queries.run({
      connectionId: CONNECTION_ID,
      sql: `select * from ${SCHEMA}.big`,
      initialRows: 10,
      browse: { schema: SCHEMA, table: 'big' },
    });
    expect(run.ok, run.ok ? '' : run.error.message).toBe(true);
    if (!run.ok) return;
    resultId = run.value.resultId;
    meta = run.value.meta;

    // The instant estimate from pg_class.reltuples, before any count(*) lands.
    expect(meta.rowCount).toBeGreaterThan(1_000_000);
    expect(meta.rowCountIsEstimate).toBe(true);
  }, 30_000);

  it('seeks forward, jumps backward, and never leaves a backend idle in transaction', async () => {
    const forward = await h.queries.window({ resultId, startRow: 10, rowCount: 5 });
    expect(forward.ok).toBe(true);
    if (forward.ok) expect(cell(forward.value, meta, 'id', 0)).toMatchObject({ raw: '11' });

    const jumpStarted = now();
    const jump = await h.queries.window({ resultId, startRow: 5_000_000, rowCount: 3 });
    report('browse jump to row 5,000,000 (OFFSET, no open transaction)', now() - jumpStarted);
    expect(jump.ok).toBe(true);
    if (jump.ok) expect(cell(jump.value, meta, 'id', 0)).toMatchObject({ raw: '5000001' });

    const back = await h.queries.window({ resultId, startRow: 0, rowCount: 3 });
    expect(back.ok).toBe(true);
    if (back.ok) expect(cell(back.value, meta, 'id', 0)).toMatchObject({ raw: '1' });

    // The design claim, checked against the server rather than assumed: browse mode
    // pins no xmin horizon, so it cannot cause bloat on a busy production database.
    expect(await idleInTransactionBackends(h)).toBe(0);
  }, 60_000);

  it('re-sorts server-side and re-pages from the top', async () => {
    const idIndex = columnIndex(meta, 'id');
    const sorted = await h.queries.sort({
      resultId,
      sort: { columnIndex: idIndex, direction: 'desc' },
    });
    expect(sorted.ok, sorted.ok ? '' : sorted.error.message).toBe(true);

    const block = await h.queries.window({ resultId, startRow: 0, rowCount: 3 });
    expect(block.ok).toBe(true);
    if (!block.ok) return;
    expect(cell(block.value, sorted.ok ? sorted.value : meta, 'id', 0)).toMatchObject({
      raw: '10000000',
    });
    expect(cell(block.value, sorted.ok ? sorted.value : meta, 'id', 2)).toMatchObject({
      raw: '9999998',
    });
  }, 60_000);

  it('rejects a sort on a column index that does not exist', async () => {
    const sorted = await h.queries.sort({ resultId, sort: { columnIndex: 999, direction: 'asc' } });
    expect(sorted.ok).toBe(false);
    if (!sorted.ok) expect(sorted.error.code).toBe('VALIDATION_FAILED');
  });

  it('settles on the exact row count from the background count', async () => {
    // The count runs on a pooled client so it cannot block paging; poll for it.
    let current = h.queries.meta(resultId);
    for (let i = 0; i < 60 && (!current.ok || current.value.rowCountIsEstimate); i += 1) {
      await sleep(250);
      current = h.queries.meta(resultId);
    }
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.value.rowCount).toBe(10_000_000);
    expect(current.value.rowCountIsEstimate).toBe(false);
  }, 60_000);
});

describe.skipIf(!pgConfigured)('live postgres · cancellation', () => {
  let h: Harness;

  beforeAll(async () => {
    h = createHarness();
    await h.connections.open(CONNECTION_ID);
  }, 30_000);

  afterAll(async () => {
    await h?.dispose();
  });

  it('returns the caller to responsive within 200ms and fails the in-flight query', async () => {
    // `pg_sleep` in the target list is evaluated per output row, so this streams:
    // the first row lands in ~50ms and the rest take ~50s. A set-returning SQL
    // function would materialise instead and there would be nothing in flight to
    // cancel — which is why the query is written out here rather than fixtured.
    const run = await runOk(
      h,
      'select g as n, pg_sleep(0.05) as waited from generate_series(1, 1000) as g',
      1,
    );

    const inFlight = h.queries.window({ resultId: run.resultId, startRow: 1, rowCount: 5_000 });
    // Do not await: the point is to cancel while the server is still working.
    const settled = inFlight.then((result) => result);
    await sleep(500);

    const started = now();
    const cancelled = await h.queries.cancel(run.resultId);
    const cancelElapsed = now() - started;

    expect(cancelled.ok, cancelled.ok ? '' : cancelled.error.message).toBe(true);
    report('queryCancel round trip', cancelElapsed);
    expect(cancelElapsed, `${cancelElapsed}ms`).toBeLessThan(200);

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('QUERY_CANCELLED');
      expect(outcome.error.sqlState).toBe('57014');
    }

    h.queries.dispose(run.resultId);
  }, 60_000);

  it('reports an unknown result id rather than throwing', async () => {
    const result = await h.queries.cancel('does-not-exist');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RESULT_NOT_FOUND');
  });

  it('cancels a query that has not produced its first page yet', async () => {
    // The actual runaway case from the UI: the user is staring at a spinner, and
    // the result is **not in the registry** because no rows have arrived. Before
    // Phase 7 this answered RESULT_NOT_FOUND — the cancel button did nothing
    // exactly when it was needed. The renderer learns the id from the `planning`
    // progress event, which main emits before it acquires a client.
    const from = h.events.length;
    const running = h.queries.run({
      connectionId: CONNECTION_ID,
      sql: 'select g as n, pg_sleep(0.05) as waited from generate_series(1, 2000) as g',
      initialRows: 2_000,
    });

    const startedAt = now();
    let resultId: string | null = null;
    while (resultId === null && now() - startedAt < 10_000) {
      const event = h.events
        .slice(from)
        .find(
          (candidate) =>
            candidate.channel === 'event:query-progress' &&
            (candidate.payload as { phase?: string }).phase === 'planning',
        );
      if (event) resultId = (event.payload as { resultId: string }).resultId;
      else await sleep(10);
    }
    expect(resultId, 'main should have announced the run before it finished').not.toBeNull();
    if (resultId === null) return;

    // Give the server something to be doing, then cancel while it is still doing it.
    await sleep(500);
    const started = now();
    const cancelled = await h.queries.cancel(resultId);
    const cancelElapsed = now() - started;
    expect(cancelled.ok, cancelled.ok ? '' : cancelled.error.message).toBe(true);
    report('queryCancel on an unregistered run', cancelElapsed);
    expect(cancelElapsed, `${cancelElapsed}ms`).toBeLessThan(200);

    const outcome = await running;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('QUERY_CANCELLED');

    // The client came back: otherwise the pool would leak one connection per
    // cancelled query, and a user who cancels ten times would exhaust it.
    expect(await idleInTransactionBackends(h)).toBe(0);
  }, 60_000);
});

describe.skipIf(!pgConfigured)('live postgres · type fidelity', () => {
  let h: Harness;
  let resultId: string;
  let meta: ResultMeta;
  let block: EncodedRowBlock;

  beforeAll(async () => {
    h = createHarness();
    await h.connections.open(CONNECTION_ID);
    const run = await runOk(h, `select * from ${SCHEMA}.type_matrix order by id`, 10);
    resultId = run.resultId;
    meta = run.meta;
    const page = await h.queries.window({ resultId, startRow: 0, rowCount: 10 });
    if (!page.ok) throw new Error(page.error.message);
    block = page.value;
  }, 60_000);

  afterAll(async () => {
    if (resultId) h?.queries.dispose(resultId);
    await h?.dispose();
  });

  it('reads every column of the fixture row', () => {
    expect(cell(block, meta, 'c_int2', 0)).toMatchObject({ kind: 'number', value: 1 });
    expect(cell(block, meta, 'c_int4', 0)).toMatchObject({ kind: 'number', value: 2 });
    expect(cell(block, meta, 'c_float4', 0)).toMatchObject({ kind: 'number', value: 1.5 });
    expect(cell(block, meta, 'c_float8', 0)).toMatchObject({ kind: 'number', value: 2.5 });
    expect(cell(block, meta, 'c_bool', 0)).toEqual({ kind: 'bool', value: true });
    expect(cell(block, meta, 'c_text', 0)).toEqual({ kind: 'text', value: 'plain' });
    expect(cell(block, meta, 'c_varchar', 0)).toEqual({ kind: 'text', value: 'vc' });
    expect(cell(block, meta, 'c_uuid', 0)).toEqual({
      kind: 'text',
      value: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    });
    expect(cell(block, meta, 'c_array', 0)).toEqual({ kind: 'text', value: '{1,2,3}' });
    expect(cell(block, meta, 'c_interval', 0)).toEqual({
      kind: 'text',
      value: '1 day 02:03:04',
    });
  });

  it('keeps int8 and numeric exact past 2^53', () => {
    const int8 = cell(block, meta, 'c_int8', 0);
    expect(int8).toMatchObject({ kind: 'number', raw: '9007199254740993' });
    if (int8.kind === 'number') {
      // The double has rounded; this is exactly why `raw` exists and why the grid
      // renders from it.
      expect(String(int8.value)).not.toBe(int8.raw);
    }

    expect(cell(block, meta, 'c_numeric', 0)).toMatchObject({
      raw: '12345678901234567890.1234567890',
    });
  });

  it('reads a timestamp without timezone as the wall clock it displays', () => {
    const stamp = cell(block, meta, 'c_timestamp', 0);
    expect(stamp).toEqual({ kind: 'time', epochMs: Date.UTC(2026, 9, 1, 12, 34, 56), tz: '' });
    // The host timezone is Asia/Jakarta (UTC+7). A local-time parse would have
    // produced 05:34:56Z and shown the user a different time than psql shows.
    expect(stamp).not.toEqual({
      kind: 'time',
      epochMs: Date.UTC(2026, 9, 1, 5, 34, 56),
      tz: '',
    });
  });

  it('reads a timestamptz as the instant the server meant', () => {
    // Stored as 12:34:56+07:00, which is 05:34:56Z.
    expect(cell(block, meta, 'c_timestamptz', 0)).toEqual({
      kind: 'time',
      epochMs: Date.UTC(2026, 9, 1, 5, 34, 56),
      tz: 'UTC',
    });
  });

  it('keeps a bare date on its own calendar day', () => {
    expect(cell(block, meta, 'c_date', 0)).toEqual({ kind: 'text', value: '2026-10-01' });
    expect(cell(block, meta, 'c_date', 2)).toEqual({ kind: 'text', value: '0001-01-01' });
  });

  it('round-trips bytea, json and padded char', () => {
    const bytea = cell(block, meta, 'c_bytea', 0);
    expect(bytea.kind).toBe('binary');
    if (bytea.kind === 'binary') {
      expect(bytea.byteLength).toBe(3);
      expect([...bytea.preview]).toEqual([0, 1, 255]);
    }

    // `json` preserves the stored text exactly; `jsonb` re-renders it normalised.
    // Both come back as the server's own text, not a JS round-trip of it.
    expect(cell(block, meta, 'c_json', 0)).toEqual({
      kind: 'json',
      preview: '{"k":1}',
      byteLength: 7,
    });
    expect(cell(block, meta, 'c_jsonb', 0)).toEqual({
      kind: 'json',
      preview: '{"k": 2}',
      byteLength: 8,
    });

    const padded = cell(block, meta, 'c_char', 0);
    expect(padded.kind).toBe('text');
    if (padded.kind === 'text') expect(padded.value.trim()).toBe('padded');
  });

  it('preserves NULL in every data column of the all-NULL row', () => {
    // Row 2 is NULL in every column except the serial `id`, which always has a value.
    for (const column of meta.columns) {
      if (column.name === 'id') continue;
      expect(decodeCell(block.columns[columnIndex(meta, column.name)]!, 1), column.name).toEqual({
        kind: 'null',
      });
    }
    expect(cell(block, meta, 'id', 1)).toMatchObject({ kind: 'number', raw: '2' });
  });

  it('survives boundary values and escapes', () => {
    expect(cell(block, meta, 'c_int8', 2)).toMatchObject({ raw: '-9223372036854775808' });
    expect(cell(block, meta, 'c_int4', 2)).toMatchObject({ value: -2147483648 });
    expect(cell(block, meta, 'c_text', 3)).toEqual({ kind: 'text', value: 'tab\there' });
    expect(cell(block, meta, 'c_varchar', 3)).toEqual({ kind: 'text', value: 'quote"dq' });

    const ancient = cell(block, meta, 'c_timestamp', 2);
    expect(ancient.kind).toBe('time');
    if (ancient.kind === 'time') expect(new Date(ancient.epochMs).getUTCFullYear()).toBe(1);
  });
});

describe.skipIf(!pgConfigured)('live postgres · catalog introspection', () => {
  let h: Harness;

  beforeAll(async () => {
    h = createHarness();
    await h.connections.open(CONNECTION_ID);
  }, 30_000);

  afterAll(async () => {
    await h?.dispose();
  });

  it('lists user schemas and hides the system ones', async () => {
    const result = await h.schemas.childrenOf(CONNECTION_ID, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.map((node) => node.name);
    expect(names).toContain(SCHEMA);
    expect(names).toContain('fixtures_secondary');
    for (const hidden of ['pg_catalog', 'information_schema', 'pg_toast']) {
      expect(names, hidden).not.toContain(hidden);
    }
    expect(result.value.every((node) => node.kind === 'schema' && node.hasChildren)).toBe(true);
  });

  it('lists relations in a schema, typed and without TOAST tables', async () => {
    const result = await h.schemas.childrenOf(CONNECTION_ID, SCHEMA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.value.map((node) => [node.name, node]));
    expect(byName.get('big')?.kind).toBe('table');
    expect(byName.get('a_view')?.kind).toBe('view');
    expect(byName.get('a_matview')?.kind).toBe('materializedView');
    expect(byName.get('a_sequence')?.kind).toBe('sequence');
    expect(byName.get('big')?.comment).toMatch(/10M rows/);
    expect(byName.get('big')?.rowEstimate).toBeGreaterThan(1_000_000);

    for (const node of result.value) {
      expect(node.name, node.name).not.toMatch(/^pg_toast/);
      expect(node.kind).not.toBe('index');
    }
  });

  it('reads a composite primary key in index order', async () => {
    const result = await h.schemas.tableOf(CONNECTION_ID, SCHEMA, 'composite_pk');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.primaryKey).toEqual(['tenant_id', 'seq']);
    expect(result.value.columns.map((c) => c.name)).toEqual(['tenant_id', 'seq', 'note']);
    expect(result.value.columns.map((c) => c.position)).toEqual([1, 2, 3]);
    expect(result.value.columns[2]?.nullable).toBe(true);
    expect(result.value.columns[0]?.nullable).toBe(false);
  });

  it('distinguishes a usable unique index from a nullable one', async () => {
    const usable = await h.schemas.tableOf(CONNECTION_ID, SCHEMA, 'unique_index');
    expect(usable.ok).toBe(true);
    if (usable.ok) {
      expect(usable.value.primaryKey).toEqual([]);
      expect(usable.value.uniqueIndexes).toEqual([
        {
          name: 'unique_index_code_uq',
          columns: ['code'],
          isPrimary: false,
          allColumnsNotNull: true,
        },
      ]);
    }

    const nullable = await h.schemas.tableOf(CONNECTION_ID, SCHEMA, 'unique_nullable');
    expect(nullable.ok).toBe(true);
    if (nullable.ok) {
      expect(nullable.value.uniqueIndexes[0]).toMatchObject({
        columns: ['email'],
        allColumnsNotNull: false,
      });
    }
  });

  it('reports a table with no identity at all', async () => {
    const result = await h.schemas.tableOf(CONNECTION_ID, SCHEMA, 'no_identity');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.primaryKey).toEqual([]);
    expect(result.value.uniqueIndexes).toEqual([]);
  });

  it('carries column comments, defaults and type oids', async () => {
    const result = await h.schemas.tableOf(CONNECTION_ID, SCHEMA, 'type_matrix');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const int8 = result.value.columns.find((c) => c.name === 'c_int8');
    expect(int8?.comment).toMatch(/kept as a string/);
    expect(int8?.typeOid).toBe(20);
    expect(int8?.typeName).toBe('int8');

    const id = result.value.columns.find((c) => c.name === 'id');
    expect(id?.defaultExpression).toMatch(/nextval/);
    expect(result.value.comment).toBeNull();
  });

  it('chooses a pagination key only when one can actually identify a row', async () => {
    expect(await h.schemas.paginationKeyFor(CONNECTION_ID, SCHEMA, 'big')).toEqual(['id']);
    expect(await h.schemas.paginationKeyFor(CONNECTION_ID, SCHEMA, 'composite_pk')).toEqual([
      'tenant_id',
      'seq',
    ]);
    // A unique index over a nullable column cannot page reliably: NULL != NULL.
    expect(await h.schemas.paginationKeyFor(CONNECTION_ID, SCHEMA, 'unique_index')).toEqual([
      'code',
    ]);
    expect(await h.schemas.paginationKeyFor(CONNECTION_ID, SCHEMA, 'unique_nullable')).toBeNull();
    expect(await h.schemas.paginationKeyFor(CONNECTION_ID, SCHEMA, 'no_identity')).toBeNull();
  });

  it('serves a cached read, and drops the cache on refresh', async () => {
    const first = await h.schemas.childrenOf(CONNECTION_ID, SCHEMA);
    const second = await h.schemas.childrenOf(CONNECTION_ID, SCHEMA);
    expect(first.ok && second.ok).toBe(true);
    // Identity, not equality: the second call must not have hit the server.
    if (first.ok && second.ok) expect(second.value).toBe(first.value);

    expect(h.schemas.refresh(CONNECTION_ID)).toBeGreaterThan(0);
    const third = await h.schemas.childrenOf(CONNECTION_ID, SCHEMA);
    expect(third.ok).toBe(true);
    if (first.ok && third.ok) expect(third.value).not.toBe(first.value);
    expect(h.schemas.refresh('unknown-connection')).toBe(0);
  });

  it('reports a missing table as RELATION_NOT_FOUND', async () => {
    const result = await h.schemas.tableOf(CONNECTION_ID, SCHEMA, 'no_such_table');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RELATION_NOT_FOUND');
  });

  it('queries a table whose name needs quoting', async () => {
    for (const table of ['Mixed Case', 'has space', 'with"dquote', 'unicode_ünïcødé']) {
      const sql = selectFromTableSql(SCHEMA, table, 5);
      const run = await h.queries.run({ connectionId: CONNECTION_ID, sql, initialRows: 5 });
      expect(run.ok, `${table}: ${run.ok ? '' : run.error.message}`).toBe(true);
      if (!run.ok) continue;

      const page = await h.queries.window({
        resultId: run.value.resultId,
        startRow: 0,
        rowCount: 5,
      });
      expect(page.ok, `${table}: ${page.ok ? '' : page.error.message}`).toBe(true);
      if (page.ok) {
        expect(page.value.rowCount).toBe(1);
        expect(decodeCell(page.value.columns[1]!, 0)).toMatchObject({ kind: 'text' });
      }
      h.queries.dispose(run.value.resultId);
    }
  }, 60_000);

  it('queries a table whose column names are reserved words', async () => {
    const run = await runOk(h, `select "select", "from" from ${SCHEMA}.reserved_word`, 5);
    expect(run.meta.columns.map((c) => c.name)).toEqual(['select', 'from']);
    h.queries.dispose(run.resultId);
  });
});

describe.skipIf(!pgConfigured)('live postgres · registry memory cap soak', () => {
  let h: Harness;
  let registry: ResultRegistry<LiveResult>;
  const MAX_BYTES = 400_000;
  const MAX_ENTRIES = 3;

  beforeAll(async () => {
    // Bounds are injected; the registry is not. Ownership stays with the service
    // because eviction is what closes cursors and returns their pooled clients.
    h = createHarness({
      limits: {
        maxEntries: MAX_ENTRIES,
        ttlMs: Number.POSITIVE_INFINITY,
        maxBytes: MAX_BYTES,
      },
    });
    registry = h.queries.registry;
    await h.connections.open(CONNECTION_ID);
  }, 30_000);

  afterAll(async () => {
    registry.clear();
    await h?.dispose();
  });

  it('never exceeds its caps across many results and windows', async () => {
    const ids: string[] = [];

    for (let round = 0; round < 12; round += 1) {
      const run = await h.queries.run({
        connectionId: CONNECTION_ID,
        sql: `select * from ${SCHEMA}.big where bucket = ${round % 97}`,
        initialRows: 1_000,
      });
      expect(run.ok, run.ok ? '' : run.error.message).toBe(true);
      if (!run.ok) return;
      ids.push(run.value.resultId);

      // The invariant, checked after every single insert rather than at the end:
      // a cap that is only true once the churn settles is not a cap.
      expect(registry.size(), `round ${round}`).toBeLessThanOrEqual(MAX_ENTRIES);
      expect(registry.totalBytes(), `round ${round}`).toBeLessThanOrEqual(MAX_BYTES);

      for (const startRow of [0, 500, 40_000, 5]) {
        const page = await h.queries.window({
          resultId: run.value.resultId,
          startRow,
          rowCount: 200,
        });
        expect(page.ok, `round ${round} row ${startRow}`).toBe(true);
        expect(registry.totalBytes()).toBeLessThanOrEqual(MAX_BYTES);
      }
    }

    // Oldest results were evicted, and the renderer was told so it can say
    // "result expired — re-run query" instead of showing blank cells.
    const evicted = h.events.filter((event) => event.channel === 'event:result-evicted');
    expect(evicted.length).toBeGreaterThan(0);

    // Payload shape pinned at runtime. `TabbyEvents` and main's emitter were once
    // typed independently and disagreed — main sent `{resultId, reason}` while the
    // preload declared a bare `string`. Both now derive from `MainEventMap`; this
    // is the assertion that catches a regression the compiler could not.
    for (const event of evicted) {
      const payload = event.payload as { resultId?: unknown; reason?: unknown };
      expect(typeof payload.resultId).toBe('string');
      expect(['capacity', 'expired']).toContain(payload.reason);
    }
    expect(registry.size()).toBeLessThanOrEqual(MAX_ENTRIES);

    const oldest = await h.queries.window({ resultId: ids[0]!, startRow: 0, rowCount: 10 });
    expect(oldest.ok).toBe(false);
    if (!oldest.ok) expect(oldest.error.code).toBe('RESULT_EVICTED');

    const newest = await h.queries.window({
      resultId: ids[ids.length - 1]!,
      startRow: 0,
      rowCount: 10,
    });
    expect(newest.ok).toBe(true);
  }, 300_000);

  it('released every evicted cursor, so no backends are left holding a transaction', async () => {
    registry.clear();
    await sleep(300);
    expect(await idleInTransactionBackends(h)).toBe(0);
  }, 30_000);
});

/**
 * Phase 6 exit criteria: the object tree matches `psql`'s `\d+` for a sample
 * table, and a schema with 2,000 relations reads in one go.
 *
 * Every expected string below was copied out of a real PostgreSQL 18.6 server
 * rather than derived from the queries that produce it — column types,
 * nullability, defaults and descriptions from `\d+ fixtures.detail_sample`, and
 * index and constraint definitions from `pg_get_indexdef` / `pg_get_constraintdef`
 * directly, because psql **reformats** those two and the pane shows the catalog
 * functions' text. Deriving expectations from our own SQL is how a mapper that
 * agrees with itself and disagrees with the server gets shipped.
 */
describe.skipIf(!pgConfigured)('live postgres · schema explorer', () => {
  let h: Harness;
  const DETAIL_TABLE = 'detail_sample';
  const MANY_SCHEMA = 'fixtures_many';

  beforeAll(async () => {
    h = createHarness();
    await h.connections.open(CONNECTION_ID);
  }, 30_000);

  afterAll(async () => {
    await h?.dispose();
  });

  it('reads a table exactly as \\d+ reports it', async () => {
    const result = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, DETAIL_TABLE);
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    const detail = result.value;

    expect(detail.kind).toBe('table');
    expect(detail.meta.name).toBe(DETAIL_TABLE);
    expect(detail.meta.comment).toBe('the detail-pane comparison fixture');

    // The Type column of `\d+`, verbatim. `pg_type.typname` would have said
    // `varchar` and `numeric`, losing the modifiers that define the column.
    expect(detail.meta.columns.map((column) => [column.name, column.formattedType])).toEqual([
      ['id', 'bigint'],
      ['tenant_id', 'integer'],
      ['code', 'character varying(64)'],
      ['label', 'character varying(255)'],
      ['amount', 'numeric(12,4)'],
      ['created_at', 'timestamp with time zone'],
      ['note', 'text'],
    ]);

    // The Nullable column of `\d+`.
    expect(detail.meta.columns.map((column) => column.nullable)).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      true,
    ]);

    // The Default column of `\d+`, which is `pg_get_expr(adbin, adrelid)`.
    expect(detail.meta.columns.map((column) => column.defaultExpression)).toEqual([
      null,
      '1',
      null,
      null,
      '0',
      'now()',
      null,
    ]);

    // The Description column, including one that spans two lines.
    const byName = new Map(detail.meta.columns.map((column) => [column.name, column]));
    expect(byName.get('id')?.comment).toBe('surrogate key');
    expect(byName.get('amount')?.comment).toBe('non-negative, enforced by a check');
    expect(byName.get('note')?.comment).toBe(
      'nullable on purpose\nso the partial index has rows to exclude',
    );
    expect(byName.get('label')?.comment).toBeNull();
  }, 30_000);

  it('lists every index \\d+ lists, including the expression and partial ones', async () => {
    const result = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, DETAIL_TABLE);
    if (!result.ok) return;

    const names = result.value.indexes.map((index) => index.name);
    expect(names).toEqual([
      'detail_sample_pkey',
      'detail_sample_code_uq',
      'detail_sample_label_idx',
      'detail_sample_lower_code_idx',
      'detail_sample_partial_uq',
    ]);

    const byName = new Map(result.value.indexes.map((index) => [index.name, index]));
    expect(byName.get('detail_sample_pkey')).toMatchObject({ isPrimary: true, isUnique: true });
    expect(byName.get('detail_sample_label_idx')).toMatchObject({
      isPrimary: false,
      isUnique: false,
    });
    // `pg_get_indexdef` renders the expression the way the server stores it. This
    // is **not** what `\d+` prints: psql drops the `CREATE … USING` prefix and
    // shows `lower(code::text)`, while the catalog function returns the fully
    // parenthesised `lower((code)::text)`. Same meaning, different text. Pinned to
    // the function, because that is what Tabby displays.
    expect(byName.get('detail_sample_lower_code_idx')?.definition).toBe(
      'CREATE INDEX detail_sample_lower_code_idx ON fixtures.detail_sample USING btree (lower((code)::text))',
    );
    expect(byName.get('detail_sample_partial_uq')?.definition).toBe(
      'CREATE UNIQUE INDEX detail_sample_partial_uq ON fixtures.detail_sample USING btree (tenant_id) WHERE (note IS NOT NULL)',
    );
  }, 30_000);

  it('gives row identity and the detail pane different answers about the partial index', async () => {
    // One object, two correct answers. `uniqueIndexes` feeds paging and the v2 row
    // identity, where a partial unique index is unusable — it is only unique among
    // rows matching the predicate. `indexes` feeds the pane, where hiding it would
    // hide the reason a duplicate insert was rejected.
    const detail = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, DETAIL_TABLE);
    if (!detail.ok) return;
    const uniqueNames = detail.value.meta.uniqueIndexes.map((index) => index.name);
    expect(uniqueNames).toContain('detail_sample_pkey');
    expect(uniqueNames).toContain('detail_sample_code_uq');
    expect(uniqueNames).not.toContain('detail_sample_partial_uq');
    expect(uniqueNames).not.toContain('detail_sample_lower_code_idx');

    expect(detail.value.indexes.map((index) => index.name)).toContain('detail_sample_partial_uq');
    expect(await h.schemas.paginationKeyFor(CONNECTION_ID, SCHEMA, DETAIL_TABLE)).toEqual(['id']);
  }, 30_000);

  it('lists constraints by kind, and drops the NOT NULL rows PostgreSQL 18 adds', async () => {
    const result = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, DETAIL_TABLE);
    if (!result.ok) return;

    const byName = new Map(result.value.constraints.map((c) => [c.name, c]));
    expect(byName.get('detail_sample_pkey')?.kind).toBe('primary');
    expect(byName.get('detail_sample_code_uq')?.kind).toBe('unique');
    expect(byName.get('detail_sample_amount_chk')?.kind).toBe('check');
    expect(byName.get('detail_sample_tenant_fk')?.kind).toBe('foreign');

    // `\d+` prints a whole "Not-null constraints" section on 18. Tabby does not:
    // the Nullable column already says it, and listing both would show every
    // NOT NULL column twice.
    expect(result.value.constraints).toHaveLength(4);
    expect(result.value.constraints.every((c) => !c.definition.startsWith('NOT NULL'))).toBe(true);

    // Definitions are `pg_get_constraintdef` output, verbatim — not a
    // reconstruction that happens to look similar. It is also not byte-identical to
    // `\d+`: psql prints `CHECK (amount >= 0::numeric)` where the catalog function
    // returns the fully parenthesised form below. Tabby shows the function's text,
    // because that is the version guaranteed to re-parse.
    expect(byName.get('detail_sample_amount_chk')?.definition).toBe(
      'CHECK ((amount >= (0)::numeric))',
    );
    expect(byName.get('detail_sample_tenant_fk')?.definition).toBe(
      'FOREIGN KEY (tenant_id) REFERENCES fixtures.plain_table(id)',
    );
    expect(byName.get('detail_sample_pkey')?.definition).toBe('PRIMARY KEY (id)');
    expect(byName.get('detail_sample_code_uq')?.definition).toBe('UNIQUE (code)');
  }, 30_000);

  it('generates DDL that quotes every name and keeps type modifiers', async () => {
    const result = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, DETAIL_TABLE);
    if (!result.ok) return;
    const ddl = result.value.ddl;

    expect(ddl.length).toBeGreaterThan(0);
    const create = ddl[0] ?? '';
    expect(create.startsWith('create table "fixtures"."detail_sample" (')).toBe(true);
    expect(create).toContain('"label" character varying(255)');
    expect(create).toContain('"amount" numeric(12,4) default 0');
    expect(create).toContain('"created_at" timestamp with time zone not null default now()');
    expect(create).toContain('constraint "detail_sample_pkey" PRIMARY KEY (id)');
    expect(create.endsWith(');')).toBe(true);

    // One terminating semicolon per statement. The multi-line comment must come
    // out in the E'' form, or the newline would end the literal early and the rest
    // of the text would be parsed as SQL.
    const statements = ddl.filter((statement) => statement.includes('comment on'));
    expect(statements).toHaveLength(4);
    for (const statement of statements) {
      expect(statement.endsWith(';'), statement).toBe(true);
      expect(statement.slice(0, -1).endsWith(';'), statement).toBe(false);
    }

    const noteComment = statements.find((statement) => statement.includes('"note"')) ?? '';
    expect(noteComment).toContain(`is E'nullable on purpose\\nso the partial index`);
    // The single-line ones stay in the plain form: no reason to make a user read
    // escape syntax where none is needed.
    const idComment = statements.find((statement) => statement.includes('"id"')) ?? '';
    expect(idComment).toBe(`comment on column "fixtures"."detail_sample"."id" is 'surrogate key';`);
    expect(ddl).toContain(
      `comment on table "fixtures"."detail_sample" is 'the detail-pane comparison fixture';`,
    );
  }, 30_000);

  it('generates DDL for a table whose name needs quoting', async () => {
    const result = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, 'with"dquote');
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    // Doubling the embedded quote is what makes the statement safe to paste back.
    expect(result.value.ddl[0]).toContain('create table "fixtures"."with""dquote"');
  }, 30_000);

  it('reads a view body from pg_get_viewdef, without doubling the semicolon', async () => {
    const result = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, 'a_view');
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('view');
    expect(result.value.ddl).toHaveLength(1);
    const statement = result.value.ddl[0] ?? '';
    expect(statement.startsWith('create view "fixtures"."a_view" as')).toBe(true);
    expect(statement.endsWith(';;')).toBe(false);
    expect(statement).toMatch(/FROM fixtures\.plain_table;$/);
  }, 30_000);

  it('generates no DDL for a sequence, whose parameters it does not read', async () => {
    const result = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, 'a_sequence');
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('sequence');
    // `create sequence "fixtures"."a_sequence";` would be valid and wrong — it
    // would silently drop the start, increment and cache the real one has.
    expect(result.value.ddl).toEqual([]);
  }, 30_000);

  it('reports a missing relation as RELATION_NOT_FOUND', async () => {
    const result = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, 'no_such_relation');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RELATION_NOT_FOUND');
  }, 30_000);

  it('serves a cached detail, and drops it on refresh along with the tree', async () => {
    const first = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, DETAIL_TABLE);
    const second = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, DETAIL_TABLE);
    expect(first.ok && second.ok).toBe(true);
    // Identity, not equality: the second call must not have hit the server.
    if (first.ok && second.ok) expect(second.value).toBe(first.value);

    const droppedBefore = h.schemas.refresh(CONNECTION_ID);
    expect(droppedBefore).toBeGreaterThan(0);

    const third = await h.schemas.detailOf(CONNECTION_ID, SCHEMA, DETAIL_TABLE);
    expect(third.ok).toBe(true);
    if (first.ok && third.ok) expect(third.value).not.toBe(first.value);
  }, 60_000);

  it('reads 2,000 relations in one schema', async () => {
    const started = now();
    const result = await h.schemas.childrenOf(CONNECTION_ID, MANY_SCHEMA);
    const elapsed = now() - started;
    report(`childrenOf(${MANY_SCHEMA}) — 2000 relations`, elapsed);

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2_000);
    expect(result.value.every((node) => node.kind === 'table' && !node.hasChildren)).toBe(true);
    expect(result.value[0]?.name).toBe('t0000');
    expect(result.value[1_999]?.name).toBe('t1999');
    // Ordered by the server, so the renderer never has to sort 2,000 strings.
    const names = result.value.map((node) => node.name);
    expect(names).toEqual([...names].sort());
    // A flat read of a whole schema must not be a per-row round trip.
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);

  it('caches that read, so re-expanding the schema costs nothing', async () => {
    const first = await h.schemas.childrenOf(CONNECTION_ID, MANY_SCHEMA);
    const started = now();
    const second = await h.schemas.childrenOf(CONNECTION_ID, MANY_SCHEMA);
    const elapsed = now() - started;
    report(`childrenOf(${MANY_SCHEMA}) — cached`, elapsed);
    if (first.ok && second.ok) expect(second.value).toBe(first.value);
    expect(elapsed).toBeLessThan(50);
  }, 30_000);
});
