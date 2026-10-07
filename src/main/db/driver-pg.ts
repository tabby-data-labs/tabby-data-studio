/**
 * The `pg` adapter — the only file in the codebase that imports `pg`, enforced by
 * an ESLint rule so the driver stays swappable and nothing else can reach a socket.
 *
 * Three things this module owns and nothing else may:
 *
 *  1. **Session hardening on every backend.** A pool creates clients lazily, so
 *     `SET default_transaction_read_only = on` and friends are attached to the
 *     pool's `connect` event, not run once at startup. A client that missed them
 *     would be a writable connection to production.
 *  2. **A reserved connection for cancellation.** `pg_cancel_backend` cannot run
 *     on the connection that is blocked waiting for the server, so one client is
 *     checked out at connect time and never used for queries.
 *  3. **Type parsers.** `timestamp without time zone` and `date` are overridden
 *     because `pg`'s defaults build a `Date` in the *host* timezone, which makes
 *     the same row render differently on two machines.
 *
 * Rows come back positional (`rowMode: 'array'`), so two columns with the same
 * name — a self-join, or `select 1 as a, 2 as a` — cannot collide.
 */
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../../shared/errors';
import { OID, parseDateOnly, parseTimestampAsUtc } from '../../shared/pg-types';
import { logError, logInfo } from '../log';
import { toTabbyError } from './pg-error';
import { cancelBackendSql } from './result-sql';
import { sessionStatements, type SessionLimits } from './session';
import { describeConfigForLog, type PgConnectionConfig } from './pg-config';

const SCOPE = 'pg';

/**
 * `@types/pg` types the OID argument as a union of the OIDs its own builtin table
 * happens to list, which omits some real ones (`timetz`, 1185). Every value passed
 * here comes from our own OID table, so the widening is safe — and it happens once,
 * here, rather than as eight separate casts at the call sites.
 */
function setTypeParser(oid: number, parse: (value: string) => unknown): void {
  pg.types.setTypeParser(oid as Parameters<typeof pg.types.setTypeParser>[0], parse);
}

// `pg`'s default parsers build a JS Date from the text, using the host timezone.
// For a timestamp *without* timezone that is simply wrong, and for a date it shifts
// the calendar day anywhere west of Greenwich. Both are read deterministically here.
setTypeParser(OID.timestamp, (text) => parseTimestampAsUtc(text));
setTypeParser(OID.date, (text) => parseDateOnly(text));

// json/jsonb: keep the server's exact text. pg's default parser builds a JS object
// and re-stringifying it loses key order, spacing, and any number a double cannot
// hold — a viewer should show what is stored, not a reconstruction of it. It also
// means a JS array unambiguously came from a Postgres array type, which is what
// lets the codec render `{1,2}` instead of `[1,2]`.
setTypeParser(OID.json, (text) => text);
setTypeParser(OID.jsonb, (text) => text);

// interval, time, timetz and money: `pg` turns these into JS objects (`interval`
// becomes `{days:1,hours:2,…}`) or Dates anchored at 1970. Neither is what the
// server sent, and neither is what psql shows. There is no arithmetic to do on
// them in a read-only viewer, so the text is the value.
setTypeParser(OID.interval, (text) => text);
setTypeParser(OID.time, (text) => text);
setTypeParser(OID.timetz, (text) => text);
setTypeParser(OID.money, (text) => text);

export interface PgField {
  readonly name: string;
  readonly dataTypeID: number;
}

export interface PgQueryResult {
  /** Positional rows: `rows[r][c]`. */
  readonly rows: readonly (readonly unknown[])[];
  readonly fields: readonly PgField[];
  readonly rowCount: number;
}

/** A checked-out client. Used for cursors, which must stay on one session. */
export interface PgClientHandle {
  readonly backendPid: number;
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  release(): void;
}

export interface PgSession {
  readonly backendPid: number;
  readonly serverVersion: string;
  /** One-shot query on any pooled client. */
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  /** A dedicated client, held until released. */
  acquire(): Promise<PgClientHandle>;
  /** `pg_cancel_backend` on the reserved connection. */
  cancel(backendPid: number): Promise<Result<void>>;
  end(): Promise<void>;
}

export interface PgDriver {
  connect(config: PgConnectionConfig, limits?: Partial<SessionLimits>): Promise<PgSession>;
}

async function run(
  client: PoolClient,
  text: string,
  values?: readonly unknown[],
): Promise<PgQueryResult> {
  const result = await client.query({
    text,
    values: values as unknown[] | undefined,
    rowMode: 'array',
  });
  return {
    rows: result.rows as unknown as readonly (readonly unknown[])[],
    fields: result.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })),
    rowCount: result.rowCount ?? 0,
  };
}

async function readScalar(client: PoolClient, text: string): Promise<string> {
  const result = await client.query({ text, rowMode: 'array' });
  const row = result.rows[0] as unknown[] | undefined;
  const value = row?.[0];
  return typeof value === 'string' ? value : String(value ?? '');
}

class PgSessionImpl implements PgSession {
  readonly backendPid: number;
  readonly serverVersion: string;

  private readonly pool: Pool;
  private readonly cancelClient: PoolClient;
  private ended = false;

  constructor(pool: Pool, cancelClient: PoolClient, backendPid: number, serverVersion: string) {
    this.pool = pool;
    this.cancelClient = cancelClient;
    this.backendPid = backendPid;
    this.serverVersion = serverVersion;
  }

  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult> {
    return this.withPooledClient(text, values);
  }

  private async withPooledClient(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult> {
    const client = await this.pool.connect();
    try {
      return await run(client, text, values);
    } finally {
      client.release();
    }
  }

  async acquire(): Promise<PgClientHandle> {
    const client = await this.pool.connect();
    let released = false;
    /** Set when the server closes this backend out from under us. */
    let broken: Error | null = null;

    const release = (error?: Error): void => {
      // Releasing twice corrupts the pool's free list, and a cursor is closed on
      // both the disposal path and the eviction path — and now also by the error
      // handler below, which can win the race against either.
      if (released) return;
      released = true;
      try {
        client.release(error);
      } catch (caught) {
        logError(`${SCOPE}:release`, caught);
      }
    };

    /**
     * A checked-out client is **not** covered by the pool's own `error` handler —
     * `pg` emits that only for idle clients. Without this listener an `error` on a
     * live client is an unhandled EventEmitter error, which Node rethrows as an
     * uncaught exception and the entire app dies.
     *
     * The trigger is not exotic: `idle_in_transaction_session_timeout` is 60s, and
     * a result tab holds a `REPEATABLE READ` transaction open for as long as the
     * user leaves it on screen. Leave a query result sitting for a minute and the
     * server terminates the backend — an ordinary, documented event that used to be
     * fatal. Found by the smoke harness, which hung instead of reporting until it
     * was given crash handlers; the crash was the app's, not the harness's.
     *
     * The slot is given back rather than held: the backend is gone, so keeping the
     * client checked out would leak one of the pool's few slots permanently.
     */
    client.on('error', (error: Error) => {
      broken = error;
      logError(`${SCOPE}:client`, error);
      release(error);
    });

    // The pid identifies the backend running *this* client's query, which is what
    // `pg_cancel_backend` needs. Reading it once at acquire time is one round trip
    // per cursor, not one per fetch.
    let pid: number;
    try {
      pid = Number(await readScalar(client, 'select pg_backend_pid()'));
    } catch (error) {
      release(error instanceof Error ? error : undefined);
      throw error;
    }

    return {
      backendPid: Number.isFinite(pid) ? pid : 0,
      query: (text, values) => {
        const failure = broken;
        // Fail fast rather than queue onto a socket the server has already closed,
        // which would otherwise hang until the pool's own timeout noticed.
        if (failure !== null) return Promise.reject(failure);
        return run(client, text, values);
      },
      release: () => release(),
    };
  }

  async cancel(backendPid: number): Promise<Result<void>> {
    if (this.ended) {
      return err<void>({ code: 'CONN_LOST', message: 'the connection is already closed' });
    }
    const statement = cancelBackendSql(backendPid);
    try {
      await run(this.cancelClient, statement.text, statement.values);
      return ok(undefined);
    } catch (error) {
      logError(`${SCOPE}:cancel`, error);
      return err<void>(toTabbyError(error));
    }
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try {
      this.cancelClient.release();
    } catch {
      // Already gone; the pool teardown below is what matters.
    }
    await this.pool.end();
  }
}

/**
 * Applies the session characteristics to a freshly connected client.
 *
 * Runs on the pool's `connect` event so that *every* backend is hardened, not
 * just the first one. Failure to apply them is fatal for that client: a backend
 * without `default_transaction_read_only` is a writable connection to somebody's
 * production database, and continuing would be the unsafe choice.
 */
function hardenClient(client: PoolClient, limits: Partial<SessionLimits>): void {
  // One multi-statement simple query, enqueued **synchronously**.
  //
  // Both details matter. Enqueueing inside a `.then()` defers to a microtask, and
  // the pool resolves the waiting caller in the same tick — so the caller's first
  // query can be queued ahead of the SETs and run against an unhardened backend.
  // That was observed for real: `current_setting('TimeZone')` came back as the host
  // zone on a connection that had already reported read-only mode as on.
  //
  // Sending the eight SETs as one statement also makes hardening atomic and costs
  // one round trip instead of eight.
  const statement = sessionStatements(limits).join('; ');
  client.query(statement).catch((error: unknown) => {
    logError(`${SCOPE}:harden`, error);
    // Never `release()` here: the pool handed us this client and still owns its
    // lifecycle, so releasing it throws "already released". Ending the socket is
    // both safe and fail-closed — a backend that could not be put into read-only
    // mode must not stay in service.
    try {
      void Promise.resolve(client.end()).catch(() => undefined);
    } catch {
      // Already gone; the pool will reap it.
    }
  });
}

export function createPgDriver(): PgDriver {
  return {
    async connect(
      config: PgConnectionConfig,
      limits: Partial<SessionLimits> = {},
    ): Promise<PgSession> {
      const pool = new pg.Pool({ ...config });
      pool.on('connect', (client) => hardenClient(client, limits));
      pool.on('error', (error) => {
        // An idle client failing must not become an unhandled rejection that takes
        // the main process down.
        logError(`${SCOPE}:pool`, error);
      });

      logInfo(SCOPE, `connecting ${describeConfigForLog(config)}`);

      let cancelClient: PoolClient;
      try {
        cancelClient = await pool.connect();
      } catch (error) {
        await pool.end().catch(() => undefined);
        throw error;
      }

      try {
        // Reading these on the reserved client doubles as the health check: if the
        // credential or the SSL mode is wrong, this is where it surfaces.
        const pid = Number(await readScalar(cancelClient, 'select pg_backend_pid()'));
        const version = await readScalar(cancelClient, 'select version()');
        return new PgSessionImpl(pool, cancelClient, Number.isFinite(pid) ? pid : 0, version);
      } catch (error) {
        cancelClient.release();
        await pool.end().catch(() => undefined);
        throw error;
      }
    },
  };
}
