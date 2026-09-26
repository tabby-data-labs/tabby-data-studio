/**
 * One tagged error union for everything crossing the IPC bridge.
 *
 * The renderer branches on `code`, never on message text. Thrown errors lose
 * their shape across contextBridge, so handlers always return a Result.
 */

export type TabbyErrorCode =
  // connection
  | 'CONN_REFUSED'
  | 'AUTH_FAILED'
  | 'SSL_REQUIRED'
  | 'SSL_REJECTED'
  | 'DNS_FAILED'
  | 'CONN_TIMEOUT'
  | 'CONN_LOST'
  // query
  | 'QUERY_TIMEOUT'
  | 'QUERY_CANCELLED'
  | 'SYNTAX_ERROR'
  | 'RELATION_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'READ_ONLY_VIOLATION'
  // results
  | 'RESULT_EVICTED'
  | 'CURSOR_CLOSED'
  | 'RESULT_NOT_FOUND'
  // plumbing
  | 'VALIDATION_FAILED'
  | 'NOT_CONNECTED'
  | 'INTERNAL';

export interface TabbyError {
  readonly code: TabbyErrorCode;
  readonly message: string;
  /** Postgres SQLSTATE, when the error came from the server. */
  readonly sqlState?: string;
  /** Zero-based character offset for syntax errors, so the console can underline the token. */
  readonly position?: number;
  readonly connectionId?: string;
  readonly resultId?: string;
  readonly field?: string;
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: TabbyError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(error: TabbyError): Result<T> {
  return { ok: false, error };
}

/** Redacts anything that could carry a secret before it leaves the main process. */
export function scrub(message: string): string {
  return message.replace(/(password|pwd|secret|token)=\S+/gi, '$1=[redacted]');
}
