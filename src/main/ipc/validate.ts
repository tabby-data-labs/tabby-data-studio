/**
 * Hand-written IPC boundary validators (PLAN Phase 3, ARCHITECTURE §3).
 *
 * The renderer is untrusted input. Every payload crossing the bridge is checked
 * here before any handler sees it, so a compromised renderer cannot smuggle
 * extra fields, pollute a prototype, ask for an unbounded window, or push a NUL
 * byte into a statement.
 *
 * Deliberately no third-party schema library: this is ~200 lines with no
 * dependencies, and it is the security boundary of the whole app.
 *
 * Scope note — what this layer does and does not own:
 *  - It validates **shape and bounds**. Type, range, length, allowed keys.
 *  - It does NOT escape SQL. Identifier quoting is `quoteIdent`'s job in exactly
 *    one place (Phase 4). Rejecting a `"` here would make a legitimately-named
 *    Postgres identifier unbrowsable without making anything safer.
 */
import type {
  BrowseTarget,
  ConnSaveRequest,
  ExportStartRequest,
  HistoryAddRequest,
  QueryRunRequest,
  ResultSortRequest,
  ResultWindowRequest,
  SchemaChildrenRequest,
  SchemaTableRequest,
} from '../../shared/ipc-contract';
import { HISTORY_LIMITS, type HistoryStatus } from '../../shared/history';
import {
  EXPORT_ENCODINGS,
  EXPORT_FORMATS,
  EXPORT_LINE_ENDINGS,
  type ExportOptions,
} from '../../shared/export';
import type { SettingsPatch, SortSpec, WindowState } from '../../shared/domain';

/** Raised for any rejected payload. `field` is a dotted path for logging and UI. */
export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(field === '' ? message : `${field}: ${message}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// ── Limits ───────────────────────────────────────────────────────────────────

/** Rows per window request. Bounded so one call cannot ask for a whole table. */
export const MAX_WINDOW_ROWS = 10_000;
/** SQL text cap. A real migration script is kilobytes, not megabytes. */
export const MAX_SQL_LENGTH = 1_000_000;
/** Postgres truncates identifiers at NAMEDATALEN-1 = 63. */
export const MAX_IDENTIFIER_LENGTH = 63;
export const MAX_ID_LENGTH = 128;
export const MAX_NAME_LENGTH = 200;
export const MAX_PASSWORD_LENGTH = 1024;
/** Hostnames cap at 253 characters per RFC 1035. */
export const MAX_HOST_LENGTH = 253;
export const MAX_WINDOW_DIMENSION = 32_768;
export const MAX_WINDOW_POSITION = 1_000_000;

const SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;
const THEMES = ['dark', 'light'] as const;
const SORT_DIRECTIONS = ['asc', 'desc'] as const;
const HISTORY_STATUSES: readonly HistoryStatus[] = ['ok', 'failed', 'cancelled'];

const CONNECTION_FIELDS = [
  'id',
  'name',
  'host',
  'port',
  'database',
  'user',
  'sslMode',
  'createdAt',
  'updatedAt',
] as const;

const WINDOW_FIELDS = ['x', 'y', 'width', 'height', 'isMaximized', 'isFullScreen'] as const;

/**
 * Keys that must never be accepted from the renderer. `JSON.parse` creates
 * `__proto__` as an own property rather than invoking the setter, so it shows up
 * in `Object.keys` and can be caught here — but only if we look.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Control characters and NUL: never legitimate in an identifier, and a NUL in a
// statement would truncate it server-side, splitting one query into two.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function nested(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

// ── Primitives ───────────────────────────────────────────────────────────────

function object(value: unknown, field: string): Record<string, unknown> {
  // typeof null is 'object', arrays are objects, and a function is neither —
  // all three must be refused before we start reading keys.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(field, 'expected an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ValidationError(nested(field, key), 'forbidden key');
    }
  }
  return record;
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(nested(field, key), 'unexpected key');
    }
  }
}

interface StringOptions {
  readonly max?: number;
  readonly allowEmpty?: boolean;
}

function str(value: unknown, field: string, options: StringOptions = {}): string {
  if (typeof value !== 'string') throw new ValidationError(field, 'expected a string');
  const max = options.max ?? MAX_NAME_LENGTH;
  if (value.length > max) throw new ValidationError(field, `exceeds ${max} characters`);
  if (value.length === 0 && !options.allowEmpty) {
    throw new ValidationError(field, 'must not be empty');
  }
  return value;
}

function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(field, 'expected an integer');
  }
  if (value < min || value > max) {
    throw new ValidationError(field, `out of range ${min}..${max}`);
  }
  return value;
}

function finite(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(field, 'expected a finite number');
  }
  if (value < min || value > max) {
    throw new ValidationError(field, `out of range ${min}..${max}`);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(field, 'expected a boolean');
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(field, `must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** A Postgres identifier: bounded, and free of control characters. */
function identifier(value: unknown, field: string): string {
  const text = str(value, field, { max: MAX_IDENTIFIER_LENGTH });
  if (CONTROL_CHARS.test(text)) {
    throw new ValidationError(field, 'contains control characters');
  }
  return text;
}

/** SQL text: bounded, and never containing a NUL byte. */
function sqlText(value: unknown, field: string): string {
  const text = str(value, field, { max: MAX_SQL_LENGTH });
  if (text.includes('\u0000')) {
    throw new ValidationError(field, 'contains a NUL byte');
  }
  return text;
}

function optional<T>(
  record: Record<string, unknown>,
  key: string,
  field: string,
  parse: (value: unknown, path: string) => T,
): T | undefined {
  const value = record[key];
  return value === undefined ? undefined : parse(value, field);
}

// ── Request validators ───────────────────────────────────────────────────────

export function validateResultWindow(value: unknown): ResultWindowRequest {
  const record = object(value, 'request');
  exactKeys(record, ['resultId', 'startRow', 'rowCount'], '');
  return {
    resultId: str(record['resultId'], 'resultId', { max: MAX_ID_LENGTH }),
    startRow: int(record['startRow'], 'startRow', 0, Number.MAX_SAFE_INTEGER),
    rowCount: int(record['rowCount'], 'rowCount', 1, MAX_WINDOW_ROWS),
  };
}

export function validateQueryRun(value: unknown): QueryRunRequest {
  const record = object(value, 'request');
  exactKeys(record, ['connectionId', 'sql', 'initialRows', 'browse'], '');
  const connectionId = str(record['connectionId'], 'connectionId', { max: MAX_ID_LENGTH });
  const sql = sqlText(record['sql'], 'sql');
  const initialRows = optional(record, 'initialRows', 'initialRows', (v, f) =>
    int(v, f, 1, MAX_WINDOW_ROWS),
  );
  const browse = optional(record, 'browse', 'browse', validateBrowse);
  return {
    connectionId,
    sql,
    ...(initialRows === undefined ? {} : { initialRows }),
    ...(browse === undefined ? {} : { browse }),
  };
}

/**
 * The table a plain scan targets.
 *
 * Names only — the renderer never chooses key columns, because which columns
 * identify a row is a correctness decision main makes from the catalog.
 */
function validateBrowse(value: unknown, field: string): BrowseTarget {
  const record = object(value, field);
  exactKeys(record, ['schema', 'table'], field);
  return {
    schema: identifier(record['schema'], nested(field, 'schema')),
    table: identifier(record['table'], nested(field, 'table')),
  };
}

/**
 * Every single-identifier channel (`conn:delete`, `conn:open`, `conn:close`,
 * `conn:test`, `query:cancel`, `result:dispose`) carries a bare string, matching
 * the `DatabaseApi` signatures. One validator, no per-channel wrapper.
 */
export function validateConnectionId(value: unknown): string {
  return str(value, 'connectionId', { max: MAX_ID_LENGTH });
}

export function validateResultId(value: unknown): string {
  return str(value, 'resultId', { max: MAX_ID_LENGTH });
}

export function validateConnSave(value: unknown): ConnSaveRequest {
  const record = object(value, 'request');
  exactKeys(record, ['connection', 'password'], '');

  const raw = object(record['connection'], 'connection');
  exactKeys(raw, CONNECTION_FIELDS, 'connection');

  // Built field by field so the plaintext password can never be spread onto the
  // stored record by accident.
  const connection = {
    id: str(raw['id'], 'connection.id', { max: MAX_ID_LENGTH }),
    name: str(raw['name'], 'connection.name', { max: MAX_NAME_LENGTH }),
    host: str(raw['host'], 'connection.host', { max: MAX_HOST_LENGTH }),
    port: int(raw['port'], 'connection.port', 1, 65_535),
    database: str(raw['database'], 'connection.database', { max: MAX_IDENTIFIER_LENGTH }),
    user: str(raw['user'], 'connection.user', { max: MAX_IDENTIFIER_LENGTH }),
    sslMode: oneOf(raw['sslMode'], SSL_MODES, 'connection.sslMode'),
    createdAt: int(raw['createdAt'], 'connection.createdAt', 0, Number.MAX_SAFE_INTEGER),
    updatedAt: int(raw['updatedAt'], 'connection.updatedAt', 0, Number.MAX_SAFE_INTEGER),
  };

  const password = optional(record, 'password', 'password', (v, f) =>
    str(v, f, { max: MAX_PASSWORD_LENGTH }),
  );
  return password === undefined ? { connection } : { connection, password };
}

export function validateSchemaChildren(value: unknown): SchemaChildrenRequest {
  const record = object(value, 'request');
  exactKeys(record, ['connectionId', 'parentSchema'], '');
  const parentSchema = record['parentSchema'];
  return {
    connectionId: str(record['connectionId'], 'connectionId', { max: MAX_ID_LENGTH }),
    parentSchema: parentSchema === null ? null : identifier(parentSchema, 'parentSchema'),
  };
}

export function validateSchemaTable(value: unknown): SchemaTableRequest {
  const record = object(value, 'request');
  exactKeys(record, ['connectionId', 'schema', 'table'], '');
  return {
    connectionId: str(record['connectionId'], 'connectionId', { max: MAX_ID_LENGTH }),
    schema: identifier(record['schema'], 'schema'),
    table: identifier(record['table'], 'table'),
  };
}

function sortSpec(value: unknown, field: string): SortSpec {
  const record = object(value, field);
  exactKeys(record, ['columnIndex', 'direction'], field);
  return {
    columnIndex: int(record['columnIndex'], nested(field, 'columnIndex'), 0, 4096),
    direction: oneOf(record['direction'], SORT_DIRECTIONS, nested(field, 'direction')),
  };
}

export function validateResultSort(value: unknown): ResultSortRequest {
  const record = object(value, 'request');
  exactKeys(record, ['resultId', 'sort'], '');
  const sort = record['sort'];
  return {
    resultId: str(record['resultId'], 'resultId', { max: MAX_ID_LENGTH }),
    sort: sort === null ? null : sortSpec(sort, 'sort'),
  };
}

// ── Query history (Phase 7) ──────────────────────────────────────────────────

/**
 * One remembered run.
 *
 * `sql` goes through `sqlText`, so the NUL check applies here too: a NUL in a
 * JSONL record would be a record boundary waiting to happen. The length cap is
 * the shared IPC one, not the history one — truncating to the retention limit is
 * the store's decision, and doing it here would hide from the caller that the
 * statement it sent was larger than what gets kept.
 */
export function validateHistoryAdd(value: unknown): HistoryAddRequest {
  const record = object(value, 'request');
  exactKeys(
    record,
    ['sql', 'connectionId', 'connectionLabel', 'status', 'elapsedMs', 'rowCount'],
    '',
  );
  return {
    sql: sqlText(record['sql'], 'sql'),
    connectionId: str(record['connectionId'], 'connectionId', { max: MAX_ID_LENGTH }),
    connectionLabel: str(record['connectionLabel'], 'connectionLabel', {
      max: MAX_NAME_LENGTH * 2,
      allowEmpty: true,
    }),
    status: oneOf(record['status'], HISTORY_STATUSES, 'status'),
    elapsedMs: finite(record['elapsedMs'], 'elapsedMs', -1, Number.MAX_SAFE_INTEGER),
    rowCount: finite(record['rowCount'], 'rowCount', -1, Number.MAX_SAFE_INTEGER),
  };
}

/**
 * The page size for `history:list`.
 *
 * Optional, because "the default" is a main-side retention decision the renderer
 * should not have to know. Capped at the same constant, so a compromised renderer
 * cannot ask for the whole log and hold it in one response.
 */
export function validateHistoryLimit(value: unknown): number {
  if (value === undefined) return HISTORY_LIMITS.maxEntriesReturned;
  return int(value, 'limit', 1, HISTORY_LIMITS.maxEntriesReturned);
}

export function validateHistoryId(value: unknown): string {
  return str(value, 'historyId', { max: MAX_ID_LENGTH });
}

// ── Export (Phase 8) ─────────────────────────────────────────────────────────

/** A separator that would break the record structure it is supposed to delimit. */
const DELIMITER_FORBIDDEN = new Set(['\r', '\n', '"', '\u0000']);
/** Longest NULL spelling anyone plausibly wants; `\N`, `NULL` and `<nil>` all fit. */
const MAX_NULL_TEXT_LENGTH = 32;

/**
 * One export request.
 *
 * There is deliberately no `path` key, and `exactKeys` is what enforces it: the
 * destination comes from `dialog.showSaveDialog` in main. Accepting a path here
 * would let a compromised renderer write anywhere the user's account can.
 *
 * The delimiter and NULL text are constrained beyond "is a string" because both
 * end up inside records. A delimiter of `"` would make every field's quoting
 * ambiguous, a NULL text containing a newline would split one record into two, and
 * neither produces an error — only a file that reads back as something else.
 */
export function validateExportStart(value: unknown): ExportStartRequest {
  const record = object(value, 'request');
  exactKeys(record, ['resultId', 'options'], '');
  return {
    resultId: str(record['resultId'], 'resultId', { max: MAX_ID_LENGTH }),
    options: exportOptions(record['options'], 'options'),
  };
}

function exportOptions(value: unknown, field: string): ExportOptions {
  const record = object(value, field);
  exactKeys(
    record,
    [
      'format',
      'delimiter',
      'includeHeader',
      'nullText',
      'encoding',
      'lineEnding',
      'writeBom',
      'rowsPerInsert',
    ],
    field,
  );

  // `str` with `max: 1` and no `allowEmpty` already guarantees exactly one
  // character; only the *which* character check is left to do here.
  const delimiter = str(record['delimiter'], nested(field, 'delimiter'), { max: 1 });
  if (DELIMITER_FORBIDDEN.has(delimiter)) {
    throw new ValidationError(
      nested(field, 'delimiter'),
      'cannot be a line break, a quote or a NUL byte',
    );
  }

  const nullText = str(record['nullText'], nested(field, 'nullText'), {
    max: MAX_NULL_TEXT_LENGTH,
    allowEmpty: true,
  });
  // CONTROL_CHARS covers CR, LF and NUL, and rejecting the rest is not overreach:
  // a tab would collide with a TSV delimiter and no other control character is a
  // spelling anyone wants for NULL.
  if (CONTROL_CHARS.test(nullText)) {
    throw new ValidationError(nested(field, 'nullText'), 'cannot contain control characters');
  }

  return {
    format: oneOf(record['format'], EXPORT_FORMATS, nested(field, 'format')),
    delimiter,
    includeHeader: bool(record['includeHeader'], nested(field, 'includeHeader')),
    nullText,
    encoding: oneOf(record['encoding'], EXPORT_ENCODINGS, nested(field, 'encoding')),
    lineEnding: oneOf(record['lineEnding'], EXPORT_LINE_ENDINGS, nested(field, 'lineEnding')),
    writeBom: bool(record['writeBom'], nested(field, 'writeBom')),
    rowsPerInsert: int(record['rowsPerInsert'], nested(field, 'rowsPerInsert'), 1, 10_000),
  };
}

export function validateExportId(value: unknown): string {
  return str(value, 'exportId', { max: MAX_ID_LENGTH });
}

export function validateSettingsPatch(value: unknown): SettingsPatch {
  const record = object(value, 'request');
  exactKeys(record, ['theme', 'window'], '');

  const patch: { theme?: 'dark' | 'light'; window?: WindowState } = {};

  const theme = record['theme'];
  if (theme !== undefined) patch.theme = oneOf(theme, THEMES, 'theme');

  const rawWindow = record['window'];
  if (rawWindow !== undefined) {
    const w = object(rawWindow, 'window');
    exactKeys(w, WINDOW_FIELDS, 'window');
    patch.window = {
      // Negative positions are legitimate: a window can sit on a display to the
      // left of or above the primary one.
      x: finite(w['x'], 'window.x', -MAX_WINDOW_POSITION, MAX_WINDOW_POSITION),
      y: finite(w['y'], 'window.y', -MAX_WINDOW_POSITION, MAX_WINDOW_POSITION),
      width: finite(w['width'], 'window.width', 1, MAX_WINDOW_DIMENSION),
      height: finite(w['height'], 'window.height', 1, MAX_WINDOW_DIMENSION),
      isMaximized: bool(w['isMaximized'], 'window.isMaximized'),
      isFullScreen: bool(w['isFullScreen'], 'window.isFullScreen'),
    };
  }

  return patch;
}
