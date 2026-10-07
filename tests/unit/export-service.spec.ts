/**
 * The export service (PLAN Phase 8).
 *
 * Tier 2 — an adapter over the pool, the filesystem and the event bridge — so
 * written after the implementation. The serialisation it feeds is Tier 1 and
 * test-first in `export-serialise.spec.ts`; what only this level can show is the
 * lifecycle around it, and every case here is a way an export can go wrong without
 * the serialiser ever being at fault:
 *
 *  - a **cancel keeps** the rows already written, a **failure deletes** the file;
 *  - a failure *before* the stream opened must not delete something else;
 *  - the loop really does page, so peak memory is one batch and not the result;
 *  - the client comes back to the pool on every path, or `pool.end()` hangs;
 *  - the concurrency cap refuses rather than queueing invisibly.
 *
 * One limitation of the fake, stated rather than hidden: a single `harness()` has
 * one fake client, so two concurrent exports share it and split its rows between
 * them. That is fine for the cap and teardown cases, which assert on `activeCount`
 * and on release rather than on row counts, and it would be wrong for anything else.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ColumnMeta } from '@shared/domain';
import type { Result } from '@shared/errors';
import type {
  ExportProgressEvent,
  ExportStartResponse,
  MainEventEmitter,
} from '@shared/ipc-contract';
import { EXPORT_BATCH_ROWS, defaultExportOptions, type ExportFormat } from '@shared/export';
import { OID } from '@shared/pg-types';
import { ExportService, MAX_CONCURRENT_EXPORTS } from '../../src/main/export/export-service';
import type { ConnectionManager } from '../../src/main/db/connection-manager';
import type { PgClientHandle } from '../../src/main/db/driver-pg';
import type { ExportDescription, QueryService } from '../../src/main/db/query-service';

const COLUMNS: readonly ColumnMeta[] = [
  { name: 'id', typeName: 'int4', typeOid: OID.int4, nullable: false, widthHint: 90 },
  { name: 'name', typeName: 'text', typeOid: OID.text, nullable: true, widthHint: 220 },
];

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

interface FakeHandle extends PgClientHandle {
  readonly statements: string[];
  released: boolean;
}

interface FakeOptions {
  /** Total rows the cursor will yield before returning a short page. */
  readonly rows?: number;
  /** Milliseconds to stall on each FETCH, so a cancel can land mid-stream. */
  readonly fetchDelayMs?: number;
  /** Throw on the Nth FETCH (1-based) instead of returning rows. */
  readonly failOnFetch?: number;
  /** Throw from `acquire()` rather than handing back a client. */
  readonly refuseAcquire?: boolean;
}

function fakeSession(options: FakeOptions = {}): {
  readonly handle: FakeHandle;
  readonly cancelledPids: number[];
  readonly session: unknown;
} {
  const total = options.rows ?? 0;
  const state = { produced: 0, fetches: 0 };
  const handle: FakeHandle = {
    statements: [],
    released: false,
    backendPid: 4242,
    async query(text: string) {
      handle.statements.push(text);
      if (!text.startsWith('FETCH')) return { rows: [], fields: [], rowCount: 0 };

      state.fetches += 1;
      if (options.fetchDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.fetchDelayMs));
      }
      if (options.failOnFetch === state.fetches) {
        throw Object.assign(new Error('server closed the connection'), { code: '08006' });
      }

      const asked = Number(/FETCH (\d+)/.exec(text)?.[1] ?? 0);
      const take = Math.max(0, Math.min(asked, total - state.produced));
      const rows: (readonly unknown[])[] = [];
      for (let index = 0; index < take; index += 1) {
        const id = state.produced + index;
        rows.push([id, `row-${id}`]);
      }
      state.produced += take;
      return { rows, fields: [], rowCount: take };
    },
    release() {
      handle.released = true;
    },
  };

  const cancelledPids: number[] = [];
  const session = {
    backendPid: 4242,
    serverVersion: '18.6',
    query: async () => ({ rows: [], fields: [], rowCount: 0 }),
    acquire: async (): Promise<PgClientHandle> => {
      if (options.refuseAcquire) {
        throw Object.assign(new Error('timeout exceeded when trying to connect'), {
          code: 'ETIMEDOUT',
        });
      }
      return handle;
    },
    cancel: async (pid: number) => {
      cancelledPids.push(pid);
      return ok(undefined);
    },
    end: async () => undefined,
  };
  return { handle, cancelledPids, session };
}

interface Harness {
  readonly service: ExportService;
  readonly events: ExportProgressEvent[];
  readonly picked: string[];
  readonly handle: FakeHandle;
  readonly cancelledPids: number[];
}

let dir: string;
let nextId: number;
let pickResult: string | null;
let description: ExportDescription;

function harness(options: FakeOptions = {}): Harness {
  const fake = fakeSession(options);
  const events: ExportProgressEvent[] = [];
  const picked: string[] = [];
  // Cast at the boundary: `MainEventEmitter` is generic over the channel, so a
  // recorder that only wants export payloads cannot be written as a plain arrow.
  const emit = ((_channel: string, payload: unknown) => {
    events.push(payload as ExportProgressEvent);
  }) as unknown as MainEventEmitter;

  return {
    events,
    picked,
    handle: fake.handle,
    cancelledPids: fake.cancelledPids,
    service: new ExportService({
      // Structural fakes: the service only ever calls these members, and casting at
      // the boundary keeps the test honest about what it actually exercises.
      connections: {
        session: () => fake.session,
        requireSession: async () => ok(fake.session),
      } as unknown as ConnectionManager,
      queries: {
        exportDescription: () => ok(description),
      } as unknown as QueryService,
      emit,
      pickPath: async (suggested) => {
        picked.push(suggested);
        return pickResult;
      },
      newExportId: () => `x${(nextId += 1)}`,
    }),
  };
}

/** Starts an export that is expected to begin, and unwraps its handle. */
async function begin(target: Harness, format: ExportFormat = 'csv'): Promise<ExportStartResponse> {
  const result = await target.service.start({
    resultId: 'r1',
    options: defaultExportOptions(format),
  });
  if (!result.ok) throw new Error(`export failed to start: ${result.error.code}`);
  if (result.value === null) throw new Error('the save dialog was dismissed');
  return result.value;
}

/** Waits for a terminal progress event, which is when the file is final. */
async function settle(target: Harness, exportId: string): Promise<ExportProgressEvent> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const found = target.events.find(
      (event) => event.exportId === exportId && event.phase !== 'streaming',
    );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`export ${exportId} never settled; saw ${JSON.stringify(target.events)}`);
}

/** Waits until at least one batch has been written, so a cancel is mid-flight. */
async function firstBatch(target: Harness): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (target.events.some((event) => event.phase === 'streaming')) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no batch was ever written');
}

/** Record lines of a delimited file, excluding the trailing empty split. */
function records(text: string): string[] {
  return text.split('\r\n').filter((line) => line !== '');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabby-export-'));
  nextId = 0;
  pickResult = join(dir, 'out.csv');
  description = {
    connectionId: 'c1',
    sql: 'select * from fixtures.big',
    columns: COLUMNS,
    insertTarget: { schema: 'fixtures', table: 'big' },
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a successful export', () => {
  it('writes every row and reports done with the counts', async () => {
    const target = harness({ rows: 12 });
    const export_ = await begin(target);

    const final = await settle(target, export_.exportId);
    expect(final.phase).toBe('done');
    expect(final.rowsWritten).toBe(12);
    expect(final.message).toBeNull();

    const text = readFileSync(export_.path, 'utf8');
    // BOM + header + 12 records, CRLF terminated, exactly as the serialiser says.
    expect(text.startsWith('\uFEFFid,name\r\n')).toBe(true);
    expect(records(text)).toHaveLength(13);
    expect(text).toContain('11,row-11');
    expect(statSync(export_.path).size).toBe(final.bytesWritten);
  });

  it('returns the path, the file name and the derived INSERT target', async () => {
    const target = harness({ rows: 1 });
    const export_ = await begin(target, 'sql');
    expect(export_.path).toBe(join(dir, 'out.csv'));
    expect(export_.fileName).toBe('out.csv');
    expect(export_.format).toBe('sql');
    expect(export_.insertTarget).toBe('"fixtures"."big"');
    await settle(target, export_.exportId);
  });

  it('reports no INSERT target for a result that is not a table scan', async () => {
    description = { ...description, insertTarget: null };
    const target = harness({ rows: 1 });
    const export_ = await begin(target, 'json');
    expect(export_.insertTarget).toBeNull();
    await settle(target, export_.exportId);
  });

  it('suggests a file name taken from the table, not from the SQL', async () => {
    const target = harness({ rows: 1 });
    const export_ = await begin(target);
    expect(target.picked).toEqual(['big.csv']);
    await settle(target, export_.exportId);
  });

  it('suggests "export.<format>" for a result that is not a table scan', async () => {
    description = { ...description, insertTarget: null };
    const target = harness({ rows: 1 });
    const export_ = await begin(target, 'json');
    expect(target.picked).toEqual(['export.json']);
    await settle(target, export_.exportId);
  });

  it('pages the cursor rather than fetching the whole result at once', async () => {
    // This is the memory property: 10,100 rows arrive as three FETCHes, so peak
    // main heap is one batch. A single FETCH of everything would pass every other
    // assertion here and still blow up on a real table.
    const total = EXPORT_BATCH_ROWS * 2 + 100;
    const target = harness({ rows: total });
    const export_ = await begin(target);

    const final = await settle(target, export_.exportId);
    expect(final.rowsWritten).toBe(total);
    expect(target.handle.statements.filter((sql) => sql.startsWith('FETCH'))).toHaveLength(3);
    expect(records(readFileSync(export_.path, 'utf8'))).toHaveLength(total + 1);
  });

  it('opens a transaction and a cursor, and closes both on the way out', async () => {
    const target = harness({ rows: 1 });
    const export_ = await begin(target);
    await settle(target, export_.exportId);

    const statements = target.handle.statements;
    expect(statements[0]).toMatch(/^begin isolation level repeatable read/i);
    expect(statements.some((sql) => sql.startsWith('DECLARE'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('CLOSE'))).toBe(true);
    expect(statements[statements.length - 1]).toMatch(/^rollback/i);
  });

  it('returns the client to the pool', async () => {
    const target = harness({ rows: 1 });
    const export_ = await begin(target);
    await settle(target, export_.exportId);
    // `pool.end()` waits for every checked-out client, so a missed release is a
    // hang at shutdown rather than a visible error.
    expect(target.handle.released).toBe(true);
  });

  it('emits streaming progress, and never lets the count go backwards', async () => {
    const target = harness({ rows: EXPORT_BATCH_ROWS + 10 });
    const export_ = await begin(target);
    await settle(target, export_.exportId);

    const streaming = target.events.filter((event) => event.phase === 'streaming');
    expect(streaming.length).toBeGreaterThanOrEqual(2);
    const counts = streaming.map((event) => event.rowsWritten);
    expect(counts).toEqual([...counts].sort((left, right) => left - right));
  });

  it('writes each format through the same loop', async () => {
    for (const format of ['csv', 'tsv', 'json', 'sql'] as const) {
      pickResult = join(dir, `out.${format}`);
      const target = harness({ rows: 3 });
      const export_ = await begin(target, format);
      const final = await settle(target, export_.exportId);

      expect(final.phase).toBe('done');
      expect(final.rowsWritten).toBe(3);
      expect(existsSync(export_.path)).toBe(true);
      expect(statSync(export_.path).size).toBeGreaterThan(0);
    }
  });

  it('refuses at the cap rather than queueing silently', async () => {
    // A slow export so the cap is actually reached.
    const target = harness({ rows: EXPORT_BATCH_ROWS * 3, fetchDelayMs: 60 });
    for (let index = 0; index < MAX_CONCURRENT_EXPORTS; index += 1) {
      pickResult = join(dir, `slow-${index}.csv`);
      await begin(target);
    }
    expect(target.service.activeCount).toBe(MAX_CONCURRENT_EXPORTS);

    pickResult = join(dir, 'refused.csv');
    const refused = await target.service.start({
      resultId: 'r1',
      options: defaultExportOptions('csv'),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('EXPORT_BUSY');
    // Refusing must not have created the file the dialog would have named.
    expect(existsSync(join(dir, 'refused.csv'))).toBe(false);

    await target.service.cancelAll();
    expect(target.service.activeCount).toBe(0);
  });
});

describe('a dismissed dialog', () => {
  it('is not an error, and writes nothing', async () => {
    pickResult = null;
    const target = harness({ rows: 5 });
    const result = await target.service.start({
      resultId: 'r1',
      options: defaultExportOptions('csv'),
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(target.events).toEqual([]);
    expect(target.handle.statements).toEqual([]);
    expect(target.service.activeCount).toBe(0);
    expect(existsSync(join(dir, 'out.csv'))).toBe(false);
  });
});

describe('an unknown result', () => {
  it('reports the query service’s own error and never opens a dialog', async () => {
    const failure: Result<ExportDescription> = {
      ok: false,
      error: { code: 'RESULT_NOT_FOUND', message: 'no result with id r9', resultId: 'r9' },
    };
    const fake = fakeSession();
    const picked: string[] = [];
    const service = new ExportService({
      connections: {
        session: () => fake.session,
        requireSession: async () => ok(fake.session),
      } as unknown as ConnectionManager,
      queries: { exportDescription: () => failure } as unknown as QueryService,
      emit: () => undefined,
      pickPath: async (suggested) => {
        picked.push(suggested);
        return join(dir, suggested);
      },
    });

    const result = await service.start({ resultId: 'r9', options: defaultExportOptions('csv') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RESULT_NOT_FOUND');
    // No dialog for something that cannot be exported.
    expect(picked).toEqual([]);
  });
});

describe('cancelling mid-flight', () => {
  it('keeps the rows already written, and the file says exactly how many', async () => {
    const target = harness({ rows: EXPORT_BATCH_ROWS * 4, fetchDelayMs: 40 });
    const export_ = await begin(target);
    await firstBatch(target);

    expect((await target.service.cancel(export_.exportId)).ok).toBe(true);
    const final = await settle(target, export_.exportId);

    expect(final.phase).toBe('cancelled');
    expect(final.rowsWritten).toBeGreaterThan(0);
    expect(final.rowsWritten).toBeLessThan(EXPORT_BATCH_ROWS * 4);
    expect(final.message).toBeNull();

    // The file survives, because stopping was the user's decision — and it holds
    // exactly the rows the terminal event claims, which is the assertion that
    // distinguishes "kept the partial file" from "kept a file that lies".
    expect(existsSync(export_.path)).toBe(true);
    const text = readFileSync(export_.path, 'utf8');
    expect(text.startsWith('\uFEFFid,name\r\n')).toBe(true);
    expect(records(text)).toHaveLength(final.rowsWritten + 1);
    expect(target.handle.released).toBe(true);
  });

  it('signals the backend so a slow FETCH does not have to finish first', async () => {
    const target = harness({ rows: EXPORT_BATCH_ROWS * 4, fetchDelayMs: 40 });
    const export_ = await begin(target);

    await target.service.cancel(export_.exportId);
    await settle(target, export_.exportId);
    expect(target.cancelledPids).toEqual([4242]);
  });

  it('reports NOT_FOUND for an export that has already finished', async () => {
    const target = harness({ rows: 3 });
    const export_ = await begin(target);
    await settle(target, export_.exportId);

    const result = await target.service.cancel(export_.exportId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('answers NOT_FOUND for an id that never existed', async () => {
    const target = harness({ rows: 1 });
    const result = await target.service.cancel('never-existed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('failing mid-flight', () => {
  it('deletes the partial file, because a truncated CSV looks complete', async () => {
    const target = harness({ rows: EXPORT_BATCH_ROWS * 3, failOnFetch: 2 });
    const export_ = await begin(target);

    const final = await settle(target, export_.exportId);
    expect(final.phase).toBe('failed');
    expect(final.message).not.toBeNull();
    expect(final.bytesWritten).toBe(0);
    expect(existsSync(export_.path)).toBe(false);
    expect(target.handle.released).toBe(true);
  });

  it('does not delete a file it never opened', async () => {
    // The user picked a destination that already exists and the export failed
    // before the stream was created. Overwriting it was authorised by the dialog;
    // deleting it was not.
    const existing = join(dir, 'precious.csv');
    writeFileSync(existing, 'id,name\r\n1,keep me\r\n', 'utf8');
    pickResult = existing;

    const target = harness({ refuseAcquire: true });
    const export_ = await begin(target);
    const final = await settle(target, export_.exportId);

    expect(final.phase).toBe('failed');
    expect(existsSync(existing)).toBe(true);
    expect(readFileSync(existing, 'utf8')).toContain('keep me');
  });

  it('reports failed when the pool cannot hand out a client at all', async () => {
    pickResult = join(dir, 'never-written.csv');
    const target = harness({ refuseAcquire: true });
    const export_ = await begin(target);

    const final = await settle(target, export_.exportId);
    expect(final.phase).toBe('failed');
    expect(existsSync(pickResult)).toBe(false);
    expect(target.handle.statements).toEqual([]);
  });
});

describe('teardown', () => {
  it('drain() waits for a running export', async () => {
    const target = harness({ rows: EXPORT_BATCH_ROWS + 5, fetchDelayMs: 20 });
    const export_ = await begin(target);

    await target.service.drain();
    expect(
      target.events.some((event) => event.exportId === export_.exportId && event.phase === 'done'),
    ).toBe(true);
    expect(target.service.activeCount).toBe(0);
  });

  it('cancelAll() stops everything and leaves the pool clean', async () => {
    const target = harness({ rows: EXPORT_BATCH_ROWS * 3, fetchDelayMs: 40 });
    for (let index = 0; index < MAX_CONCURRENT_EXPORTS; index += 1) {
      pickResult = join(dir, `run-${index}.csv`);
      await begin(target);
    }
    expect(target.service.activeCount).toBe(MAX_CONCURRENT_EXPORTS);

    await target.service.cancelAll();
    expect(target.service.activeCount).toBe(0);
    expect(target.handle.released).toBe(true);
  });

  it('dropConnection() only stops the exports on that connection', async () => {
    const target = harness({ rows: EXPORT_BATCH_ROWS * 3, fetchDelayMs: 40 });
    const export_ = await begin(target);

    await target.service.dropConnection('some-other-connection');
    expect(target.service.activeCount).toBe(1);

    await target.service.dropConnection('c1');
    expect(target.service.activeCount).toBe(0);
    expect((await settle(target, export_.exportId)).phase).toBe('cancelled');
  });
});
