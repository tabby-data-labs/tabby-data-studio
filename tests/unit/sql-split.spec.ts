/**
 * The lexer-aware statement splitter (PLAN Phase 7).
 *
 * Tier 1, written test-first. The exit criterion for the whole phase is stated
 * here as a single case: a script containing a `$$` function body, a `--` comment
 * with a semicolon, and a string literal with a semicolon must split into exactly
 * the statements the server would see. Naive `split(';')` gets all three wrong,
 * and getting them wrong means running a fragment of a function body as a query.
 *
 * Two invariants are asserted everywhere rather than once, because both are
 * load-bearing for the editor:
 *
 *  - `sql.slice(statement.start, statement.end) === statement.text`, so an error
 *    offset can be mapped back onto the textarea without a second translation;
 *  - comments and whitespace are **not** part of a statement, so a comment-only
 *    chunk can never become an empty statement that main then rejects.
 */
import { describe, expect, it } from 'vitest';
import { splitScript, statementAt, statementsToRun } from '../../src/shared/sql-split';

function texts(sql: string): string[] {
  return splitScript(sql).statements.map((statement) => statement.text);
}

/** Asserts the slice invariant for every statement in one go. */
function expectSlicesMatch(sql: string): void {
  for (const statement of splitScript(sql).statements) {
    expect(sql.slice(statement.start, statement.end), statement.text).toBe(statement.text);
  }
}

describe('splitScript', () => {
  it('splits a two-statement script at the real separator', () => {
    const sql = 'select 1; select 2';
    expect(texts(sql)).toEqual(['select 1', 'select 2']);
    expect(splitScript(sql).statements.map((s) => [s.start, s.end])).toEqual([
      [0, 8],
      [10, 18],
    ]);
    expectSlicesMatch(sql);
  });

  it('records the terminator offset, and null for a final statement without one', () => {
    const statements = splitScript('select 1; select 2').statements;
    expect(statements[0]?.terminator).toBe(8);
    expect(statements[1]?.terminator).toBeNull();
  });

  it('drops the trailing semicolon from the statement text', () => {
    expect(texts('select 1;')).toEqual(['select 1']);
    expect(texts('select 1;\n\n')).toEqual(['select 1']);
  });

  it('returns nothing for empty, whitespace-only and comment-only input', () => {
    // A comment-only chunk must not become an empty statement: main would reject it
    // with "contains no executable statement" and the user would see an error for
    // pressing Cmd+Enter on a note to themselves.
    for (const sql of [
      '',
      '   ',
      '\n\n',
      '-- nothing here',
      '/* nothing */',
      ';',
      ';;',
      '-- a\n/* b */\n;',
    ]) {
      expect(texts(sql), JSON.stringify(sql)).toEqual([]);
      expectSlicesMatch(sql);
    }
  });

  it('drops an empty chunk between two separators', () => {
    expect(texts('select 1;;select 2')).toEqual(['select 1', 'select 2']);
    expect(texts('select 1; ;')).toEqual(['select 1']);
  });

  it('excludes comments and whitespace from the statement span', () => {
    const sql = '\n\n  -- a note\n  select 1  /* trailing */  ;\n';
    const [statement] = splitScript(sql).statements;
    expect(statement?.text).toBe('select 1');
    expect(sql.slice(statement?.start ?? -1, statement?.end ?? -1)).toBe('select 1');
    expectSlicesMatch(sql);
  });

  it('handles a three-statement script', () => {
    expect(texts('a;b;c')).toEqual(['a', 'b', 'c']);
    expect(texts('select 1; select 2; select 3;')).toEqual(['select 1', 'select 2', 'select 3']);
  });
});

describe('the Phase 7 exit criterion', () => {
  const SCRIPT = [
    "create function f() returns void as $$ begin raise notice 'x;y'; end; $$ language plpgsql;",
    '-- a comment with a ; in it',
    "select 'a;b';",
  ].join('\n');

  it('splits a $$ body, a -- comment with a semicolon, and a literal with one', () => {
    const statements = splitScript(SCRIPT).statements;
    expect(statements).toHaveLength(2);
    expect(statements[0]?.text).toBe(
      "create function f() returns void as $$ begin raise notice 'x;y'; end; $$ language plpgsql",
    );
    expect(statements[1]?.text).toBe("select 'a;b'");
    expect(splitScript(SCRIPT).error).toBeNull();
    expectSlicesMatch(SCRIPT);
  });

  it('keeps a block comment holding a semicolon out of the split too', () => {
    const sql = 'select 1 /* ; */ ; select 2';
    expect(texts(sql)).toEqual(['select 1', 'select 2']);
  });

  it('does not split inside a nested block comment', () => {
    expect(texts('/* a /* ; */ b */ select 1; select 2')).toEqual(['select 1', 'select 2']);
  });

  it('does not split inside a quoted identifier', () => {
    expect(texts('select "a;b" from t; select 2')).toEqual(['select "a;b" from t', 'select 2']);
  });

  it('does not split inside an E-string that escapes its own quote', () => {
    expect(texts("select E'a\\';b'; select 2")).toEqual(["select E'a\\';b'", 'select 2']);
  });

  it('splits a tagged dollar body only at its real terminator', () => {
    const sql = 'create function g() returns int as $body$ begin return 1; end; $body$; select 1';
    expect(texts(sql)).toEqual([
      'create function g() returns int as $body$ begin return 1; end; $body$',
      'select 1',
    ]);
  });
});

describe('malformed input', () => {
  it('reports the lex error and still returns the statements it could find', () => {
    // The editor highlights while the user is mid-keystroke, so a half-typed
    // literal must degrade rather than throw away everything typed so far.
    const result = splitScript("select 1; select 'abc");
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/unterminated/i);
    expect(result.statements).toHaveLength(2);
    expect(result.statements[0]?.text).toBe('select 1');
    expect(result.statements[1]?.text).toBe("select 'abc");
  });

  it('reports a NUL byte rather than splitting around it', () => {
    const result = splitScript('select 1;\u0000select 2');
    expect(result.error?.message).toMatch(/NUL/);
  });

  it('treats non-string input as an empty script', () => {
    expect(splitScript(null as unknown as string).statements).toEqual([]);
    expect(splitScript(42 as unknown as string).error).toBeNull();
  });
});

describe('statementAt', () => {
  const SQL = 'select 1;\n\nselect 2;\n\nselect 3';

  it('finds the statement the caret is inside', () => {
    expect(statementAt(SQL, 0)?.text).toBe('select 1');
    expect(statementAt(SQL, 4)?.text).toBe('select 1');
    expect(statementAt(SQL, 7)?.text).toBe('select 1');
    expect(statementAt(SQL, 12)?.text).toBe('select 2');
    expect(statementAt(SQL, 22)?.text).toBe('select 3');
  });

  it('treats the terminator as part of the statement before it', () => {
    // The caret sitting on the `;` is the natural place to press Cmd+Enter after
    // finishing a statement, and running the *next* one there would be alarming.
    expect(statementAt(SQL, 8)?.text).toBe('select 1');
    expect(statementAt(SQL, 18)?.text).toBe('select 2');
  });

  it('falls forward to the next statement from a blank line between two', () => {
    expect(statementAt(SQL, 9)?.text).toBe('select 2');
    expect(statementAt(SQL, 10)?.text).toBe('select 2');
    expect(statementAt(SQL, 20)?.text).toBe('select 3');
    expect(statementAt(SQL, 21)?.text).toBe('select 3');
  });

  it('returns null when there is nothing left to run', () => {
    expect(statementAt('select 1;', 9)).toBeNull();
    expect(statementAt('select 1;\n\n', 10)).toBeNull();
    expect(statementAt('', 0)).toBeNull();
    expect(statementAt('-- just a note', 3)).toBeNull();
  });

  it('clamps an out-of-range caret instead of throwing', () => {
    expect(statementAt(SQL, -5)?.text).toBe('select 1');
    expect(statementAt(SQL, 999)?.text).toBe('select 3');
    expect(statementAt(SQL, Number.NaN)).toBeNull();
  });
});

describe('statementsToRun', () => {
  const SQL = 'select 1;\nselect 2;\nselect 3';

  it('runs the statement at the caret when nothing is selected', () => {
    expect(statementsToRun(SQL, { start: 3, end: 3 }).map((s) => s.text)).toEqual(['select 1']);
    expect(statementsToRun(SQL, null).map((s) => s.text)).toEqual(['select 1']);
  });

  it('runs exactly what is selected, re-split, when there is a selection', () => {
    // What you highlighted is what runs — including when that is a fragment. Every
    // editor the user has used behaves this way, and silently widening the
    // selection to whole statements would run more than was asked for.
    const selection = { start: 0, end: 18 };
    expect(statementsToRun(SQL, selection).map((s) => s.text)).toEqual(['select 1', 'select 2']);
  });

  it('rebases selected offsets into the original text, so the slice still matches', () => {
    const selection = { start: 10, end: 18 };
    const statements = statementsToRun(SQL, selection);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toBe('select 2');
    expect(statements[0]?.start).toBe(10);
    expect(SQL.slice(statements[0]!.start, statements[0]!.end)).toBe('select 2');
  });

  it('runs a partial selection as its own script, even when it is a fragment', () => {
    // One rule, no special cases: what you highlighted is what runs. Widening a
    // fragment to its enclosing statement would execute more than was asked for,
    // and the server's syntax error is honest feedback about the text selected.
    expect(statementsToRun(SQL, { start: 2, end: 5 }).map((s) => s.text)).toEqual(['lec']);
  });

  it('runs nothing when the selection covers only a comment', () => {
    expect(statementsToRun('-- a note\nselect 1', { start: 0, end: 9 })).toEqual([]);
  });

  it('normalises a backwards selection', () => {
    // A drag from right to left reports start > end in some browsers; treating that
    // as an empty selection would silently run the caret's statement instead.
    expect(statementsToRun(SQL, { start: 18, end: 0 }).map((s) => s.text)).toEqual([
      'select 1',
      'select 2',
    ]);
  });

  it('returns nothing at all for an empty script', () => {
    expect(statementsToRun('', null)).toEqual([]);
    expect(statementsToRun('   ', { start: 0, end: 3 })).toEqual([]);
  });
});
