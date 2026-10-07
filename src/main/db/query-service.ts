/**
 * Query orchestration: run, page, sort, cancel and dispose (PLAN Phase 4).
 *
 * Two paging strategies, chosen per result:
 *
 *  - **browse** — a plain table scan with a usable key. Pages are independent
 *    single queries (a keyset seek when the request is sequential, `OFFSET` for a
 *    jump), so **no transaction is held open** and nothing pins an xmin horizon
 *    while the user reads.
 *  - **cursor** — an arbitrary statement. One `NO SCROLL` cursor inside a
 *    `REPEATABLE READ` transaction, which is what keeps the data stable while the
 *    user scrolls.
 *
 * The cursor's hard constraint was found by testing against a live server rather
 * than assumed: `NO SCROLL` refuses a backward `MOVE ABSOLUTE` with "cursor can
 * only scan forward", **and the failure aborts the transaction**, so the result is
 * dead afterwards. Backward jumps therefore close and re-declare the cursor inside
 * the same transaction. That is safe precisely because the isolation level is
 * `REPEATABLE READ` — the new cursor reads the same snapshot, so rows do not shift
 * under the user.
 */
import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '../../shared/errors';
import {
  IpcChannel,
  type MainEventEmitter,
  type QueryProgressEvent,
  type QueryRunRequest,
  type QueryRunResponse,
  type ResultSortRequest,
  type ResultWindowRequest,
} from '../../shared/ipc-contract';
import type { ColumnMeta, EncodedRowBlock, ResultMeta, SortDirection } from '../../shared/domain';
import { blockByteLength, encodeBlock } from '../../shared/columnar';
import { typeNameFor, widthHintFor } from '../../shared/pg-types';
import { logError, logInfo } from '../log';
import type { ConnectionManager } from './connection-manager';
import type { PgClientHandle, PgQueryResult } from './driver-pg';
import { IdentifierError, quoteIdent, quoteQualified } from '../../shared/ident';
import { toTabbyError } from './pg-error';
import { ResultRegistry, type EvictionReason } from './result-registry';
import {
  closeCursorSql,
  cursorNameFor,
  declareCursorSql,
  fetchSql,
  keysetPageSql,
  moveAbsoluteSql,
  offsetPageSql,
} from './result-sql';
import { firstScalar } from './row-shape';
import type { SchemaService } from './schema-service';
import { SqlStructureError, assertSingleStatement } from './sql-scan';
import type { TabbyError } from '../../shared/errors';

const SCOPE = 'query';

/** Rows fetched before the renderer asks for its first window. */
export const DEFAULT_INITIAL_ROWS = 200;
export const DEFAULT_MAX_RESULTS = 20;
export const DEFAULT_RESULT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_RESULT_MEMORY_BYTES = 512 * 1024 * 1024;

/**
 * A `REPEATABLE READ` transaction, so closing and re-declaring the cursor to jump
 * backward reads the same snapshot instead of a newer one.
 */
export const BEGIN_SQL = 'begin isolation level repeatable read';
export const ROLLBACK_SQL = 'rollback';

/** How many evicted ids to remember, so "expired" can be told from "never existed". */
const EVICTED_MEMORY = 256;

interface CursorPaging {
  readonly kind: 'cursor';
  readonly cursorName: string;
  /** Zero-based index of the row the next FETCH would return. */
  position: number;
}

interface BrowsePaging {
  readonly kind: 'browse';
  readonly schema: string;
  readonly table: string;
  readonly keyColumns: readonly string[];
  /** Position of each key column in the result; resolved on the first page. */
  keyIndexes: readonly number[] | null;
  after: readonly unknown[] | null;
  nextRow: number;
}

export interface LiveResult {
  readonly resultId: string;
  readonly connectionId: string;
  readonly handle: PgClientHandle;
  /** What the user asked for, normalised. Sorting wraps this, never its own output. */
  readonly baseSql: string;
  /** What is currently driving the pages. */
  sql: string;
  columns: readonly ColumnMeta[];
  rowCount: number;
  rowCountIsEstimate: boolean;
  elapsedMs: number;
  paging: CursorPaging | BrowsePaging;
  /**
   * The rows fetched eagerly by `run()`, kept to serve the first windows.
   *
   * Without this, a request for row 0 after a 200-row prefetch is a *backward*
   * jump, which on a NO SCROLL cursor means close-and-re-declare — re-running the
   * query. For an expensive statement that is the difference between an instant
   * first paint and a second full execution.
   */
  prefetch: readonly (readonly unknown[])[] | null;
  prefetchBytes: number;
  countInFlight: boolean;
  disposed: boolean;
}

export interface ResultLimits {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly maxBytes?: number;
}

/**
 * Everything an export needs to re-run a result independently.
 *
 * `insertTarget` is the unquoted catalog name pair, not a rendered identifier:
 * quoting is the exporter's decision, and handing it a pre-quoted string would mean
 * two places agreeing on how to quote.
 */
export interface ExportDescription {
  readonly connectionId: string;
  /** The full statement, never a paged fragment. */
  readonly sql: string;
  readonly columns: readonly ColumnMeta[];
  /** Non-null only for a plain table scan, which is the only result with a name. */
  readonly insertTarget: { readonly schema: string; readonly table: string } | null;
}

export interface QueryServiceDeps {
  readonly connections: ConnectionManager;
  readonly schemas: SchemaService;
  /** Typed per channel by `MainEventMap`, so a payload cannot drift from the preload. */
  readonly emit: MainEventEmitter;
  readonly newResultId?: () => string;
  /**
   * Bounds for the registry, not a registry.
   *
   * Accepting an injected instance looked more flexible and was a resource leak:
   * eviction is what closes a cursor and returns its pooled client, and that
   * cleanup is wired through `onEvict` at construction. A caller-supplied registry
   * carries the caller's callback, so every eviction silently dropped a client
   * until the pool was exhausted — observed as "timeout exceeded when trying to
   * connect" after a dozen results. Bounds are injectable; ownership is not.
   */
  readonly limits?: ResultLimits;
}

export class QueryService {
  readonly registry: ResultRegistry<LiveResult>;
  private readonly deps: QueryServiceDeps;
  private readonly newResultId: () => string;
  private readonly recentlyEvicted = new Set<string>();
  private readonly evictedOrder: string[] = [];
  /** Tail of the background-count chain per connection. */
  private readonly countQueues = new Map<string, Promise<void>>();
  /** In-flight cursor releases, so teardown can await them instead of racing. */
  private readonly pendingReleases = new Set<Promise<void>>();
  /**
   * Runs that have a result id but are not in the registry yet.
   *
   * A result is only registered once its first page has arrived, which is precisely
   * when a slow query is still running — so without this a `cancel` for the query
   * the user is watching would answer RESULT_NOT_FOUND. The renderer learns the id
   * from the `planning` progress event, emitted before the handle is acquired.
   */
  private readonly pendingRuns = new Map<string, { connectionId: string; pid: number | null }>();

  constructor(deps: QueryServiceDeps) {
    this.deps = deps;
    this.newResultId = deps.newResultId ?? (() => randomUUID());
    const limits = deps.limits ?? {};
    this.registry = new ResultRegistry<LiveResult>({
      maxEntries: limits.maxEntries ?? DEFAULT_MAX_RESULTS,
      ttlMs: limits.ttlMs ?? DEFAULT_RESULT_TTL_MS,
      maxBytes: limits.maxBytes ?? DEFAULT_RESULT_MEMORY_BYTES,
      onEvict: (entry, reason) => this.onEvicted(entry.payload, reason),
    });
  }

  // ── run ────────────────────────────────────────────────────────────────────

  async run(request: QueryRunRequest): Promise<Result<QueryRunResponse>> {
    const sessionResult = await this.deps.connections.requireSession(request.connectionId);
    if (!sessionResult.ok) return err<QueryRunResponse>(sessionResult.error);
    const session = sessionResult.value;

    let baseSql: string;
    try {
      baseSql = assertSingleStatement(request.sql, 'sql');
    } catch (error) {
      return err<QueryRunResponse>(toValidationError(error, request.connectionId));
    }

    const resultId = this.newResultId();
    const startedAt = Date.now();
    const initialRows = clampRows(request.initialRows ?? DEFAULT_INITIAL_ROWS);
    // Registered before the progress event, so a cancel arriving in response to
    // that event finds something to look at rather than RESULT_NOT_FOUND.
    this.pendingRuns.set(resultId, { connectionId: request.connectionId, pid: null });
    this.progress(resultId, 'planning', 0);

    let handle: PgClientHandle;
    try {
      handle = await session.acquire();
      const pending = this.pendingRuns.get(resultId);
      if (pending) this.pendingRuns.set(resultId, { ...pending, pid: handle.backendPid });
    } catch (error) {
      this.pendingRuns.delete(resultId);
      return err<QueryRunResponse>(toTabbyError(error, { connectionId: request.connectionId }));
    }

    const state: LiveResult = {
      resultId,
      connectionId: request.connectionId,
      handle,
      baseSql,
      sql: baseSql,
      columns: [],
      rowCount: -1,
      rowCountIsEstimate: true,
      elapsedMs: 0,
      paging: { kind: 'cursor', cursorName: cursorNameFor(resultId), position: 0 },
      prefetch: null,
      prefetchBytes: 0,
      countInFlight: false,
      disposed: false,
    };

    try {
      await this.chooseStrategy(state, request, initialRows);
      const first = await this.fetchPage(state, 0, initialRows);

      state.columns = toColumnMeta(first.fields);
      state.elapsedMs = Date.now() - startedAt;

      const bytes = blockByteLength(encodeBlock(first.rows, state.columns, 0));
      state.prefetch = first.rows;
      state.prefetchBytes = bytes;

      const accepted = this.registry.set({
        resultId,
        connectionId: request.connectionId,
        payload: state,
        bytesHeld: bytes,
      });
      // From here the registry owns cancellation; keeping the pending entry would
      // let a stale pid be cancelled after the run had moved on.
      this.pendingRuns.delete(resultId);
      if (!accepted) {
        await this.releaseQuietly(state);
        return err<QueryRunResponse>({
          code: 'INTERNAL',
          message: 'the result is too large for the configured memory cap',
          resultId,
        });
      }

      this.progress(resultId, 'streaming', first.rows.length);
      // The exact count is a separate, possibly slow query; it must not delay the
      // first rows reaching the screen.
      this.startCount(state, session);

      logInfo(SCOPE, `result ${resultId} ready in ${state.elapsedMs}ms via ${state.paging.kind}`);
      return ok({ resultId, meta: this.metaOf(state) });
    } catch (error) {
      this.pendingRuns.delete(resultId);
      await this.releaseQuietly(state);
      logError(SCOPE, error);
      return err<QueryRunResponse>(
        toTabbyError(error, { connectionId: request.connectionId, resultId }),
      );
    }
  }

  /**
   * A table browse with a usable key pages without a transaction, which is
   * strictly better than a cursor: no xmin horizon pinned, no idle-transaction
   * timeout, and backward jumps cost nothing. Anything else gets a cursor.
   */
  private async chooseStrategy(
    state: LiveResult,
    request: QueryRunRequest,
    initialRows: number,
  ): Promise<void> {
    const browse = request.browse;
    if (browse) {
      const key = await this.deps.schemas.paginationKeyFor(
        request.connectionId,
        browse.schema,
        browse.table,
      );
      if (key && key.length > 0) {
        state.paging = {
          kind: 'browse',
          schema: browse.schema,
          table: browse.table,
          keyColumns: key,
          keyIndexes: null,
          after: null,
          nextRow: 0,
        };
        state.sql = keysetPageSql({
          schema: browse.schema,
          table: browse.table,
          keyColumns: key,
          direction: 'asc',
          limit: initialRows,
          after: null,
        }).text;

        // reltuples is free and already cached, so the scrollbar is approximately
        // right before the exact count lands.
        const meta = await this.deps.schemas.tableOf(
          request.connectionId,
          browse.schema,
          browse.table,
        );
        if (meta.ok && meta.value.rowEstimate >= 0) {
          state.rowCount = meta.value.rowEstimate;
        }
        return;
      }
    }

    await state.handle.query(BEGIN_SQL);
    await state.handle.query(
      declareCursorSql((state.paging as CursorPaging).cursorName, state.sql),
    );
  }

  // ── window ─────────────────────────────────────────────────────────────────

  async window(request: ResultWindowRequest): Promise<Result<EncodedRowBlock>> {
    const entry = this.registry.get(request.resultId);
    if (!entry) return err<EncodedRowBlock>(this.missingResult(request.resultId));
    const state = entry.payload;
    const rowCount = clampRows(request.rowCount);

    const cached = this.fromPrefetch(state, request.startRow, rowCount);
    if (cached) return ok(cached);

    try {
      const page = await this.fetchPage(state, request.startRow, rowCount);
      if (state.columns.length === 0) state.columns = toColumnMeta(page.fields);
      // Not charged against the registry: an encoded block is handed to the
      // renderer and dropped, so it is not memory main holds on to. Only the
      // prefetch — which is retained — is charged, once, when it is created.
      return ok(encodeBlock(page.rows, state.columns, request.startRow));
    } catch (error) {
      logError(`${SCOPE}:window`, error);
      return err<EncodedRowBlock>(
        toCursorFailure(error, { connectionId: state.connectionId, resultId: state.resultId }),
      );
    }
  }

  /**
   * Serves a window that lies entirely inside the eager prefetch.
   *
   * Also drops the prefetch once a request has moved past it, and gives the bytes
   * back: holding 200 rows nobody will ask for again is exactly what the registry's
   * memory cap exists to prevent.
   */
  private fromPrefetch(
    state: LiveResult,
    startRow: number,
    rowCount: number,
  ): EncodedRowBlock | null {
    const rows = state.prefetch;
    if (rows === null) return null;

    if (startRow >= 0 && startRow + rowCount <= rows.length) {
      return encodeBlock(rows.slice(startRow, startRow + rowCount), state.columns, startRow);
    }
    if (startRow >= rows.length) {
      state.prefetch = null;
      this.registry.addBytes(state.resultId, -state.prefetchBytes);
      state.prefetchBytes = 0;
    }
    return null;
  }

  /**
   * Reads one page and leaves the strategy positioned just past it.
   *
   * Every positioning decision lives here; the backward-jump case is the reason
   * the cursor sits in a REPEATABLE READ transaction.
   */
  private async fetchPage(
    state: LiveResult,
    startRow: number,
    rowCount: number,
  ): Promise<PgQueryResult> {
    const paging = state.paging;

    if (paging.kind === 'browse') {
      const sequential = startRow === paging.nextRow;
      const page = sequential
        ? keysetPageSql({
            schema: paging.schema,
            table: paging.table,
            keyColumns: paging.keyColumns,
            direction: 'asc',
            limit: rowCount,
            after: paging.after,
          })
        : offsetPageSql({
            schema: paging.schema,
            table: paging.table,
            keyColumns: paging.keyColumns,
            direction: 'asc',
            limit: rowCount,
            offset: startRow,
          });

      const result = await state.handle.query(page.text, page.values);

      if (paging.keyIndexes === null) {
        // Resolved from the first page rather than by a probe query: `select *`
        // already tells us where the key columns landed.
        const indexes = paging.keyColumns.map((name) =>
          result.fields.findIndex((field) => field.name === name),
        );
        if (indexes.some((index) => index < 0)) {
          throw new Error(`key columns are missing from the result of "${paging.table}"`);
        }
        paging.keyIndexes = indexes;
      }

      const last = result.rows[result.rows.length - 1];
      if (last && paging.keyIndexes) {
        paging.after = paging.keyIndexes.map((index) => last[index]);
      }
      paging.nextRow = startRow + result.rows.length;
      return result;
    }

    if (startRow !== paging.position) {
      if (startRow < paging.position) {
        // NO SCROLL cannot move backward, and trying aborts the transaction.
        // Re-declare instead: same transaction, so the same snapshot.
        await state.handle.query(closeCursorSql(paging.cursorName));
        await state.handle.query(declareCursorSql(paging.cursorName, state.sql));
      }
      await state.handle.query(moveAbsoluteSql(paging.cursorName, startRow));
      paging.position = startRow;
    }

    const result = await state.handle.query(fetchSql(paging.cursorName, rowCount));
    paging.position += result.rows.length;

    // A short page at the end of the result finally pins the exact row count.
    if (result.rows.length < rowCount && state.rowCountIsEstimate) {
      state.rowCount = startRow + result.rows.length;
      state.rowCountIsEstimate = false;
    }
    return result;
  }

  // ── sort ───────────────────────────────────────────────────────────────────

  async sort(request: ResultSortRequest): Promise<Result<ResultMeta>> {
    const entry = this.registry.get(request.resultId);
    if (!entry) return err<ResultMeta>(this.missingResult(request.resultId));
    const state = entry.payload;
    const sort = request.sort;

    if (sort !== null && !state.columns[sort.columnIndex]) {
      return err<ResultMeta>({
        code: 'VALIDATION_FAILED',
        field: 'sort.columnIndex',
        message: `no column at index ${sort.columnIndex}`,
        resultId: request.resultId,
      });
    }

    const startedAt = Date.now();
    try {
      state.sql =
        sort === null ? state.baseSql : this.sortedSql(state, sort.columnIndex, sort.direction);
      // Sorting always re-runs, and an ORDER BY over the whole set cannot be
      // keyset-paged by the table's key, so the result becomes a cursor.
      await this.reopenAsCursor(state);
      state.elapsedMs = Date.now() - startedAt;
      return ok(this.metaOf(state));
    } catch (error) {
      logError(`${SCOPE}:sort`, error);
      return err<ResultMeta>(
        toCursorFailure(error, { connectionId: state.connectionId, resultId: state.resultId }),
      );
    }
  }

  private sortedSql(state: LiveResult, columnIndex: number, direction: SortDirection): string {
    const column = state.columns[columnIndex];
    const order = `order by ${quoteIdent(column?.name ?? `column_${columnIndex}`, 'sort.column')} ${direction}`;
    const paging = state.paging;
    return paging.kind === 'browse'
      ? `select * from ${quoteQualified(paging.schema, paging.table)} ${order}`
      : `select * from (${state.baseSql}) as tabby_sorted ${order}`;
  }

  private async reopenAsCursor(state: LiveResult): Promise<void> {
    if (state.paging.kind === 'cursor') {
      await state.handle.query(closeCursorSql(state.paging.cursorName));
      await state.handle.query(ROLLBACK_SQL);
    }
    await state.handle.query(BEGIN_SQL);
    const cursorName = cursorNameFor(state.resultId);
    await state.handle.query(declareCursorSql(cursorName, state.sql));
    state.paging = { kind: 'cursor', cursorName, position: 0 };
    // The prefetch belongs to the previous ordering; serving it now would show
    // rows that no longer match what is on screen.
    state.prefetch = null;
    state.prefetchBytes = 0;
  }

  // ── cancel ─────────────────────────────────────────────────────────────────

  /**
   * Cancels on the **reserved second connection**: the one running the query is
   * blocked waiting for the server and cannot be asked to do anything.
   */
  async cancel(resultId: string): Promise<Result<void>> {
    const entry = this.registry.get(resultId);
    const pending = this.pendingRuns.get(resultId);
    if (!entry && !pending) return err<void>(this.missingResult(resultId));

    const connectionId = entry ? entry.payload.connectionId : (pending?.connectionId ?? '');
    const session = this.deps.connections.session(connectionId);
    if (!session) {
      return err<void>({
        code: 'CONN_LOST',
        message: 'the connection for this result is no longer open',
        connectionId,
        resultId,
      });
    }

    // A run cancelled before its client was acquired has no backend to signal.
    // That window is milliseconds wide on a warm pool, and saying so beats
    // reporting success for a cancel that could not have reached the server.
    const pid = entry ? entry.payload.handle.backendPid : pending?.pid;
    if (typeof pid !== 'number') {
      return err<void>({
        code: 'NOT_FOUND',
        message: 'the query has not reached the server yet',
        connectionId,
        resultId,
      });
    }

    const result = await session.cancel(pid);
    if (result.ok) {
      this.pendingRuns.delete(resultId);
      this.progress(resultId, 'failed', 0);
    }
    return result;
  }

  // ── metadata and disposal ──────────────────────────────────────────────────

  meta(resultId: string): Result<ResultMeta> {
    const entry = this.registry.get(resultId);
    if (!entry) return err<ResultMeta>(this.missingResult(resultId));
    return ok(this.metaOf(entry.payload));
  }

  /**
   * What an export needs to re-run a result on its own connection (Phase 8).
   *
   * **Deliberately a description, not the cursor itself.** An export cannot read
   * through the result's own cursor: that cursor is `NO SCROLL` and positioned, so
   * draining it would move `paging.position` out from under the grid and leave the
   * tab showing rows it no longer has. Exporting therefore opens a second cursor on
   * a second client, which means a second `REPEATABLE READ` snapshot — so a file
   * exported while the table is being written can differ from what was on screen.
   * That is the honest trade: sharing the cursor would corrupt the UI, and a viewer
   * that silently exported stale-or-not data with no rule would be worse.
   *
   * The `sql` branch matters: for an unpaged browse, `state.sql` is the *keyset
   * page* with its `LIMIT`, and exporting that would write `initialRows` rows and
   * call it the table. `baseSql` is the whole scan. Once the user sorts, the result
   * becomes a cursor and `state.sql` is already the full sorted query.
   */
  exportDescription(resultId: string): Result<ExportDescription> {
    const entry = this.registry.get(resultId);
    if (!entry) return err<ExportDescription>(this.missingResult(resultId));
    const state = entry.payload;
    const paging = state.paging;

    return ok({
      connectionId: state.connectionId,
      sql: paging.kind === 'browse' ? state.baseSql : state.sql,
      columns: state.columns,
      // Only a plain table scan has a name to insert into. An arbitrary statement
      // has none, and inventing one would produce a file that claims a target it
      // did not come from.
      insertTarget:
        paging.kind === 'browse' ? { schema: paging.schema, table: paging.table } : null,
    });
  }

  private metaOf(state: LiveResult): ResultMeta {
    return {
      resultId: state.resultId,
      columns: state.columns,
      rowCount: state.rowCount,
      rowCountIsEstimate: state.rowCountIsEstimate,
      elapsedMs: state.elapsedMs,
    };
  }

  dispose(resultId: string): Result<void> {
    this.pendingRuns.delete(resultId);
    const entry = this.registry.get(resultId);
    if (!entry) return err<void>(this.missingResult(resultId));
    // `delete` fires onEvict, which closes the cursor and releases the client, so
    // disposal has exactly one code path.
    this.registry.delete(resultId);
    return ok(undefined);
  }

  /** Called when a connection dies: every result on it is unusable. */
  dropConnection(connectionId: string): void {
    for (const resultId of this.registry.idsForConnection(connectionId)) {
      this.registry.delete(resultId);
    }
    // A run still in flight on a dead connection will never register, so its
    // pending entry would otherwise outlive the pool it belonged to.
    for (const [resultId, pending] of this.pendingRuns) {
      if (pending.connectionId === connectionId) this.pendingRuns.delete(resultId);
    }
    this.deps.emit(IpcChannel.evConnectionLost, { connectionId });
  }

  private onEvicted(state: LiveResult, reason: EvictionReason): void {
    // Tracked, not fire-and-forget: a result holds a checked-out pool client for
    // its whole life, and `pool.end()` waits for every client to come back. A
    // teardown that does not await these blocks until something force-kills it.
    const release = this.releaseQuietly(state);
    this.pendingReleases.add(release);
    void release.finally(() => this.pendingReleases.delete(release));

    if (reason === 'disposed') return;
    this.rememberEvicted(state.resultId);
    this.deps.emit(IpcChannel.evResultEvicted, { resultId: state.resultId, reason });
  }

  /**
   * Awaits every in-flight cursor release.
   *
   * Call this before closing a connection or quitting. Without it `pool.end()`
   * waits for clients that are still mid-`ROLLBACK`, which in the app meant
   * shutdown always burned its grace period and exited by force whenever a result
   * tab was open — and in the bench harness, hung forever.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pendingReleases]);
  }

  private rememberEvicted(resultId: string): void {
    this.recentlyEvicted.add(resultId);
    this.evictedOrder.push(resultId);
    while (this.evictedOrder.length > EVICTED_MEMORY) {
      const oldest = this.evictedOrder.shift();
      if (oldest !== undefined) this.recentlyEvicted.delete(oldest);
    }
  }

  /** Closes the cursor and releases the client. Never throws: disposal must complete. */
  private async releaseQuietly(state: LiveResult): Promise<void> {
    if (state.disposed) return;
    state.disposed = true;
    try {
      // ROLLBACK ends the transaction, which closes its cursors implicitly. A
      // browse result holds no transaction, so there is nothing to roll back.
      if (state.paging.kind === 'cursor') await state.handle.query(ROLLBACK_SQL);
    } catch (error) {
      logError(`${SCOPE}:release`, error);
    } finally {
      state.handle.release();
    }
  }

  private missingResult(resultId: string): TabbyError {
    // "Expired — re-run the query" and "this id was never valid" need different UI,
    // and only the service knows which happened.
    return this.recentlyEvicted.has(resultId)
      ? {
          code: 'RESULT_EVICTED',
          message: 'this result expired; re-run the query',
          resultId,
        }
      : { code: 'RESULT_NOT_FOUND', message: `no result with id ${resultId}`, resultId };
  }

  private progress(
    resultId: string,
    phase: QueryProgressEvent['phase'],
    rowsReceived: number,
  ): void {
    this.deps.emit(IpcChannel.evQueryProgress, { resultId, phase, rowsReceived });
  }

  /**
   * Counts a browse result's rows in the background.
   *
   * Runs on a pooled client, never on the result's own handle, so a slow
   * `count(*)` cannot block the user scrolling. A failure — usually
   * `statement_timeout` — leaves the `reltuples` estimate in place rather than
   * failing the result.
   *
   * Deliberately **browse-only**. Counting an arbitrary statement means wrapping
   * and re-executing it, so opening a result tab on an expensive query would run
   * that query a second time on somebody's production database without being asked.
   * A cursor result instead learns its exact row count when it reaches the end,
   * and reports -1 ("unknown") until then.
   *
   * Serialised per connection: these counts are the only heavy users of the pool's
   * auxiliary clients, and a burst of open tabs must not queue behind them.
   */
  private startCount(state: LiveResult, session: PgSessionLike): void {
    const paging = state.paging;
    if (paging.kind !== 'browse') return;
    if (state.countInFlight || state.disposed) return;
    state.countInFlight = true;

    const statement = `select count(*) from ${quoteQualified(paging.schema, paging.table)}`;
    this.enqueueCount(state.connectionId, () =>
      session
        .query(statement)
        .then((result) => {
          const total = Number(firstScalar(result));
          if (state.disposed || !Number.isFinite(total) || total < 0) return;
          state.rowCount = total;
          state.rowCountIsEstimate = false;
          this.progress(state.resultId, 'done', total);
        })
        .catch((error: unknown) => {
          logError(`${SCOPE}:count`, error);
        })
        .finally(() => {
          state.countInFlight = false;
        }),
    );
  }

  /** Chains one background count per connection, so at most one aux client is used. */
  private enqueueCount(connectionId: string, task: () => Promise<void>): void {
    const previous = this.countQueues.get(connectionId) ?? Promise.resolve();
    // Runs whether or not the previous count settled, so one failure cannot wedge
    // the queue for every later result on that connection.
    const next = previous.then(task, task);
    this.countQueues.set(connectionId, next);
    void next.finally(() => {
      if (this.countQueues.get(connectionId) === next) this.countQueues.delete(connectionId);
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** The part of a session this service needs, so a fake can stand in for tests. */
interface PgSessionLike {
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
}

function clampRows(rows: number): number {
  if (!Number.isInteger(rows)) return DEFAULT_INITIAL_ROWS;
  return Math.max(1, Math.min(rows, 10_000));
}

function toColumnMeta(
  fields: readonly { name: string; dataTypeID: number }[],
): readonly ColumnMeta[] {
  return fields.map((field) => ({
    name: field.name,
    typeName: typeNameFor(field.dataTypeID),
    typeOid: field.dataTypeID,
    // Unknown until the catalog says otherwise; assuming NOT NULL would be wrong
    // for most real tables and would matter once editing exists.
    nullable: true,
    widthHint: widthHintFor(field.dataTypeID),
  }));
}

function toValidationError(error: unknown, connectionId: string): TabbyError {
  if (error instanceof SqlStructureError || error instanceof IdentifierError) {
    return {
      code: 'VALIDATION_FAILED',
      field: error.field,
      message: error.message,
      connectionId,
    };
  }
  return {
    code: 'VALIDATION_FAILED',
    field: 'sql',
    message: error instanceof Error ? error.message : String(error),
    connectionId,
  };
}

/**
 * A failure on a cursor's own connection usually means the cursor is gone — an
 * idle-transaction timeout, a server restart, a dropped socket. Saying so beats a
 * generic internal error, because the only remedy is "re-run the query".
 */
function toCursorFailure(
  error: unknown,
  context: { connectionId: string; resultId: string },
): TabbyError {
  const mapped = toTabbyError(error, context);
  if (mapped.code === 'QUERY_CANCELLED' || mapped.code === 'CONN_LOST') return mapped;

  const cursorGone =
    mapped.sqlState === '34000' ||
    mapped.sqlState === '25P02' ||
    /idle-in-transaction|cursor can only scan forward|could not find cursor/i.test(mapped.message);

  return cursorGone
    ? {
        ...mapped,
        code: 'CURSOR_CLOSED',
        message: 'the result cursor is no longer open; re-run the query',
      }
    : mapped;
}
