/**
 * Mapping a `pg` failure onto the tagged error union that crosses IPC
 * (PLAN Phase 4, ARCHITECTURE §8).
 *
 * The renderer branches on `code` and never on message text, so this mapping has
 * to be explicit and total: every input — including a string, a symbol, an object
 * with a throwing getter, or a circular structure — produces a `TabbyError`, and
 * nothing here throws.
 *
 * Two hazards specific to this boundary:
 *
 *  - `pg` puts the SQLSTATE on `.code` and Node puts the socket error on `.code`
 *    too. They are told apart by shape: a SQLSTATE is exactly five characters of
 *    `[0-9A-Z]`. Confusing them would report `ECONNREFUSED` as a syntax error.
 *  - Postgres and the TLS stack both echo connection details into error text, so
 *    the message is redacted here rather than trusting each call site.
 */
import { scrub, type TabbyError, type TabbyErrorCode } from '../../shared/errors';

/** Postgres SQLSTATE: five characters from `[0-9A-Z]`. */
const SQL_STATE = /^[0-9A-Z]{5}$/;

/** Longer than any useful diagnostic, shorter than a way to flood a log file. */
const MAX_MESSAGE_LENGTH = 1_000;

const SOCKET_CODES: Readonly<Record<string, TabbyErrorCode>> = {
  ECONNREFUSED: 'CONN_REFUSED',
  EHOSTUNREACH: 'CONN_REFUSED',
  ENETUNREACH: 'CONN_REFUSED',
  ENOTFOUND: 'DNS_FAILED',
  EAI_AGAIN: 'DNS_FAILED',
  ETIMEDOUT: 'CONN_TIMEOUT',
  ECONNRESET: 'CONN_LOST',
  EPIPE: 'CONN_LOST',
};

/** TLS failures arrive as `.code` on some paths and only in the text on others. */
const TLS_CODES: readonly string[] = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_CRL_ISSUER',
  'SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
];

const TLS_PATTERN = new RegExp(`${TLS_CODES.join('|')}|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+`);

const LOST_PATTERN =
  /connection terminated unexpectedly|client has already been released|connection lost/i;

/** A credential inside a URI: `scheme://user:secret@host`. */
const URI_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s]+)(@)/gi;
/** The same credential passed as a query parameter. */
const QUERY_CREDENTIAL = /([?&](?:password|pwd|passwd)=)[^&\s]*/gi;

export function isSqlState(code: unknown): code is string {
  return typeof code === 'string' && SQL_STATE.test(code);
}

/** Safe property read: never throws, never follows a throwing getter. */
function read(target: unknown, key: string): unknown {
  if (target === null || target === undefined) return undefined;
  const kind = typeof target;
  if (kind !== 'object' && kind !== 'function') return undefined;
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The SQLSTATE of a server error, or null.
 *
 * `pg` puts the SQLSTATE on `.code` and Node puts the socket error on `.code`
 * too, and the shapes collide: `EPIPE` and `EPERM` are both exactly five
 * characters of `[0-9A-Z]`. Every Node errno name starts with `E` and no
 * Postgres SQLSTATE class does — the class table is digits plus `0A 0B 0D 0F 0L
 * 0P 0Z 2D 2F 3B 3D 3F 42 53 54 55 57 58 72 F0 HV P0 XX` — so an `E` prefix is
 * enough to tell them apart.
 */
const NODE_ERRNO_SHAPE = /^E[A-Z0-9]{4}$/;

export function sqlStateOf(error: unknown): string | null {
  const code = read(error, 'code');
  if (!isSqlState(code)) return null;
  return NODE_ERRNO_SHAPE.test(code) || code in SOCKET_CODES ? null : code;
}

function codeForSqlState(state: string): TabbyErrorCode {
  switch (state) {
    // read_only_sql_transaction — the assertion behind Phase 4's exit criterion.
    case '25006':
      return 'READ_ONLY_VIOLATION';
    case '57014': // query_canceled
      return 'QUERY_CANCELLED';
    case '42P01': // undefined_table
      return 'RELATION_NOT_FOUND';
    case '42501': // insufficient_privilege
      return 'PERMISSION_DENIED';
    case '34000': // invalid_cursor_name — the cursor was closed or never existed
      return 'CURSOR_CLOSED';
    case '3D000': // invalid_catalog_name — the database does not exist
    case '3F000': // invalid_schema_name
      return 'NOT_FOUND';
    default:
      break;
  }

  switch (state.slice(0, 2)) {
    case '08': // connection_exception
      return state === '08001' || state === '08004' ? 'CONN_REFUSED' : 'CONN_LOST';
    case '28': // invalid_authorization_specification
      return 'AUTH_FAILED';
    case '42': // syntax_error_or_access_rule_violation
      return 'SYNTAX_ERROR';
    case '57': // operator_intervention: admin shutdown, crash recovery
      return 'CONN_LOST';
    default:
      return 'INTERNAL';
  }
}

function isTlsCode(code: string): boolean {
  return TLS_CODES.includes(code) || /^CERT_[A-Z_]+$/.test(code) || /^ERR_TLS_[A-Z_]+$/.test(code);
}

function codeWithoutSqlState(error: unknown, message: string): TabbyErrorCode {
  const rawCode = read(error, 'code');
  if (typeof rawCode === 'string' && rawCode !== '') {
    const mapped = SOCKET_CODES[rawCode];
    if (mapped) return mapped;
    if (isTlsCode(rawCode)) return 'SSL_REJECTED';
  }
  if (TLS_PATTERN.test(message)) return 'SSL_REJECTED';
  if (LOST_PATTERN.test(message)) return 'CONN_LOST';
  return 'INTERNAL';
}

function rawMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error === null) return 'null';
  if (error === undefined) return 'undefined';

  const message = read(error, 'message');
  if (typeof message === 'string' && message !== '') return message;

  // `String(symbol)` works; `${symbol}` throws. Never interpolate an unknown value.
  try {
    const text = String(error);
    if (text !== '[object Object]') return text;
  } catch {
    // fall through to the constructor name
  }

  const name = read(error, 'name');
  return typeof name === 'string' && name !== '' ? name : 'unknown error';
}

function redact(message: string): string {
  return message
    .replace(URI_CREDENTIAL, '$1[redacted]$3')
    .replace(QUERY_CREDENTIAL, '$1[redacted]');
}

function buildMessage(error: unknown): string {
  const parts: string[] = [];

  const message = rawMessage(error);
  if (message !== '') parts.push(message);

  // The hint is the useful half of a missing-relation error ("Perhaps you meant
  // to reference the table …"), so it is worth the extra line.
  const hint = read(error, 'hint');
  if (typeof hint === 'string' && hint.trim() !== '') parts.push(hint.trim());

  const detail = read(error, 'detail');
  if (typeof detail === 'string' && detail.trim() !== '') parts.push(detail.trim());

  const joined = scrub(redact(parts.join(' — ')));
  return joined.length > MAX_MESSAGE_LENGTH ? `${joined.slice(0, MAX_MESSAGE_LENGTH)}…` : joined;
}

/**
 * pg reports `position` as a 1-based *string* offset into the query; the console
 * underlines a 0-based offset. Anything that is not a positive integer is
 * dropped rather than guessed at.
 */
function readPosition(error: unknown): number | undefined {
  const raw = read(error, 'position');
  let value: number;
  if (typeof raw === 'number') value = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw)) value = Number(raw);
  else return undefined;

  if (!Number.isInteger(value) || value < 1) return undefined;
  return value - 1;
}

export interface ErrorContext {
  readonly connectionId?: string;
  readonly resultId?: string;
}

export function toTabbyError(error: unknown, context: ErrorContext = {}): TabbyError {
  const sqlState = sqlStateOf(error);
  const message = buildMessage(error);
  const code = sqlState ? codeForSqlState(sqlState) : codeWithoutSqlState(error, message);
  const position = readPosition(error);

  return {
    code,
    message,
    ...(sqlState === null ? {} : { sqlState }),
    ...(position === undefined ? {} : { position }),
    ...(context.connectionId === undefined ? {} : { connectionId: context.connectionId }),
    ...(context.resultId === undefined ? {} : { resultId: context.resultId }),
  };
}
