/**
 * The session characteristics applied to every new Postgres backend
 * (PLAN Phase 4, ARCHITECTURE §5.1).
 *
 * `default_transaction_read_only` is the real v1 safety guarantee: the server
 * enforces it, so a bug in our SQL construction cannot write. That makes the
 * *ordering* here a correctness property — read-only must be in effect before
 * anything else can run on the backend, which is why it is element zero and why
 * the caller is expected to run these in order on a fresh connection.
 *
 * Every right-hand side below is either a bare integer or one of four fixed
 * string literals. Nothing caller-supplied is interpolated, so this module
 * cannot become an injection point.
 */

/** Shows up in the server's pg_stat_activity, so a DBA can see who we are. */
export const APPLICATION_NAME = 'tabby';

export const READ_ONLY_STATEMENT = 'SET default_transaction_read_only = on';

export interface SessionLimits {
  readonly statementTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
  readonly lockTimeoutMs: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  statementTimeoutMs: 30_000,
  idleInTransactionTimeoutMs: 60_000,
  lockTimeoutMs: 5_000,
};

/**
 * An hour. Long enough for a big export, short enough that a nonsense value
 * cannot pin a backend — and therefore a cursor's xmin horizon — for days.
 */
export const MAX_TIMEOUT_MS = 3_600_000;

/** Setting name per limit, used verbatim in the emitted SQL and in error text. */
const SETTING_NAMES = {
  statementTimeoutMs: 'statement_timeout',
  idleInTransactionTimeoutMs: 'idle_in_transaction_session_timeout',
  lockTimeoutMs: 'lock_timeout',
} as const satisfies Record<keyof SessionLimits, string>;

export class SessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConfigError';
  }
}

function timeout(value: unknown, key: keyof SessionLimits): number {
  const setting = SETTING_NAMES[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SessionConfigError(
      `${setting} must be an integer number of milliseconds, received ${
        value === null ? 'null' : typeof value
      }`,
    );
  }
  if (!Number.isFinite(value)) {
    throw new SessionConfigError(`${setting} must be finite`);
  }
  if (value <= 0) {
    // Zero is not "very fast" in Postgres; it means no timeout at all, which is
    // precisely the failure mode these limits exist to prevent.
    throw new SessionConfigError(
      `${setting} must be greater than zero — Postgres reads 0 as "no timeout"`,
    );
  }
  if (value > MAX_TIMEOUT_MS) {
    throw new SessionConfigError(`${setting} must not exceed ${MAX_TIMEOUT_MS}ms`);
  }
  return value;
}

/** Validates a partial override and fills the gaps from the defaults. */
export function resolveLimits(limits: Partial<SessionLimits> = {}): SessionLimits {
  const merged: SessionLimits = { ...DEFAULT_SESSION_LIMITS, ...definedOnly(limits) };
  return {
    statementTimeoutMs: timeout(merged.statementTimeoutMs, 'statementTimeoutMs'),
    idleInTransactionTimeoutMs: timeout(
      merged.idleInTransactionTimeoutMs,
      'idleInTransactionTimeoutMs',
    ),
    lockTimeoutMs: timeout(merged.lockTimeoutMs, 'lockTimeoutMs'),
  };
}

/**
 * Spreading `{ statementTimeoutMs: undefined }` over the defaults would replace a
 * real value with undefined, so explicit-undefined keys are dropped first. That
 * makes "the caller passed a partial object built conditionally" behave the same
 * as "the caller passed nothing".
 */
function definedOnly(limits: Partial<SessionLimits>): Partial<SessionLimits> {
  const result: Record<string, number> = {};
  for (const key of Object.keys(SETTING_NAMES) as (keyof SessionLimits)[]) {
    const value = limits[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * The statements to run, in order, on every new backend. Returned as an array
 * without trailing semicolons so the caller can execute them one at a time and
 * attribute a failure to the specific setting that was rejected.
 */
export function sessionStatements(limits: Partial<SessionLimits> = {}): readonly string[] {
  const resolved = resolveLimits(limits);
  return [
    READ_ONLY_STATEMENT,
    // Bare integers: Postgres documents these three settings in milliseconds, so
    // there is no unit string to misparse across server versions.
    `SET statement_timeout = ${resolved.statementTimeoutMs}`,
    `SET idle_in_transaction_session_timeout = ${resolved.idleInTransactionTimeoutMs}`,
    `SET lock_timeout = ${resolved.lockTimeoutMs}`,
    "SET client_encoding = 'UTF8'",
    "SET DateStyle = 'ISO, MDY'",
    // Normalise to UTC on the wire; the renderer converts for display. Without
    // this, the same row renders differently on two machines.
    "SET timezone = 'UTC'",
    `SET application_name = '${APPLICATION_NAME}'`,
  ];
}
