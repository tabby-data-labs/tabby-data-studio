/**
 * A Postgres lexical scanner, used to answer one question: is this text a single
 * statement? (PLAN Phase 4; the same scanner drives Phase 7's statement splitter.)
 *
 * Why this exists rather than `sql.includes(';')`: renderer-supplied SQL is
 * wrapped in `DECLARE <cursor> NO SCROLL CURSOR FOR <sql>`. If that SQL carried a
 * second statement, the wrapper would become two statements on the simple-query
 * protocol and the second would run. `default_transaction_read_only` is the
 * backstop that makes this non-catastrophic; the scanner is what makes it
 * correct.
 *
 * Implements the lexical rules of the Postgres manual §4.1:
 *  - `'…'` standard string, `''` escapes, backslash is **not** an escape
 *    (`standard_conforming_strings` has been on by default since 9.1)
 *  - `E'…'` escape string, where `\'` **is** an escape
 *  - `"…"` quoted identifier, `""` escapes
 *  - `-- …` line comment
 *  - block comment, which **nests**
 *  - `$tag$ … $tag$` dollar quoting, tag optional
 *  - `$1` positional parameter, which must not be read as a dollar-quote opener
 */

export class SqlStructureError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(field === '' ? message : `${field}: ${message}`);
    this.name = 'SqlStructureError';
    this.field = field;
  }
}

interface ScanResult {
  /** Offsets of every `;` that is not inside a literal, comment or body. */
  readonly semicolons: readonly number[];
  /** False when the input is only whitespace and comments. */
  readonly sawCode: boolean;
}

const TAG_FIRST = /[A-Za-z_]/;
const TAG_REST = /[A-Za-z0-9_]/;

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Returns the index just past the closing quote, or throws.
 *
 * `charAt` rather than `sql[i]`: past the end it yields `''`, which is never a
 * valid SQL character, so running off the end is the same branch as a syntax
 * error instead of an undefined comparison.
 */
function scanQuoted(
  sql: string,
  start: number,
  quote: string,
  escapes: boolean,
  field: string,
): number {
  let i = start + 1;
  for (;;) {
    const ch = sql.charAt(i);
    if (ch === '') throw new SqlStructureError(field, 'unterminated quoted literal');
    if (escapes && ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      // A doubled quote is an escaped quote and does not close the literal.
      if (sql.charAt(i + 1) === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
}

/**
 * Reads a dollar-quote opener at `start`. Returns the tag (`''` for `$$`), or
 * null when the `$` is really a positional parameter.
 */
function dollarTagAt(sql: string, start: number): string | null {
  if (sql.charAt(start) !== '$') return null;
  const first = sql.charAt(start + 1);
  if (first === '$') return '';
  if (!TAG_FIRST.test(first)) return null;

  let last = start + 1;
  while (TAG_REST.test(sql.charAt(last + 1))) last += 1;
  if (sql.charAt(last + 1) !== '$') return null;
  return sql.slice(start + 1, last + 1);
}

function scanDollarQuoted(sql: string, start: number, tag: string, field: string): number {
  const delimiter = `$${tag}$`;
  const close = sql.indexOf(delimiter, start + delimiter.length);
  if (close < 0) throw new SqlStructureError(field, 'unterminated dollar-quoted body');
  return close + delimiter.length;
}

/** Returns the index just past the closing delimiter, honouring nesting. */
function scanBlockComment(sql: string, start: number, field: string): number {
  let depth = 1;
  let i = start + 2;
  for (;;) {
    const ch = sql.charAt(i);
    if (ch === '') throw new SqlStructureError(field, 'unterminated block comment');
    if (ch === '/' && sql.charAt(i + 1) === '*') {
      depth += 1;
      i += 2;
      continue;
    }
    if (ch === '*' && sql.charAt(i + 1) === '/') {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
}

function scan(sql: string, field: string): ScanResult {
  if (typeof sql !== 'string') {
    throw new SqlStructureError(field, 'expected a string');
  }
  if (sql.includes('\u0000')) {
    // A NUL would truncate the statement server-side, silently dropping whatever
    // followed it. Refuse rather than send half a statement.
    throw new SqlStructureError(field, 'must not contain a NUL byte');
  }

  const semicolons: number[] = [];
  let sawCode = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql.charAt(i);

    if (ch === '-' && sql.charAt(i + 1) === '-') {
      const newline = sql.indexOf('\n', i + 2);
      i = newline < 0 ? sql.length : newline + 1;
      continue;
    }

    if (ch === '/' && sql.charAt(i + 1) === '*') {
      i = scanBlockComment(sql, i, field);
      continue;
    }

    if (ch === "'") {
      sawCode = true;
      i = scanQuoted(sql, i, "'", false, field);
      continue;
    }

    // E'…' / e'…' — the backslash escapes only in this form, so the two string
    // syntaxes genuinely differ and must not share a branch.
    if ((ch === 'E' || ch === 'e') && sql.charAt(i + 1) === "'") {
      sawCode = true;
      i = scanQuoted(sql, i + 1, "'", true, field);
      continue;
    }

    if (ch === '"') {
      sawCode = true;
      i = scanQuoted(sql, i, '"', false, field);
      continue;
    }

    if (ch === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag !== null) {
        sawCode = true;
        i = scanDollarQuoted(sql, i, tag, field);
        continue;
      }
    }

    if (ch === ';') {
      semicolons.push(i);
      i += 1;
      continue;
    }

    if (!isWhitespace(ch)) sawCode = true;
    i += 1;
  }

  return { semicolons, sawCode };
}

/** Offsets of every top-level `;`. Throws on unterminated quoting or a NUL. */
export function findTopLevelSemicolons(sql: string, field = 'sql'): readonly number[] {
  return scan(sql, field).semicolons;
}

/**
 * Validates that `sql` is exactly one statement and returns it ready to embed:
 * trimmed, with a single trailing `;` — and any comment after it — removed.
 */
export function assertSingleStatement(sql: string, field = 'sql'): string {
  const result = scan(sql, field);
  if (!result.sawCode) {
    throw new SqlStructureError(field, 'contains no executable statement');
  }
  if (result.semicolons.length > 1) {
    throw new SqlStructureError(
      field,
      `must be a single statement, found ${result.semicolons.length + 1}`,
    );
  }
  if (result.semicolons.length === 1) {
    const at = result.semicolons[0] as number;
    if (scan(sql.slice(at + 1), field).sawCode) {
      throw new SqlStructureError(field, 'must be a single statement, found 2');
    }
    return sql.slice(0, at).trim();
  }
  return sql.trim();
}
