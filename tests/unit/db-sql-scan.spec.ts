/**
 * The Postgres lexical scanner used to decide whether a piece of SQL is a single
 * statement (PLAN Phase 4; the same scanner powers Phase 7's statement splitter).
 *
 * Tier 1, written test-first. This is a security control, not a convenience:
 * renderer-supplied SQL is wrapped in `DECLARE ... CURSOR FOR <sql>`, so a
 * trailing `; DROP TABLE x` would leave the wrapper as *two* statements sent
 * over the simple-query protocol. `default_transaction_read_only` is the
 * backstop; this is the first line.
 *
 * Expectations come from the Postgres lexical rules (§4.1 of the manual), not
 * from the implementation: `''` escapes inside a standard string, `\'` escapes
 * only inside an `E''` string, block comments nest, `$$tag$$` bodies are opaque,
 * and `$1` is a positional parameter rather than a dollar-quote opener.
 */
import { describe, expect, it } from 'vitest';
import {
  SqlStructureError,
  assertSingleStatement,
  findTopLevelSemicolons,
} from '../../src/main/db/sql-scan';

describe('top-level semicolons', () => {
  it('finds none in a single statement', () => {
    expect(findTopLevelSemicolons('select 1')).toEqual([]);
    expect(findTopLevelSemicolons('')).toEqual([]);
  });

  it('finds the separator between two statements', () => {
    const sql = 'select 1; select 2';
    expect(sql[8]).toBe(';');
    expect(findTopLevelSemicolons(sql)).toEqual([8]);
  });

  it('finds every separator in a script', () => {
    expect(findTopLevelSemicolons('a;b;c')).toEqual([1, 3]);
  });

  it('ignores a semicolon inside a standard string literal', () => {
    expect(findTopLevelSemicolons("select 'a;b'")).toEqual([]);
    expect(findTopLevelSemicolons("select '--;'")).toEqual([]);
  });

  it("treats '' as an escaped quote, not as the end of the literal", () => {
    expect(findTopLevelSemicolons("select 'it''s;fine'")).toEqual([]);
    expect(findTopLevelSemicolons("select 'it''s'; select 2")).toEqual([14]);
  });

  it('ignores a semicolon inside a quoted identifier', () => {
    expect(findTopLevelSemicolons('select "a;b" from t')).toEqual([]);
    expect(findTopLevelSemicolons('select "a""b;c" from t')).toEqual([]);
  });

  it('ignores a semicolon in a line comment', () => {
    expect(findTopLevelSemicolons('select 1 -- trailing; comment')).toEqual([]);
  });

  it('does not start a string literal from an apostrophe inside a comment', () => {
    // A scanner that missed this would report an unterminated literal and refuse
    // a perfectly valid statement.
    expect(findTopLevelSemicolons("select 1 -- don't")).toEqual([]);
    const withNewline = "select 1 -- don't\n; select 2";
    expect(findTopLevelSemicolons(withNewline)).toEqual([withNewline.indexOf(';')]);
  });

  it('ignores a semicolon in a block comment', () => {
    expect(findTopLevelSemicolons('select 1 /* a ; b */')).toEqual([]);
  });

  it('handles nested block comments, which Postgres allows', () => {
    expect(findTopLevelSemicolons('/* a /* b ; c */ d */ select 1')).toEqual([]);
    expect(findTopLevelSemicolons('/* a /* b */ ; c */ select 1')).toEqual([]);

    // The semicolon only becomes top-level once every nesting level has closed.
    const nested = '/* a /* b */ c */ select 1; select 2';
    expect(findTopLevelSemicolons(nested)).toEqual([nested.indexOf(';')]);

    // An unclosed outer level swallows the rest of the input, which must be a
    // refusal rather than a silent "no separator here".
    expect(() => findTopLevelSemicolons('/*/*/*/ select 1; select 2')).toThrow(SqlStructureError);
  });

  it('ignores a semicolon inside a dollar-quoted body', () => {
    expect(findTopLevelSemicolons('select $$ a ; b $$')).toEqual([]);
    expect(findTopLevelSemicolons('select $tag$ a ; b $tag$')).toEqual([]);
    expect(findTopLevelSemicolons('select $tag_1$ a ; b $tag_1$')).toEqual([]);
  });

  it('does not confuse a nested dollar tag with the outer one', () => {
    // `$inner$` inside a `$outer$` body is data, not a delimiter.
    expect(findTopLevelSemicolons('select $outer$ $inner$ ; $inner$ $outer$')).toEqual([]);
  });

  it('splits a function body only at its real terminator', () => {
    const sql =
      "create function f() returns void as $$ begin raise notice 'x'; end; $$ language plpgsql;";
    const semicolons = findTopLevelSemicolons(sql);
    expect(semicolons).toEqual([sql.length - 1]);
  });

  it('treats $1 as a positional parameter, not a dollar-quote opener', () => {
    expect(findTopLevelSemicolons('select $1')).toEqual([]);
    const one = 'select $1; select $2';
    expect(findTopLevelSemicolons(one)).toEqual([one.indexOf(';')]);
    const two = 'select $12; select 1';
    expect(findTopLevelSemicolons(two)).toEqual([two.indexOf(';')]);
  });
});

describe('standard vs escape strings', () => {
  it('does not honour a backslash escape in a standard string literal', () => {
    // With standard_conforming_strings=on (the default since 9.1) `\'` closes the
    // literal, so the semicolon really is top-level. Getting this backwards would
    // hide a second statement.
    expect(findTopLevelSemicolons("select 'a\\'; select 2")).toEqual([11]);
  });

  it('honours a backslash escape in an E-string', () => {
    expect(findTopLevelSemicolons("select E'a\\'; still inside'")).toEqual([]);
    expect(findTopLevelSemicolons("select e'a\\'; still inside'")).toEqual([]);
  });

  it('still treats a doubled quote as an escape inside an E-string', () => {
    expect(findTopLevelSemicolons("select E'it''s;fine'")).toEqual([]);
  });
});

describe('unterminated constructs are refused', () => {
  it('rejects an unterminated string literal', () => {
    expect(() => findTopLevelSemicolons("select 'abc")).toThrow(SqlStructureError);
  });

  it('rejects an unterminated quoted identifier', () => {
    expect(() => findTopLevelSemicolons('select "abc')).toThrow(SqlStructureError);
  });

  it('rejects an unterminated block comment', () => {
    expect(() => findTopLevelSemicolons('select 1 /* never closed')).toThrow(SqlStructureError);
  });

  it('rejects an unterminated dollar-quoted body', () => {
    expect(() => findTopLevelSemicolons('select $$ never closed')).toThrow(SqlStructureError);
  });

  it('rejects a NUL byte, which would truncate the statement server-side', () => {
    expect(() => findTopLevelSemicolons('select 1\u0000; drop table x')).toThrow(SqlStructureError);
  });

  it('reports the field so the rejection can be logged and shown', () => {
    try {
      findTopLevelSemicolons("select 'abc");
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect((caught as SqlStructureError).field).toBe('sql');
    }
  });
});

describe('assertSingleStatement', () => {
  it('returns the statement trimmed, without a trailing semicolon', () => {
    expect(assertSingleStatement('  select 1  ')).toBe('select 1');
    expect(assertSingleStatement('select 1;')).toBe('select 1');
    expect(assertSingleStatement('select 1;\n\n')).toBe('select 1');
  });

  it('drops a trailing semicolon even when a comment follows it', () => {
    // The wrapper appends this text after `CURSOR FOR`, so a surviving `;` would
    // close the DECLARE early.
    expect(assertSingleStatement('select 1; -- done')).toBe('select 1');
    expect(assertSingleStatement('select 1;\n/* done */\n')).toBe('select 1');
  });

  it('rejects a statement that is nothing but a semicolon', () => {
    expect(() => assertSingleStatement('; -- done')).toThrow(SqlStructureError);
  });

  it('rejects two statements', () => {
    expect(() => assertSingleStatement('select 1; select 2')).toThrow(SqlStructureError);
    expect(() => assertSingleStatement('select 1; drop table users')).toThrow(SqlStructureError);
  });

  it('rejects an empty trailing statement rather than letting it through', () => {
    expect(() => assertSingleStatement('select 1;;')).toThrow(SqlStructureError);
    expect(() => assertSingleStatement('select 1; ;')).toThrow(SqlStructureError);
  });

  it('rejects empty and comment-only input', () => {
    expect(() => assertSingleStatement('')).toThrow(SqlStructureError);
    expect(() => assertSingleStatement('   ')).toThrow(SqlStructureError);
    expect(() => assertSingleStatement('-- nothing here')).toThrow(SqlStructureError);
    expect(() => assertSingleStatement('/* nothing */')).toThrow(SqlStructureError);
    expect(() => assertSingleStatement(';')).toThrow(SqlStructureError);
  });

  it('accepts a multi-line statement with a semicolon hidden in each quoting style', () => {
    const sql = [
      "select 'a;b',          -- literal ; comment",
      '       "c;d",          /* block ; comment */',
      '       $$e;f$$,',
      "       E'g\\';h'",
      'from t',
      'where x = $1;',
    ].join('\n');
    expect(assertSingleStatement(sql)).toBe(sql.trim().slice(0, -1));
  });

  it('honours a custom field name for logging', () => {
    try {
      assertSingleStatement('select 1; select 2', 'query.sql');
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect((caught as SqlStructureError).field).toBe('query.sql');
    }
  });
});
