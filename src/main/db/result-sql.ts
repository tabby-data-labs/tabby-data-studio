/**
 * SQL construction for positionable results (PLAN Phase 4, ARCHITECTURE §5.2).
 *
 * Two rules hold for every function here:
 *
 *  1. **Nothing the renderer supplied is concatenated into a statement.** Values
 *     become `$n` parameters, identifiers go through `quoteIdent`, and a query
 *     being wrapped goes through the lexical scanner so a second statement cannot
 *     ride along inside `DECLARE … CURSOR FOR`.
 *  2. **The cursor stays `NO SCROLL`.** A bidirectional cursor forces Postgres to
 *     materialise the whole result, which is precisely what a 10M-row table must
 *     not do. Forward-only plus `MOVE ABSOLUTE` covers everything the grid does.
 *
 * Keyset pagination is the preferred path where a usable key exists, because it
 * needs no open transaction and therefore pins no xmin horizon; the cursor is the
 * general-case fallback.
 */
import type { SortDirection } from '../../shared/domain';
import {
  IdentifierError,
  MAX_IDENTIFIER_BYTES,
  assertGeneratedName,
  quoteIdent,
  quoteQualified,
} from '../../shared/ident';
import { assertSingleStatement } from './sql-scan';

/** Mirrors the IPC layer's `MAX_WINDOW_ROWS`: one window request cannot ask for more. */
export const MAX_FETCH_ROWS = 10_000;

export const CURSOR_PREFIX = 'tabby_c_';

export const BACKEND_PID_SQL = 'select pg_backend_pid()';

export interface ParameterisedSql {
  readonly text: string;
  readonly values: readonly unknown[];
}

function inRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** FNV-1a. Not cryptographic — it only has to separate result ids that sanitise alike. */
function hash32(text: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A cursor name for a result id.
 *
 * Sanitised to the generated-identifier alphabet, and salted with a hash of the
 * *original* id: without the hash, `r-1` and `r_1` would both become
 * `tabby_c_r_1`, and two live cursors sharing a name means the second `DECLARE`
 * fails — or, worse, one result reads another's rows.
 */
export function cursorNameFor(resultId: string): string {
  if (typeof resultId !== 'string' || resultId === '') {
    throw new IdentifierError('resultId', 'must be a non-empty string');
  }

  const sanitized = resultId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (sanitized === '') {
    throw new IdentifierError('resultId', 'contains no usable identifier characters');
  }

  const suffix = `_${hash32(resultId).toString(36)}`;
  const budget = MAX_IDENTIFIER_BYTES - CURSOR_PREFIX.length - suffix.length;
  if (budget < 1) {
    throw new IdentifierError('resultId', 'cannot fit inside the identifier limit');
  }
  return assertGeneratedName(`${CURSOR_PREFIX}${sanitized.slice(0, budget)}${suffix}`, 'cursor');
}

/**
 * Wraps a query in a forward-only server-side cursor.
 *
 * The wrapped query is scanned first: a trailing `;` would close the DECLARE and
 * leave whatever followed as a second statement on the simple-query protocol.
 */
export function declareCursorSql(cursor: string, query: string): string {
  const name = assertGeneratedName(cursor, 'cursor');
  const body = assertSingleStatement(query, 'query');
  return `DECLARE "${name}" NO SCROLL CURSOR FOR ${body}`;
}

export function fetchSql(cursor: string, count: number): string {
  const name = assertGeneratedName(cursor, 'cursor');
  return `FETCH ${inRange(count, 'count', 1, MAX_FETCH_ROWS)} FROM "${name}"`;
}

/**
 * Positions the cursor at an absolute row, which is how the grid jumps to row
 * 800,000 without `OFFSET` making Postgres scan and discard 800,000 rows.
 * Zero is legal and means "before the first row".
 */
export function moveAbsoluteSql(cursor: string, offset: number): string {
  const name = assertGeneratedName(cursor, 'cursor');
  return `MOVE ABSOLUTE ${inRange(offset, 'offset', 0, Number.MAX_SAFE_INTEGER)} IN "${name}"`;
}

export function closeCursorSql(cursor: string): string {
  return `CLOSE "${assertGeneratedName(cursor, 'cursor')}"`;
}

/**
 * Cancels a running query. Parameterised, and issued on the *reserved second*
 * connection: the connection running the query is blocked waiting for the server
 * and cannot be asked to do anything.
 */
export function cancelBackendSql(backendPid: number): ParameterisedSql {
  return {
    text: 'select pg_cancel_backend($1)',
    values: [inRange(backendPid, 'backendPid', 1, Number.MAX_SAFE_INTEGER)],
  };
}

/** "Select the first N rows of this table", used by the schema explorer. */
export function selectFromTableSql(schema: string, table: string, limit: number): string {
  return `select * from ${quoteQualified(schema, table)} limit ${inRange(limit, 'limit', 1, MAX_FETCH_ROWS)}`;
}

export interface KeysetPageInput {
  readonly schema: string;
  readonly table: string;
  /** In index order — the order the comparison must use. */
  readonly keyColumns: readonly string[];
  /** One direction for the whole key, or one per column. They must all agree. */
  readonly direction: SortDirection | readonly SortDirection[];
  readonly limit: number;
  /** The last key seen, or null for the first page. */
  readonly after: readonly unknown[] | null;
}

function normalizeDirections(
  direction: SortDirection | readonly SortDirection[],
  length: number,
): readonly SortDirection[] {
  const list =
    typeof direction === 'string' ? new Array<SortDirection>(length).fill(direction) : direction;

  if (!Array.isArray(list) || list.length !== length) {
    throw new RangeError(`direction must be a single value or one per key column (${length})`);
  }
  const first = list[0];
  if (first !== 'asc' && first !== 'desc') {
    throw new RangeError("direction must be 'asc' or 'desc'");
  }
  // A row comparison `(a, b) > ($1, $2)` is only equivalent to the expanded form
  // when every column moves the same way. Expanding it for mixed directions would
  // stop using the index, so the caller falls back to a cursor instead.
  if (list.some((value) => value !== first)) {
    throw new RangeError('keyset pagination needs a uniform sort direction across the key');
  }
  return list;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(', ');
}

function assertKeyColumns(keyColumns: readonly string[]): readonly string[] {
  if (!Array.isArray(keyColumns) || keyColumns.length === 0) {
    throw new RangeError('keyColumns must be a non-empty list');
  }
  return keyColumns.map((column) => quoteIdent(column, 'keyColumn'));
}

function orderByClause(quoted: readonly string[], directions: readonly SortDirection[]): string {
  return quoted.map((name, index) => `${name} ${directions[index]}`).join(', ');
}

/**
 * One page of a keyset-paginated table scan.
 *
 * No `OFFSET` and no open transaction: the seek predicate lets Postgres start at
 * the right place in the index, which is what makes sequential scrolling cheap on
 * a table too big to scan.
 */
export function keysetPageSql(input: KeysetPageInput): ParameterisedSql {
  const { schema, table, after } = input;
  const limit = inRange(input.limit, 'limit', 1, MAX_FETCH_ROWS);
  const quoted = assertKeyColumns(input.keyColumns);
  const directions = normalizeDirections(input.direction, quoted.length);

  if (after !== null) {
    if (!Array.isArray(after)) {
      throw new RangeError('after must be an array of key values, or null');
    }
    if (after.length !== quoted.length) {
      throw new RangeError(
        `after must supply one value per key column: got ${after.length} for ${quoted.length}`,
      );
    }
  }

  const operator = directions[0] === 'asc' ? '>' : '<';
  const where =
    after === null
      ? ''
      : ` where (${quoted.join(', ')}) ${operator} (${placeholders(quoted.length)})`;

  return {
    text: `select * from ${quoteQualified(schema, table)}${where} order by ${orderByClause(
      quoted,
      directions,
    )} limit ${limit}`,
    values: after === null ? [] : [...after],
  };
}

export interface OffsetPageInput {
  readonly schema: string;
  readonly table: string;
  readonly keyColumns: readonly string[];
  readonly direction: SortDirection | readonly SortDirection[];
  readonly limit: number;
  readonly offset: number;
}

/**
 * The fallback for a jump keyset cannot seek to.
 *
 * A keyset seek needs the key of the previous row; an arbitrary jump to row
 * 800,000 has none. `OFFSET` still walks 800,000 index entries server-side, but it
 * holds no transaction open — which, unlike an idle cursor, does not pin an xmin
 * horizon and block vacuum while the user reads.
 */
export function offsetPageSql(input: OffsetPageInput): ParameterisedSql {
  const limit = inRange(input.limit, 'limit', 1, MAX_FETCH_ROWS);
  const offset = inRange(input.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const quoted = assertKeyColumns(input.keyColumns);
  const directions = normalizeDirections(input.direction, quoted.length);

  const orderBy = orderByClause(quoted, directions);
  const skip = offset === 0 ? '' : ` offset ${offset}`;
  return {
    text: `select * from ${quoteQualified(input.schema, input.table)} order by ${orderBy} limit ${limit}${skip}`,
    values: [],
  };
}
