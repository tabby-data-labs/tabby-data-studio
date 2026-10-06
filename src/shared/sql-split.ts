/**
 * Statement splitting on top of the lexer (PLAN Phase 7).
 *
 * The phase's exit criterion lives in `tests/unit/sql-split.spec.ts` as one case:
 * a script containing a `$$` function body, a `--` comment with a semicolon, and a
 * string literal with a semicolon must split into exactly the statements the server
 * would see. `sql.split(';')` gets all three wrong, and getting them wrong means
 * running a fragment of a function body as a query.
 *
 * Two contracts the editor depends on:
 *
 *  - `sql.slice(statement.start, statement.end) === statement.text`. Offsets are in
 *    the *original* input, so a server error position maps onto the textarea without
 *    a second translation.
 *  - Comments and whitespace are not part of a statement. A comment-only chunk
 *    therefore cannot become an empty statement, which main would reject with
 *    "contains no executable statement" — pressing Cmd+Enter on a note to yourself
 *    should do nothing, not produce an error.
 *
 * Like the lexer, this never throws: it is called on every keystroke.
 */
import { lex, type LexError, type Token } from './sql-lexer';

export interface SqlStatement {
  /** Trimmed, with any terminating `;` removed. Never empty. */
  readonly text: string;
  /** Offset of `text` in the source it was split from. */
  readonly start: number;
  /** Exclusive end of `text`. */
  readonly end: number;
  /** Offset of the `;` that ended it, or null for a final unterminated statement. */
  readonly terminator: number | null;
}

export interface SplitResult {
  readonly statements: readonly SqlStatement[];
  /** A lexical problem, e.g. an unterminated literal. The statements are still usable. */
  readonly error: LexError | null;
}

export interface Selection {
  readonly start: number;
  readonly end: number;
}

/** Token kinds that carry no executable content. */
function isNoise(token: Token): boolean {
  return (
    token.kind === 'whitespace' || token.kind === 'lineComment' || token.kind === 'blockComment'
  );
}

/**
 * Splits a script into statements.
 *
 * A statement runs from its first non-noise token to its last, and ends at a
 * top-level `;` or at end of input. Leading comments are *not* attached: keeping
 * them out is what makes the comment-only case fall out for free, at the cost of
 * not forwarding an optimiser-hint comment to the server. That trade is worth it
 * for v1 and is documented rather than accidental.
 */
export function splitScript(sql: string): SplitResult {
  const { tokens, error } = lex(sql);
  if (tokens.length === 0) return { statements: [], error };

  const statements: SqlStatement[] = [];
  let first: Token | null = null;
  let last: Token | null = null;

  const flush = (terminator: number | null): void => {
    if (first === null || last === null) return;
    const start = first.start;
    const end = last.end;
    statements.push({ text: sql.slice(start, end), start, end, terminator });
    first = null;
    last = null;
  };

  for (const token of tokens) {
    if (token.kind === 'semicolon') {
      flush(token.start);
      continue;
    }
    if (isNoise(token)) continue;
    if (first === null) first = token;
    last = token;
  }
  // A final statement with no terminator is still a statement — the common case of
  // a query typed without a trailing `;`.
  flush(null);

  return { statements, error };
}

/**
 * The statement to run for a caret position.
 *
 * A caret inside a statement, or on its `;`, selects that statement. A caret in the
 * gap between two — a blank line, a run of comments — falls **forward** to the next
 * one, which is what every SQL editor does and what makes Cmd+Enter on a blank line
 * useful. Nothing after the caret means nothing to run: the caller shows "no
 * statement at the cursor" rather than silently re-running something above.
 */
export function statementAt(sql: string, caret: number): SqlStatement | null {
  const statements = splitScript(sql).statements;
  if (statements.length === 0) return null;
  if (!Number.isFinite(caret)) return null;

  const at = Math.max(0, Math.min(Math.trunc(caret), sql.length));

  for (const statement of statements) {
    // The terminator belongs to the statement it ends: the caret sitting on the `;`
    // is the natural place to press Cmd+Enter after finishing a statement, and
    // running the *next* one from there would be alarming.
    const limit = statement.terminator ?? statement.end;
    if (at >= statement.start && at <= limit) return statement;
  }
  for (const statement of statements) {
    if (statement.start > at) return statement;
  }
  return null;
}

/**
 * What Cmd+Enter should run.
 *
 * With no selection: the statement at the caret. With one: **exactly the selected
 * text**, re-split. A partial selection therefore runs as a fragment and the server
 * returns a syntax error — which is honest. Widening a fragment to its enclosing
 * statement would execute more than the user highlighted, and "I selected three
 * characters and it ran the whole query" is the kind of surprise that erodes trust
 * in a tool that talks to production.
 *
 * A backwards selection (`start > end`, which some browsers report for a
 * right-to-left drag) is normalised rather than treated as empty.
 */
export function statementsToRun(sql: string, selection: Selection | null): readonly SqlStatement[] {
  if (selection === null || selection.start === selection.end) {
    const caret = selection === null ? 0 : selection.start;
    const statement = statementAt(sql, caret);
    return statement === null ? [] : [statement];
  }

  const from = Math.max(0, Math.min(selection.start, selection.end));
  const to = Math.max(0, Math.max(selection.start, selection.end));
  if (from === to) return [];

  const selected = sql.slice(from, to);
  // Offsets are rebased into the original text so the slice invariant still holds
  // for the caller, which needs it to underline an error at the right place.
  return splitScript(selected).statements.map((statement) => ({
    ...statement,
    start: statement.start + from,
    end: statement.end + from,
    // A terminator offset inside the selection is still meaningful; past its end it
    // is not, and `null` reads as "no terminator" rather than as a bogus position.
    terminator: statement.terminator === null ? null : statement.terminator + from,
  }));
}
