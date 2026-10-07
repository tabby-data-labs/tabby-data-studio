/**
 * Streaming result export (PLAN Phase 8).
 *
 * The shape of this module is dictated by the phase's exit criterion: a million-row
 * export must not push the renderer past ~150MB, and must be cancellable mid-flight.
 * The first half is structural rather than clever — **rows never enter the
 * renderer**. Main reads a batch from its own cursor, serialises it, writes it, and
 * drops it, so the renderer's only involvement is a progress number. Peak main heap
 * is one batch (`EXPORT_BATCH_ROWS`) plus the write stream's buffer, not the result.
 *
 * Four decisions worth stating:
 *
 *  - **Its own client and cursor.** Exporting through the result's cursor would
 *    advance a `NO SCROLL` cursor the grid is paging with, so `QueryService` hands
 *    over an `ExportDescription` and this service re-declares. The cost is a second
 *    pooled client for the export's whole duration, and a second snapshot; the
 *    alternative is a grid that silently loses its position.
 *  - **Cancel signals the backend as well as setting a flag.** A flag alone only
 *    takes effect between batches, and one `FETCH 5000` from a slow plan can be
 *    many seconds. `pg_cancel_backend` makes the wait bounded by the round trip.
 *  - **A failure deletes the partial file; a cancel keeps it.** A truncated CSV
 *    that looks complete is a trap — a spreadsheet opens it and reports fewer rows
 *    than the query returned, with nothing to say why. A cancelled export is the
 *    user's own decision to stop, and throwing away the rows they did get would be
 *    the surprising choice. The file is only ever deleted if this service created
 *    it, so failing before the stream opens cannot remove something else.
 *  - **Backpressure is honoured.** Ignoring a `false` from `write()` would let a
 *    slow disk become an unbounded Node write buffer, which is how a "streaming"
 *    export ends up holding the whole result in memory anyway.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, rmSync, type WriteStream } from 'node:fs';
import { basename } from 'node:path';
import { err, ok, scrub, type Result, type TabbyError } from '../../shared/errors';
import {
  IpcChannel,
  type ExportStartResponse,
  type MainEventEmitter,
} from '../../shared/ipc-contract';
import {
  EXPORT_BATCH_ROWS,
  type ExportEncoding,
  type ExportFormat,
  type ExportOptions,
} from '../../shared/export';
import { quoteQualified } from '../../shared/ident';
import { logError, logInfo } from '../log';
import type { ConnectionManager } from '../db/connection-manager';
import type { PgClientHandle } from '../db/driver-pg';
import {
  BEGIN_SQL,
  ROLLBACK_SQL,
  type ExportDescription,
  type QueryService,
} from '../db/query-service';
import { toTabbyError } from '../db/pg-error';
import { closeCursorSql, cursorNameFor, declareCursorSql, fetchSql } from '../db/result-sql';
import { createSerialiser, DEFAULT_INSERT_TARGET } from './serialise';

const SCOPE = 'export';

/**
 * Concurrent exports allowed.
 *
 * Each holds a pooled client for its whole duration, and the pool is sized at four
 * cursor slots (ARCHITECTURE §5.1). Beyond a small cap the next export would simply
 * queue inside `acquire()` — which the user sees as a progress bar that never moves
 * and has no explanation. Refusing is honest; queueing silently is not.
 */
export const MAX_CONCURRENT_EXPORTS = 2;

export interface ExportServiceDeps {
  readonly connections: ConnectionManager;
  readonly queries: QueryService;
  readonly emit: MainEventEmitter;
  /**
   * The save dialog, injected.
   *
   * It is the only way a path enters this service: `ExportStartRequest` has no path
   * field, so a compromised renderer cannot aim an export at a file the user did
   * not just pick. Returns null when the user dismisses the dialog.
   */
  readonly pickPath: (suggestedFileName: string, format: ExportFormat) => Promise<string | null>;
  readonly newExportId?: () => string;
}

export interface ExportStartInput {
  readonly resultId: string;
  readonly options: ExportOptions;
}

interface ActiveExport {
  readonly exportId: string;
  readonly path: string;
  readonly connectionId: string;
  readonly startedAt: number;
  task: Promise<void>;
  cancelled: boolean;
  pid: number | null;
  rowsWritten: number;
  bytesWritten: number;
  /**
   * True once this service opened the file.
   *
   * The guard is what stops a failure *before* the stream opened — a refused
   * connection, a pool timeout — from deleting a file the user happened to have
   * named in the save dialog. Overwriting it was authorised; removing it was not.
   */
  fileCreated: boolean;
}

export class ExportService {
  private readonly deps: ExportServiceDeps;
  private readonly newExportId: () => string;
  private readonly active = new Map<string, ActiveExport>();

  constructor(deps: ExportServiceDeps) {
    this.deps = deps;
    this.newExportId = deps.newExportId ?? ((): string => randomUUID());
  }

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Asks the user where to write, then starts the stream.
   *
   * Resolves as soon as the export is registered — not when it finishes — so the
   * bridge call cannot outlive the patience of whoever is awaiting it. Everything
   * after that point is reported on `evExportProgress`.
   */
  async start(input: ExportStartInput): Promise<Result<ExportStartResponse | null>> {
    if (this.active.size >= MAX_CONCURRENT_EXPORTS) {
      return err<ExportStartResponse | null>({
        code: 'EXPORT_BUSY',
        message: `${MAX_CONCURRENT_EXPORTS} exports are already running; wait for one to finish`,
      });
    }

    const described = this.deps.queries.exportDescription(input.resultId);
    if (!described.ok) return err<ExportStartResponse | null>(described.error);
    const description = described.value;

    const format = input.options.format;
    let path: string | null;
    try {
      path = await this.deps.pickPath(suggestedFileName(description, format), format);
    } catch (error) {
      logError(`${SCOPE}:dialog`, error);
      return err<ExportStartResponse | null>({
        code: 'INTERNAL',
        message: 'the save dialog could not be opened',
      });
    }
    // Dismissing the save dialog is a decision, not a failure.
    if (path === null) return ok<ExportStartResponse | null>(null);

    // Quoted here rather than in the serialiser: the names came from the catalog and
    // `quoteQualified` is the one place that knows how to double a `"`.
    let insertTarget = DEFAULT_INSERT_TARGET;
    if (description.insertTarget) {
      try {
        insertTarget = quoteQualified(
          description.insertTarget.schema,
          description.insertTarget.table,
        );
      } catch (error) {
        // A name the catalog returned that `quoteIdent` refuses is a contradiction
        // worth stopping for, rather than exporting under a placeholder.
        logError(`${SCOPE}:target`, error);
        return err<ExportStartResponse | null>({
          code: 'INTERNAL',
          message: 'the table name cannot be quoted for an INSERT',
        });
      }
    }

    const exportId = this.newExportId();
    const state: ActiveExport = {
      exportId,
      path,
      connectionId: description.connectionId,
      startedAt: Date.now(),
      task: Promise.resolve(),
      cancelled: false,
      pid: null,
      rowsWritten: 0,
      bytesWritten: 0,
      fileCreated: false,
    };
    const task = this.stream(state, description, input.options, insertTarget);
    // Assigned after `stream` is called so the promise exists, and registered
    // before it can settle, so a cancel arriving in the same tick finds it.
    state.task = task;
    this.active.set(exportId, state);
    void task.finally(() => {
      if (this.active.get(exportId) === state) this.active.delete(exportId);
    });

    logInfo(SCOPE, `export ${exportId} started -> ${basename(path)} (${format})`);
    return ok<ExportStartResponse | null>({
      exportId,
      path,
      fileName: basename(path),
      format,
      insertTarget: description.insertTarget ? insertTarget : null,
    });
  }

  /**
   * Stops a running export.
   *
   * Sets the flag first, then signals the backend. The order matters: a cancel that
   * only signalled the backend would leave the loop believing it had failed, and
   * would report `failed` after deleting a file the user asked to keep.
   */
  async cancel(exportId: string): Promise<Result<void>> {
    const state = this.active.get(exportId);
    if (!state) {
      return err<void>({ code: 'NOT_FOUND', message: `no export with id ${exportId}` });
    }
    state.cancelled = true;

    const session = this.deps.connections.session(state.connectionId);
    const pid = state.pid;
    if (session && typeof pid === 'number') {
      // Best effort: the between-batch check stops the loop either way, and a
      // failure here usually means the backend already finished.
      const result = await session.cancel(pid);
      if (!result.ok) logError(`${SCOPE}:cancel`, new Error(result.error.message));
    }
    return ok(undefined);
  }

  /**
   * Awaits every in-flight export.
   *
   * Call before closing a connection or quitting: an export holds a checked-out
   * pool client, and `pool.end()` waits for all of them.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((state) => state.task));
  }

  /** Cancels everything and awaits it. Used on quit, where waiting is not an option. */
  async cancelAll(): Promise<void> {
    await Promise.allSettled([...this.active.keys()].map((id) => this.cancel(id)));
    await this.drain();
  }

  /**
   * Cancels and awaits the exports on one connection.
   *
   * Called before that connection's pool is closed. An export holds a checked-out
   * client for its whole life, and `pool.end()` waits for every client to come
   * back — so without this, closing a connection while an export runs would block
   * until the shutdown grace timer force-exited the process.
   *
   * Awaits only the tasks it cancelled, not `drain()`. Closing connection B must
   * not wait out an unrelated export on connection A; an earlier version called
   * `drain()` here and did exactly that.
   */
  async dropConnection(connectionId: string): Promise<void> {
    const targets = [...this.active.values()].filter(
      (state) => state.connectionId === connectionId,
    );
    if (targets.length === 0) return;
    await Promise.allSettled(targets.map((state) => this.cancel(state.exportId)));
    await Promise.allSettled(targets.map((state) => state.task));
  }

  // ── the stream ─────────────────────────────────────────────────────────────

  private async stream(
    state: ActiveExport,
    description: ExportDescription,
    options: ExportOptions,
    insertTarget: string,
  ): Promise<void> {
    const outcome = await this.runStream(state, description, options, insertTarget);
    const phase: 'done' | 'cancelled' | 'failed' =
      outcome !== null ? 'failed' : state.cancelled ? 'cancelled' : 'done';
    const elapsedMs = Date.now() - state.startedAt;

    if (outcome !== null && state.fileCreated) {
      // A file that stopped halfway is indistinguishable from a complete one to
      // anything that opens it, so it does not survive a failure. A cancel keeps
      // its rows: stopping was the user's decision, not an accident.
      removeQuietly(state.path);
      state.bytesWritten = 0;
    }

    this.progress(state, phase, outcome?.message ?? null, elapsedMs);
    logInfo(
      SCOPE,
      `export ${state.exportId} ${phase} — ${state.rowsWritten} rows, ` +
        `${state.bytesWritten} bytes in ${elapsedMs}ms`,
    );
  }

  /**
   * Runs the export and always releases what it took.
   *
   * Returns the failure, or null. A cancel is not a failure: it surfaces as the
   * backend's `57014` from the in-flight `FETCH`, and `state.cancelled` is what
   * tells the two apart.
   */
  private async runStream(
    state: ActiveExport,
    description: ExportDescription,
    options: ExportOptions,
    insertTarget: string,
  ): Promise<TabbyError | null> {
    let handle: PgClientHandle | null = null;
    let out: WriteStream | null = null;
    let cursor: string | null = null;

    try {
      const sessionResult = await this.deps.connections.requireSession(description.connectionId);
      if (!sessionResult.ok) return sessionResult.error;
      const session = sessionResult.value;

      handle = await session.acquire();
      state.pid = handle.backendPid;

      const stream = createWriteStream(state.path, { encoding: options.encoding });
      out = stream;
      state.fileCreated = true;
      // One listener for the whole export. A stream error must end the run with a
      // reason rather than arrive as an unhandled 'error' event, which in Node is a
      // thrown exception and would take the main process down.
      const failed = new Promise<never>((_resolve, reject) => {
        stream.once('error', reject);
      });
      // Pinned so a stream that fails after the export has settled cannot become
      // an unhandled rejection. Racing against it still rejects the race.
      failed.catch(() => undefined);

      const serialiser = createSerialiser(
        options.format,
        description.columns,
        options,
        insertTarget,
      );

      await handle.query(BEGIN_SQL);
      cursor = cursorNameFor(state.exportId);
      await handle.query(declareCursorSql(cursor, description.sql));

      await this.write(state, stream, failed, serialiser.begin(), options.encoding);

      for (;;) {
        if (state.cancelled) break;
        // Not raced against `failed`: a losing race would leave the FETCH promise
        // dangling, and its later rejection would be unhandled. A stream error is
        // picked up by the next write instead, at most one batch later.
        const page = await handle.query(fetchSql(cursor, EXPORT_BATCH_ROWS));
        for (const row of page.rows) {
          await this.write(state, stream, failed, serialiser.row(row), options.encoding);
        }
        state.rowsWritten += page.rows.length;
        this.progress(state, 'streaming', null);
        if (page.rows.length < EXPORT_BATCH_ROWS) break;
      }

      // A cancelled export keeps what it wrote, so it must not gain a JSON `]` or a
      // closing `;` that would claim the file is complete.
      if (!state.cancelled) {
        await this.write(state, stream, failed, serialiser.end(), options.encoding);
      }
      return null;
    } catch (error) {
      if (state.cancelled) return null;
      const mapped = toTabbyError(error, { connectionId: description.connectionId });
      logError(`${SCOPE}:stream`, error);
      return mapped;
    } finally {
      const client = handle;
      if (client !== null) {
        // ROLLBACK ends the transaction and closes its cursors implicitly; the
        // explicit CLOSE first is so the server releases it even if the rollback
        // is what fails.
        if (cursor !== null) await quietly(client, closeCursorSql(cursor));
        await quietly(client, ROLLBACK_SQL);
        client.release();
        state.pid = null;
      }
      await closeStream(out);
    }
  }

  /**
   * Writes one chunk, waiting for the buffer to drain when Node asks for it.
   *
   * `writableNeedDrain` rather than the `write()` return value, because the return
   * value is read inside the completion callback and the two can disagree once an
   * error has landed.
   */
  private async write(
    state: ActiveExport,
    out: WriteStream,
    failed: Promise<never>,
    text: string,
    encoding: ExportEncoding,
  ): Promise<void> {
    if (text === '') return;
    state.bytesWritten += Buffer.byteLength(text, encoding);

    const needsDrain = await Promise.race([
      new Promise<boolean>((resolve, reject) => {
        out.write(text, (error) => {
          if (error) reject(error);
          else resolve(out.writableNeedDrain);
        });
      }),
      failed,
    ]);

    if (!needsDrain) return;
    await Promise.race([new Promise<void>((resolve) => out.once('drain', resolve)), failed]);
  }

  private progress(
    state: ActiveExport,
    phase: 'streaming' | 'done' | 'cancelled' | 'failed',
    message: string | null,
    elapsedMs: number = Date.now() - state.startedAt,
  ): void {
    this.deps.emit(IpcChannel.evExportProgress, {
      exportId: state.exportId,
      path: state.path,
      phase,
      rowsWritten: state.rowsWritten,
      bytesWritten: state.bytesWritten,
      elapsedMs,
      message: message === null ? null : scrub(message),
    });
  }
}

/** Runs a statement whose failure must not change the outcome already decided. */
async function quietly(handle: PgClientHandle, sql: string): Promise<void> {
  try {
    await handle.query(sql);
  } catch (error) {
    logError(`${SCOPE}:cleanup`, error);
  }
}

/** Flushes and closes, resolving on either success or error: teardown cannot stall. */
function closeStream(out: WriteStream | null): Promise<void> {
  if (out === null) return Promise.resolve();
  return new Promise((resolve) => {
    out.once('error', () => resolve());
    out.end(() => resolve());
  });
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    // The export already failed; failing to remove its remains is a second and
    // smaller problem, and logging is all that is left to do.
    logError(`${SCOPE}:cleanup-file`, error);
  }
}

/**
 * A suggested file name for the save dialog.
 *
 * Derived from the table when the result is a plain scan, so exporting
 * `fixtures.big` suggests `big.csv` rather than `export.csv`. Never taken from
 * user-typed SQL text: a statement is not a file name, and sanitising one well
 * enough to be safe on every filesystem is not worth it for a suggestion.
 */
function suggestedFileName(description: ExportDescription, format: ExportFormat): string {
  const stem = description.insertTarget?.table ?? 'export';
  return `${stem}.${format}`;
}
