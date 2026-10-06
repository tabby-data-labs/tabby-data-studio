/**
 * Is this text a single statement? (PLAN Phase 4; the lexer moved to
 * `src/shared/sql-lexer.ts` in Phase 7, when the editor needed the same scanner.)
 *
 * Why this exists rather than `sql.includes(';')`: renderer-supplied SQL is
 * wrapped in `DECLARE <cursor> NO SCROLL CURSOR FOR <sql>`. If that SQL carried a
 * second statement, the wrapper would become two statements on the simple-query
 * protocol and the second would run. `default_transaction_read_only` is the
 * backstop that makes this non-catastrophic; the scanner is what makes it
 * correct.
 *
 * This module is now a thin adapter over the shared lexer: it turns the lexer's
 * reported problems into a thrown `SqlStructureError`, and answers the two
 * questions main asks. It holds no lexical rules of its own, which is the point —
 * the editor's statement splitter and this security control read the same tokens,
 * so they cannot disagree about where a statement ends. A disagreement would
 * surface as the server rejecting a statement the UI had just split confidently.
 */
import { lex, type Token } from '../../shared/sql-lexer';

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
  /** False when the input is only whitespace, comments and separators. */
  readonly sawCode: boolean;
}

/**
 * Token kinds that carry no executable content.
 *
 * `semicolon` belongs here, which is subtle and load-bearing: `'; -- done'` must be
 * refused as "contains no executable statement", and a separator is not a
 * statement. Counting it as code would accept a script that is nothing but
 * punctuation.
 */
function isNoise(token: Token): boolean {
  return (
    token.kind === 'whitespace' ||
    token.kind === 'lineComment' ||
    token.kind === 'blockComment' ||
    token.kind === 'semicolon'
  );
}

function scan(sql: string, field: string): ScanResult {
  const result = lex(sql);
  // The lexer never throws — a half-typed query is normal in an editor — but main
  // must refuse to embed an unterminated literal in a CURSOR declaration, because
  // the rest of the wrapper would become part of the literal.
  if (result.error !== null) {
    throw new SqlStructureError(field, result.error.message);
  }
  const semicolons: number[] = [];
  let sawCode = false;
  for (const token of result.tokens) {
    if (token.kind === 'semicolon') semicolons.push(token.start);
    else if (!isNoise(token)) sawCode = true;
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
