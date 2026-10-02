/**
 * Mapping a saved connection onto a `pg` pool configuration
 * (PLAN Phase 4, ARCHITECTURE §5.1).
 *
 * Two properties are load-bearing and both are tested:
 *
 *  1. **SSL mode is never downgraded silently.** Only `disable` yields
 *     `ssl: false`; an unrecognised mode is a hard error rather than a default.
 *     `verify-ca` and `verify-full` are distinguished the way libpq distinguishes
 *     them — chain verification in both, hostname verification only in the
 *     latter — rather than collapsing into one "use TLS" flag.
 *  2. **The password cannot escape.** There is no `connectionString` anywhere (a
 *     URL would embed it), the key is absent entirely when there is no secret,
 *     and the log description is built from an explicit field list.
 *
 * This module deliberately does not import `pg`: only `driver-pg.ts` may. The
 * shape below is structurally assignable to `pg.PoolConfig`, which driver-pg
 * relies on and its own typecheck enforces.
 */
import { checkServerIdentity as nodeCheckServerIdentity, type PeerCertificate } from 'node:tls';
import type { StoredConnection } from '../../shared/domain';
import { scrub } from '../../shared/errors';
import { APPLICATION_NAME, resolveLimits, type SessionLimits } from './session';

/**
 * Concurrent server-side cursors per connection. Each holds a checked-out client
 * for as long as its result is alive, so this is a real memory-and-xmin budget,
 * not a tuning knob.
 */
export const MAX_CONCURRENT_CURSORS = 4;

/**
 * One client is permanently reserved for `pg_cancel_backend`. Cancelling on the
 * busy connection is impossible — it is blocked waiting for the server — so the
 * reserve is not optional headroom.
 */
export const RESERVED_CANCEL_CONNECTIONS = 1;

/**
 * Clients left over for auxiliary reads: catalog queries and the background
 * `count(*)`. Without headroom, `MAX_CONCURRENT_CURSORS` results plus the reserved
 * cancel client would occupy every slot, and the next catalog read would queue
 * behind a cursor that is only released when its tab closes — a deadlock that
 * looks like a hung UI.
 */
export const AUX_CONNECTIONS = 2;

const MAX_POOL_SIZE = 16;
const IDLE_TIMEOUT_MS = 60_000;
/** A connect that hangs forever is worse than one that fails: the UI would spin. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Mirror the IPC layer's caps; re-checking here is defence in depth. */
const MAX_HOST_LENGTH = 253;
const MAX_NAME_LENGTH = 200;

export interface PgSslConfig {
  readonly rejectUnauthorized: boolean;
  /** SNI name. Absent for a Unix-socket host, where SNI is meaningless. */
  readonly servername?: string;
  readonly checkServerIdentity?: (host: string, cert: unknown) => Error | undefined;
}

export interface PgConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** Absent, never `undefined` or `''`, when the connection has no password. */
  readonly password?: string;
  readonly ssl: false | PgSslConfig;
  readonly application_name: string;
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
  readonly statement_timeout: number;
  readonly lock_timeout: number;
  readonly idle_in_transaction_session_timeout: number;
}

export class PgConfigError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message === '' ? field : `${field}: ${message}`);
    this.name = 'PgConfigError';
    this.field = field;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new PgConfigError(field, `expected a string, received ${describeType(value)}`);
  }
  if (value.length === 0) throw new PgConfigError(field, 'must not be empty');
  if (value.includes('\u0000')) {
    // libpq treats a NUL as the end of the value, so `db\u0000other` would connect
    // somewhere the user did not ask for.
    throw new PgConfigError(field, 'must not contain a NUL byte');
  }
  if (value.length > maxLength) {
    throw new PgConfigError(field, `must not exceed ${maxLength} characters`);
  }
  return value;
}

/** A Unix-socket directory rather than a TCP host. */
function isSocketPath(host: string): boolean {
  return host.startsWith('/');
}

function verifyHostname(host: string, cert: unknown): Error | undefined {
  return nodeCheckServerIdentity(host, cert as PeerCertificate);
}

function withServerName(ssl: Omit<PgSslConfig, 'servername'>, host: string): PgSslConfig {
  return isSocketPath(host) ? ssl : { ...ssl, servername: host };
}

/**
 * `prefer` cannot mean what libpq means by it: node-postgres has no
 * try-TLS-then-fall-back-to-plaintext negotiation. It is mapped to "encrypt, do
 * not verify", i.e. it behaves like `require`. The UI should say so rather than
 * let a user believe plaintext was attempted.
 */
function sslFor(mode: unknown, host: string): false | PgSslConfig {
  switch (mode) {
    case 'disable':
      return false;
    case 'prefer':
    case 'require':
      return withServerName({ rejectUnauthorized: false }, host);
    case 'verify-ca':
      // Chain verified, hostname deliberately not: that is the entire difference
      // between verify-ca and verify-full, and collapsing them would make one of
      // the two modes a lie.
      return withServerName(
        { rejectUnauthorized: true, checkServerIdentity: () => undefined },
        host,
      );
    case 'verify-full':
      return withServerName(
        { rejectUnauthorized: true, checkServerIdentity: verifyHostname },
        host,
      );
    default:
      throw new PgConfigError('sslMode', `unsupported value (${describeType(mode)})`);
  }
}

/** Cursor slots, the reserved cancel connection, and headroom for catalog reads. */
export function poolSizeFor(maxConcurrentCursors: number): number {
  if (!Number.isInteger(maxConcurrentCursors) || maxConcurrentCursors < 1) {
    throw new PgConfigError(
      'maxConcurrentCursors',
      'must be a positive integer — a pool of zero cannot run a query',
    );
  }
  const size = maxConcurrentCursors + RESERVED_CANCEL_CONNECTIONS + AUX_CONNECTIONS;
  if (size > MAX_POOL_SIZE) {
    throw new PgConfigError(
      'maxConcurrentCursors',
      `would need a pool of ${size}, over the cap of ${MAX_POOL_SIZE}`,
    );
  }
  return size;
}

export function toPgConfig(
  connection: StoredConnection,
  password: string | null,
  limits: Partial<SessionLimits> = {},
): PgConnectionConfig {
  if (typeof connection !== 'object' || connection === null) {
    throw new PgConfigError(
      'connection',
      `expected an object, received ${describeType(connection)}`,
    );
  }

  const host = text(connection.host, 'host', MAX_HOST_LENGTH);
  const database = text(connection.database, 'database', MAX_NAME_LENGTH);
  const user = text(connection.user, 'user', MAX_NAME_LENGTH);

  const port = connection.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PgConfigError('port', 'must be an integer between 1 and 65535');
  }

  if (password !== null && password !== undefined && typeof password !== 'string') {
    throw new PgConfigError(
      'password',
      `expected a string or null, received ${describeType(password)}`,
    );
  }

  const resolved = resolveLimits(limits);

  const base: PgConnectionConfig = {
    host,
    port,
    database,
    user,
    ssl: sslFor(connection.sslMode, host),
    application_name: APPLICATION_NAME,
    max: poolSizeFor(MAX_CONCURRENT_CURSORS),
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Also set per-client by the pool, not only by the SET statements in
    // session.ts: a client created lazily after connect must not run unlimited.
    statement_timeout: resolved.statementTimeoutMs,
    lock_timeout: resolved.lockTimeoutMs,
    idle_in_transaction_session_timeout: resolved.idleInTransactionTimeoutMs,
  };

  // An empty password is "no password", matching how SettingsStore decides
  // whether to encrypt one. The key is omitted rather than set to '' so it cannot
  // be serialised into a crash report or a log line by a careless spread.
  return password ? { ...base, password } : base;
}

/**
 * A single-line description for logs. Built from an explicit field list — never
 * from the config object itself — so a field added later cannot leak by default.
 */
export function describeConfigForLog(config: PgConnectionConfig): string {
  const ssl =
    config.ssl === false
      ? 'ssl=off'
      : `ssl=on,verify=${config.ssl.rejectUnauthorized ? 'yes' : 'no'}`;
  return scrub(
    `host=${config.host} port=${config.port} db=${config.database} user=${config.user} ${ssl}`,
  );
}
