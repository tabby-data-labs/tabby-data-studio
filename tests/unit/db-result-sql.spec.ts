/**
 * SQL construction for positionable results (PLAN Phase 4, ARCHITECTURE §5.2).
 *
 * Tier 1, written test-first. Two rules drive every expectation:
 *
 *  1. **Nothing the renderer supplied is concatenated into a statement.** Values
 *     become `$n` parameters; identifiers go through `quoteIdent`; the wrapped
 *     query is passed through the lexical scanner so a second statement cannot
 *     ride along inside `DECLARE … CURSOR FOR`.
 *  2. **The cursor stays `NO SCROLL`.** A bidirectional cursor forces Postgres to
 *     materialise the entire result, which is exactly what a 10M-row table must
 *     not do.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKEND_PID_SQL,
  MAX_FETCH_ROWS,
  cancelBackendSql,
  closeCursorSql,
  cursorNameFor,
  declareCursorSql,
  fetchSql,
  keysetPageSql,
  moveAbsoluteSql,
  offsetPageSql,
  selectFromTableSql,
} from '../../src/main/db/result-sql';
import { SqlStructureError, assertSingleStatement } from '../../src/main/db/sql-scan';
import { isGeneratedName } from '../../src/main/db/ident';

const CURSOR = 'tabby_c_r1';

describe('cursor names', () => {
  it('derives a valid generated identifier from the result id', () => {
    const name = cursorNameFor('r1');
    expect(isGeneratedName(name)).toBe(true);
    expect(name.startsWith('tabby_c_')).toBe(true);
  });

  it('is deterministic, so a reconnect can rebuild the same name', () => {
    expect(cursorNameFor('result-42')).toBe(cursorNameFor('result-42'));
  });

  it('gives different result ids different names', () => {
    expect(cursorNameFor('r1')).not.toBe(cursorNameFor('r2'));
  });

  it('does not collide for ids that sanitise to the same text', () => {
    // Two live cursors sharing a name would make the second DECLARE fail, or worse,
    // let one result read another's rows.
    expect(cursorNameFor('r-1')).not.toBe(cursorNameFor('r_1'));
    expect(cursorNameFor('a.b')).not.toBe(cursorNameFor('a/b'));
  });

  it('sanitises a hostile result id instead of quoting it into the DDL', () => {
    const name = cursorNameFor('"; DROP TABLE users; --');
    expect(isGeneratedName(name)).toBe(true);
    expect(name).not.toContain('"');
    expect(name).not.toContain(';');
  });

  it('stays within the identifier length limit', () => {
    expect(cursorNameFor('x'.repeat(500)).length).toBeLessThanOrEqual(63);
  });

  it('refuses an empty result id rather than producing a colliding name', () => {
    expect(() => cursorNameFor('')).toThrow();
    expect(() => cursorNameFor(';;;')).toThrow();
  });
});

describe('DECLARE', () => {
  it('wraps the query in a NO SCROLL cursor', () => {
    const sql = declareCursorSql(CURSOR, 'select * from big');
    expect(sql).toBe(`DECLARE "${CURSOR}" NO SCROLL CURSOR FOR select * from big`);
  });

  it('never asks for a scrollable cursor, which would materialise the whole result', () => {
    const sql = declareCursorSql(CURSOR, 'select 1');
    expect(sql).toContain('NO SCROLL');
    expect(sql).not.toMatch(/(?<!NO )SCROLL/);
  });

  it('strips a trailing semicolon from the wrapped query', () => {
    // A surviving `;` would close the DECLARE and leave the rest as a second
    // statement on the simple-query protocol.
    const sql = declareCursorSql(CURSOR, 'select 1;');
    expect(sql.endsWith('select 1')).toBe(true);
    expect(sql).not.toContain(';');
  });

  it('refuses a wrapped query containing a second statement', () => {
    expect(() => declareCursorSql(CURSOR, 'select 1; drop table users')).toThrow(SqlStructureError);
  });

  it('refuses a wrapped query that is empty or only a comment', () => {
    expect(() => declareCursorSql(CURSOR, '')).toThrow(SqlStructureError);
    expect(() => declareCursorSql(CURSOR, '-- nothing')).toThrow(SqlStructureError);
  });

  it('accepts a query whose semicolons are all inside literals or comments', () => {
    const sql = declareCursorSql(CURSOR, "select 'a;b' -- trailing; comment");
    expect(sql).toContain("select 'a;b'");
    expect(() => assertSingleStatement(sql)).not.toThrow();
  });

  it('refuses a cursor name that is not a generated identifier', () => {
    expect(() => declareCursorSql('bad"name', 'select 1')).toThrow();
    expect(() => declareCursorSql('', 'select 1')).toThrow();
  });

  it('produces a single statement, whatever it wrapped', () => {
    expect(() => assertSingleStatement(declareCursorSql(CURSOR, 'select 1'))).not.toThrow();
  });
});

describe('FETCH and MOVE', () => {
  it('fetches forward from the cursor', () => {
    expect(fetchSql(CURSOR, 1000)).toBe(`FETCH 1000 FROM "${CURSOR}"`);
  });

  it('moves to an absolute position, which is how the grid jumps to row 800,000', () => {
    expect(moveAbsoluteSql(CURSOR, 800_000)).toBe(`MOVE ABSOLUTE 800000 IN "${CURSOR}"`);
  });

  it('allows MOVE ABSOLUTE 0, meaning "before the first row"', () => {
    expect(moveAbsoluteSql(CURSOR, 0)).toBe(`MOVE ABSOLUTE 0 IN "${CURSOR}"`);
  });

  it('rejects a fetch count that is not a positive safe integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_FETCH_ROWS + 1]) {
      expect(() => fetchSql(CURSOR, bad), String(bad)).toThrow();
    }
    expect(() => fetchSql(CURSOR, MAX_FETCH_ROWS)).not.toThrow();
    expect(() => fetchSql(CURSOR, 1)).not.toThrow();
  });

  it('rejects a negative or fractional move offset', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number]) {
      expect(() => moveAbsoluteSql(CURSOR, bad), String(bad)).toThrow();
    }
  });

  it('interpolates only integers, so the count cannot carry SQL', () => {
    const sql = fetchSql(CURSOR, 10);
    expect(sql).toMatch(/^FETCH \d+ FROM "[A-Za-z0-9_]+"$/);
  });

  it('closes the cursor', () => {
    expect(closeCursorSql(CURSOR)).toBe(`CLOSE "${CURSOR}"`);
  });
});

describe('cancellation', () => {
  it('reads the backend pid', () => {
    expect(BACKEND_PID_SQL).toBe('select pg_backend_pid()');
  });

  it('parameterises the pid rather than interpolating it', () => {
    const cancel = cancelBackendSql(4242);
    expect(cancel.text).toBe('select pg_cancel_backend($1)');
    expect(cancel.text).not.toContain('4242');
    expect(cancel.values).toEqual([4242]);
  });

  it('rejects a pid that is not a positive integer, so it cannot become SQL', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '42; drop table x' as unknown as number]) {
      expect(() => cancelBackendSql(bad), String(bad)).toThrow();
    }
  });
});

describe('selecting from a table', () => {
  it('quotes the schema and the table and bounds the row count', () => {
    expect(selectFromTableSql('public', 'big', 1000)).toBe(
      'select * from "public"."big" limit 1000',
    );
  });

  it('survives an awkward real identifier', () => {
    const sql = selectFromTableSql('Mixed Case', 'with"dquote', 10);
    expect(sql).toBe('select * from "Mixed Case"."with""dquote" limit 10');
  });

  it('confines an injection attempt to a single quoted identifier', () => {
    const sql = selectFromTableSql('public', 'x"; drop table users; --', 10);
    // The hostile text survives — correctly, because it is data — but it is inside
    // one quoted identifier, so the scanner still sees exactly one statement.
    expect(sql).toBe('select * from "public"."x""; drop table users; --" limit 10');
    expect(assertSingleStatement(sql)).toBe(sql);
  });

  it('rejects a limit that is not a positive integer within the window bound', () => {
    for (const bad of [0, -1, 1.5, MAX_FETCH_ROWS + 1, Number.NaN]) {
      expect(() => selectFromTableSql('public', 'big', bad), String(bad)).toThrow();
    }
  });
});

describe('keyset pagination', () => {
  const base = {
    schema: 'fixtures',
    table: 'big',
    keyColumns: ['id'],
    direction: 'asc' as const,
    limit: 1000,
  };

  it('orders by the key and bounds the page on the first request', () => {
    const page = keysetPageSql({ ...base, after: null });
    expect(page.text).toBe('select * from "fixtures"."big" order by "id" asc limit 1000');
    expect(page.values).toEqual([]);
  });

  it('seeks past the last seen key on later pages, with no OFFSET to scan', () => {
    const page = keysetPageSql({ ...base, after: ['5000'] });
    expect(page.text).toBe(
      'select * from "fixtures"."big" where ("id") > ($1) order by "id" asc limit 1000',
    );
    expect(page.values).toEqual(['5000']);
  });

  it('reverses the comparison and the ordering for a descending page', () => {
    const page = keysetPageSql({ ...base, direction: 'desc', after: ['5000'] });
    expect(page.text).toContain('("id") < ($1)');
    expect(page.text).toContain('order by "id" desc');
  });

  it('uses a row comparison for a composite key, in index order', () => {
    const page = keysetPageSql({
      ...base,
      table: 'composite_pk',
      keyColumns: ['tenant_id', 'seq'],
      after: [3, 17],
    });
    expect(page.text).toBe(
      'select * from "fixtures"."composite_pk" where ("tenant_id", "seq") > ($1, $2) ' +
        'order by "tenant_id" asc, "seq" asc limit 1000',
    );
    expect(page.values).toEqual([3, 17]);
  });

  it('refuses a key whose directions are not uniform', () => {
    // A row comparison is only valid when every column moves the same way. The
    // alternative — expanding to (a > $1) OR (a = $1 AND b < $2) — is correct but
    // stops using the index; refusing is honest and the caller falls back to a
    // cursor.
    expect(() =>
      keysetPageSql({
        ...base,
        keyColumns: ['a', 'b'],
        direction: ['asc', 'desc'],
        after: null,
      }),
    ).toThrow(/uniform/);
  });

  it('accepts a per-column direction list when every entry agrees', () => {
    const page = keysetPageSql({
      ...base,
      table: 'composite_pk',
      keyColumns: ['tenant_id', 'seq'],
      direction: ['desc', 'desc'],
      after: [1, 2],
    });
    expect(page.text).toContain('order by "tenant_id" desc, "seq" desc');
  });

  it('refuses a direction list that does not match the key length', () => {
    expect(() =>
      keysetPageSql({ ...base, keyColumns: ['a', 'b'], direction: ['asc'], after: null }),
    ).toThrow();
  });

  it('refuses an empty key, which would paginate nothing', () => {
    expect(() => keysetPageSql({ ...base, keyColumns: [], after: null })).toThrow();
  });

  it('refuses a key that does not match the number of supplied values', () => {
    expect(() => keysetPageSql({ ...base, keyColumns: ['a', 'b'], after: [1] })).toThrow();
    expect(() => keysetPageSql({ ...base, keyColumns: ['a', 'b'], after: [1, 2, 3] })).toThrow();
  });

  it('refuses a limit outside the window bound', () => {
    for (const bad of [0, -1, 1.5, MAX_FETCH_ROWS + 1, Number.NaN]) {
      expect(() => keysetPageSql({ ...base, after: null, limit: bad }), String(bad)).toThrow();
    }
  });

  it('quotes hostile identifiers', () => {
    const page = keysetPageSql({
      ...base,
      schema: 'public',
      table: 'x"; drop table y; --',
      keyColumns: ['id'],
      after: null,
    });
    expect(page.text).toBe(
      'select * from "public"."x""; drop table y; --" order by "id" asc limit 1000',
    );
    expect(assertSingleStatement(page.text)).toBe(page.text);
  });

  it('produces exactly one statement with no trailing semicolon', () => {
    const page = keysetPageSql({ ...base, after: ['1'] });
    expect(assertSingleStatement(page.text)).toBe(page.text);
  });
});

describe('offset pagination', () => {
  const base = {
    schema: 'fixtures',
    table: 'big',
    keyColumns: ['id'],
    direction: 'asc' as const,
    limit: 1000,
  };

  it('skips rows for a jump that keyset cannot seek to', () => {
    // A keyset seek needs the key of the previous row. For an arbitrary jump there
    // is none, so this is the fallback: still index-ordered, still bounded, and —
    // unlike a cursor — it holds no transaction open.
    const page = offsetPageSql({ ...base, offset: 800_000 });
    expect(page.text).toBe(
      'select * from "fixtures"."big" order by "id" asc limit 1000 offset 800000',
    );
    expect(page.values).toEqual([]);
  });

  it('omits the offset for the first page', () => {
    expect(offsetPageSql({ ...base, offset: 0 }).text).toBe(
      'select * from "fixtures"."big" order by "id" asc limit 1000',
    );
  });

  it('reverses for a descending sort', () => {
    expect(offsetPageSql({ ...base, direction: 'desc', offset: 10 }).text).toContain(
      'order by "id" desc',
    );
  });

  it('orders a composite key in index order', () => {
    const page = offsetPageSql({
      ...base,
      table: 'composite_pk',
      keyColumns: ['tenant_id', 'seq'],
      offset: 5,
    });
    expect(page.text).toContain('order by "tenant_id" asc, "seq" asc');
  });

  it('rejects a negative, fractional or unsafe offset', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => offsetPageSql({ ...base, offset: bad }), String(bad)).toThrow();
    }
    expect(() => offsetPageSql({ ...base, offset: Number.MAX_SAFE_INTEGER })).not.toThrow();
  });

  it('rejects an empty key and a bad limit, like keyset does', () => {
    expect(() => offsetPageSql({ ...base, keyColumns: [], offset: 0 })).toThrow();
    expect(() => offsetPageSql({ ...base, limit: 0, offset: 0 })).toThrow();
    expect(() => offsetPageSql({ ...base, limit: MAX_FETCH_ROWS + 1, offset: 0 })).toThrow();
  });
});
