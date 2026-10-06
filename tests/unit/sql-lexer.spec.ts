/**
 * The Postgres lexer (PLAN Phase 7).
 *
 * Tier 1 under AGENTS.md: a pure function of its input, no DOM, no IPC. Written
 * test-first, and the expectations come from §4.1 of the Postgres manual rather
 * than from the implementation — `''` escapes inside a standard string, `\'`
 * escapes only inside `E''`, block comments nest, `$tag$` bodies are opaque, `$1`
 * is a positional parameter and not a dollar-quote opener.
 *
 * One property matters more than any individual case, so it is asserted over a
 * corpus rather than once: **the tokens tile the input.** Every character belongs
 * to exactly one token, with no gaps and no overlaps. A gap is unstyled text in
 * the editor; an overlap is text rendered twice, which is how a highlight layer
 * silently drifts out of alignment with the textarea it sits behind.
 *
 * This module exists because two consumers need the same answer and must not be
 * allowed to disagree: the editor highlights with it, and `src/main/db/sql-scan.ts`
 * — the security control that decides whether SQL may be wrapped in
 * `DECLARE … CURSOR FOR` — is rebuilt on top of it. Two lexers would eventually
 * split a script differently from how main validates it.
 */
import { describe, expect, it } from 'vitest';
import { KEYWORDS, isKeyword, lex, type Token, type TokenKind } from '../../src/shared/sql-lexer';

/** Every token in order, as `kind:text`, for readable failures. */
function shapes(sql: string): string[] {
  return lex(sql).tokens.map((token) => `${token.kind}:${sql.slice(token.start, token.end)}`);
}

function kinds(sql: string): TokenKind[] {
  return lex(sql).tokens.map((token) => token.kind);
}

/** Inputs chosen to break a naive lexer. Used by the tiling property below. */
const CORPUS = [
  '',
  ' ',
  '\n\n\n',
  'select 1',
  'SELECT * FROM "Mixed Case" WHERE x = 1;',
  'a;b;c',
  "select 'a;b'",
  "select 'it''s;fine'",
  "select 'a\\'; select 2",
  "select E'a\\'; still inside'",
  "select e'\\n'",
  'select "a""b;c"',
  'select 1 -- trailing; comment',
  "select 1 -- don't",
  'select 1 /* a /* b ; c */ d */',
  '/*/*/*/',
  'select $$ a ; b $$',
  'select $tag$ a ; b $tag$',
  'select $tag_1$ a ; b $tag_1$',
  'select $outer$ $inner$ ; $inner$ $outer$',
  'select $1 + $12 + $',
  "create function f() returns void as $$ begin raise notice 'x'; end; $$ language plpgsql;",
  'select 1.5, .5, 1e10, 1.5e-3, 42',
  'select a::text, b->c, d->>e, f#>g, h#>>i, j||k, l<=m, n<>o, p!=q',
  'select -1, +2, a-b, a*b, a/b, a%b, a^b, ~a, a|b, a&b, a@b, a#b',
  'select (a)[1], b.c.d, e,',
  'select 1 \u0000 ; drop table x',
  "select 'unterminated",
  'select "unterminated',
  'select /* unterminated',
  'select $$ unterminated',
  'x"\'; DROP TABLE users; --',
  '\u0000',
  'select\t\t1\r\nfrom\rt',
  'é, 日本語, "unicode_ünïcødé"',
  'select 1;;select 2',
  '--only a comment',
  '/* only a block comment */',
  ';',
  '$',
  '$$',
  '$$$$',
  'E',
  "E'",
  'select E',
  'nSeLeCt',
  "fooE'x'",
  '-- x\r\ny',
  'a::text b->c d#>>e f||g h<=i j<>k l!=m',
];

describe('tiling', () => {
  it('covers every character exactly once, for every input in the corpus', () => {
    for (const sql of CORPUS) {
      const { tokens } = lex(sql);
      let cursor = 0;
      for (const token of tokens) {
        expect(token.start, `${JSON.stringify(sql)} at ${cursor}`).toBe(cursor);
        expect(token.end, JSON.stringify(sql)).toBeGreaterThan(token.start);
        expect(token.end, JSON.stringify(sql)).toBeLessThanOrEqual(sql.length);
        cursor = token.end;
      }
      expect(cursor, `ungapped coverage of ${JSON.stringify(sql)}`).toBe(sql.length);
    }
  });

  it('returns no tokens for an empty input rather than one empty token', () => {
    expect(lex('').tokens).toEqual([]);
    expect(lex('').error).toBeNull();
  });

  it('never throws, whatever it is given', () => {
    // A half-typed query is the *normal* state of an editor. A lexer that throws
    // would take the highlight layer down on every keystroke of `'abc`.
    for (const sql of CORPUS) {
      expect(() => lex(sql), JSON.stringify(sql)).not.toThrow();
    }
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(() => lex(bad as unknown as string)).not.toThrow();
    }
  });

  it('treats non-string input as empty instead of coercing it', () => {
    expect(lex(42 as unknown as string).tokens).toEqual([]);
    expect(lex(null as unknown as string).tokens).toEqual([]);
  });
});

describe('simple tokens', () => {
  it('classifies a keyword, whitespace and a number', () => {
    expect(shapes('select 1')).toEqual(['keyword:select', 'whitespace: ', 'number:1']);
  });

  it('recognises keywords case-insensitively', () => {
    expect(kinds('SELECT select SeLeCt')).toEqual([
      'keyword',
      'whitespace',
      'keyword',
      'whitespace',
      'keyword',
    ]);
    expect(isKeyword('SELECT')).toBe(true);
    expect(isKeyword('from')).toBe(true);
  });

  it('leaves an ordinary identifier alone', () => {
    expect(shapes('users')).toEqual(['identifier:users']);
    expect(shapes('_private a$1 A_9')).toEqual([
      'identifier:_private',
      'whitespace: ',
      'identifier:a$1',
      'whitespace: ',
      'identifier:A_9',
    ]);
  });

  it('splits a qualified name at the dot, since the dot is its own token', () => {
    expect(kinds('b.c.d')).toEqual([
      'identifier',
      'punctuation',
      'identifier',
      'punctuation',
      'identifier',
    ]);
  });

  it('tokenises numbers including decimals and exponents', () => {
    expect(shapes('1 1.5 .5 1e10 1.5e-3')).toEqual([
      'number:1',
      'whitespace: ',
      'number:1.5',
      'whitespace: ',
      'number:.5',
      'whitespace: ',
      'number:1e10',
      'whitespace: ',
      'number:1.5e-3',
    ]);
  });

  it('separates the semicolon from other punctuation', () => {
    expect(kinds('a;')).toEqual(['identifier', 'semicolon']);
    expect(kinds('(a)[1],b')).toEqual([
      'punctuation',
      'identifier',
      'punctuation',
      'punctuation',
      'number',
      'punctuation',
      'punctuation',
      'identifier',
    ]);
  });

  it('reads multi-character operators as one token', () => {
    // `text` is a genuine (non-reserved) Postgres keyword — it is a type name — so
    // colouring it as one is right, not a mis-lex of the cast.
    expect(shapes('a::text')).toEqual(['identifier:a', 'operator:::', 'keyword:text']);
    expect(shapes('a::my_type')).toEqual(['identifier:a', 'operator:::', 'identifier:my_type']);
    expect(shapes('a->b')).toEqual(['identifier:a', 'operator:->', 'identifier:b']);
    expect(shapes('a->>b')).toEqual(['identifier:a', 'operator:->>', 'identifier:b']);
    expect(shapes('a#>>b')).toEqual(['identifier:a', 'operator:#>>', 'identifier:b']);
    expect(shapes('a||b')).toEqual(['identifier:a', 'operator:||', 'identifier:b']);
    expect(shapes('a<=b')).toEqual(['identifier:a', 'operator:<=', 'identifier:b']);
    expect(shapes('a<>b')).toEqual(['identifier:a', 'operator:<>', 'identifier:b']);
    expect(shapes('a!=b')).toEqual(['identifier:a', 'operator:!=', 'identifier:b']);
  });

  it('keeps a leading minus as an operator, not part of the number', () => {
    // `a-1` and `-1` must lex the same way round as Postgres reads them, and a
    // highlighter that glued the sign to the literal would colour `a-1` as one number.
    expect(shapes('-1')).toEqual(['operator:-', 'number:1']);
    expect(shapes('a-1')).toEqual(['identifier:a', 'operator:-', 'number:1']);
  });

  it('does not read `--` as two minus signs', () => {
    expect(kinds('--x')).toEqual(['lineComment']);
  });
});

describe('strings', () => {
  it('takes a standard string as one token, semicolon included', () => {
    const sql = "select 'a;b'";
    expect(shapes(sql)).toEqual(['keyword:select', 'whitespace: ', "string:'a;b'"]);
    const string = lex(sql).tokens[2] as Token;
    expect(sql.slice(string.start, string.end)).toBe("'a;b'");
  });

  it("treats '' as an escaped quote, not as the end of the literal", () => {
    expect(shapes("'it''s'")).toEqual(["string:'it''s'"]);
    expect(shapes("'a''b''c'")).toEqual(["string:'a''b''c'"]);
  });

  it('does not honour a backslash escape in a standard string', () => {
    // standard_conforming_strings has been on by default since 9.1, so `\'` closes
    // the literal. Getting this backwards hides whatever follows the quote.
    expect(shapes("'a\\'")).toEqual(["string:'a\\'"]);
    expect(shapes("select 'a\\'; select 2")).toEqual([
      'keyword:select',
      'whitespace: ',
      "string:'a\\'",
      'semicolon:;',
      'whitespace: ',
      'keyword:select',
      'whitespace: ',
      'number:2',
    ]);
  });

  it('honours a backslash escape inside an E-string, in either case', () => {
    expect(shapes("E'a\\'; still inside'")).toEqual(["escapeString:E'a\\'; still inside'"]);
    expect(shapes("e'a\\''")).toEqual(["escapeString:e'a\\''"]);
  });

  it('still treats a doubled quote as an escape inside an E-string', () => {
    expect(shapes("E'it''s'")).toEqual(["escapeString:E'it''s'"]);
  });

  it('does not mistake a trailing E of an identifier for an escape-string prefix', () => {
    // Degenerate input, but the two readings differ in where the string ends, so
    // the rule has to be stated: the prefix only counts when it starts the token.
    expect(shapes("fooE'x'")).toEqual(['identifier:fooE', "string:'x'"]);
  });

  it('takes a quoted identifier as one token, with "" escapes', () => {
    expect(shapes('"a""b;c"')).toEqual(['quotedIdent:"a""b;c"']);
    expect(shapes('"Mixed Case"')).toEqual(['quotedIdent:"Mixed Case"']);
  });

  it('keeps a non-ASCII identifier in one token', () => {
    expect(shapes('日本語')).toEqual(['identifier:日本語']);
    expect(shapes('"unicode_ünïcødé"')).toEqual(['quotedIdent:"unicode_ünïcødé"']);
  });
});

describe('comments', () => {
  it('runs a line comment to the newline, keeping the newline as whitespace', () => {
    expect(shapes('a -- c\nb')).toEqual([
      'identifier:a',
      'whitespace: ',
      'lineComment:-- c',
      'whitespace:\n',
      'identifier:b',
    ]);
  });

  it('runs a line comment to the end of the input when there is no newline', () => {
    expect(shapes('-- only')).toEqual(['lineComment:-- only']);
  });

  it('does not open a string from an apostrophe inside a comment', () => {
    expect(shapes("-- don't\nselect 1")).toEqual([
      "lineComment:-- don't",
      'whitespace:\n',
      'keyword:select',
      'whitespace: ',
      'number:1',
    ]);
  });

  it('takes a nested block comment as one token', () => {
    expect(shapes('/* a /* b */ c */ select')).toEqual([
      'blockComment:/* a /* b */ c */',
      'whitespace: ',
      'keyword:select',
    ]);
  });

  it('handles CRLF inside a line comment', () => {
    expect(shapes('-- x\r\ny')).toEqual(['lineComment:-- x', 'whitespace:\r\n', 'identifier:y']);
  });
});

describe('dollar quoting and parameters', () => {
  it('takes an untagged dollar body as one token', () => {
    expect(shapes('$$ a ; b $$')).toEqual(['dollarString:$$ a ; b $$']);
  });

  it('takes a tagged dollar body as one token', () => {
    expect(shapes('$tag$ a ; b $tag$')).toEqual(['dollarString:$tag$ a ; b $tag$']);
    expect(shapes('$tag_1$ x $tag_1$')).toEqual(['dollarString:$tag_1$ x $tag_1$']);
  });

  it('does not end an outer body at a nested tag', () => {
    expect(shapes('$outer$ $inner$ ; $inner$ $outer$')).toEqual([
      'dollarString:$outer$ $inner$ ; $inner$ $outer$',
    ]);
  });

  it('keeps a function body opaque, so its semicolons are not separators', () => {
    const sql =
      "create function f() returns void as $$ begin raise notice 'x;y'; end; $$ language plpgsql;";
    const semicolons = lex(sql)
      .tokens.filter((token) => token.kind === 'semicolon')
      .map((token) => token.start);
    // One statement, one terminator: the two semicolons inside the body and the one
    // inside the notice literal are all data.
    expect(semicolons).toEqual([sql.length - 1]);
  });

  it('reads $1 and $12 as positional parameters', () => {
    expect(shapes('$1')).toEqual(['parameter:$1']);
    expect(shapes('$12')).toEqual(['parameter:$12']);
    expect(shapes('a + $1')).toEqual([
      'identifier:a',
      'whitespace: ',
      'operator:+',
      'whitespace: ',
      'parameter:$1',
    ]);
  });

  it('does not read $1 as a dollar-quote opener', () => {
    expect(kinds('$1')).toEqual(['parameter']);
    expect(kinds('$1;')).toEqual(['parameter', 'semicolon']);
  });

  it('leaves a lone $ as an operator', () => {
    expect(shapes('$')).toEqual(['operator:$']);
    expect(shapes('$ ')).toEqual(['operator:$', 'whitespace: ']);
  });

  it('treats an empty $$ body as a complete token', () => {
    expect(shapes('$$$$')).toEqual(['dollarString:$$$$']);
  });
});

describe('structural errors', () => {
  it('reports an unterminated string at the opening quote, and still tiles', () => {
    const result = lex("select 'abc");
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/unterminated/i);
    expect(result.error?.at).toBe(7);
    // The highlighter still gets usable tokens: the rest of the line is coloured
    // as a string, which is what the user sees in the editor.
    expect(result.tokens.map((token) => token.kind)).toEqual(['keyword', 'whitespace', 'string']);
    expect(result.tokens[2]?.end).toBe(11);
  });

  it('reports an unterminated quoted identifier', () => {
    expect(lex('select "abc').error?.message).toMatch(/unterminated/i);
  });

  it('reports an unterminated block comment', () => {
    expect(lex('select 1 /* never closed').error?.message).toMatch(/unterminated/i);
    expect(lex('/*/*/*/ select 1').error?.message).toMatch(/unterminated/i);
  });

  it('reports an unterminated dollar body', () => {
    expect(lex('select $$ never closed').error?.message).toMatch(/unterminated/i);
  });

  it('reports a NUL byte at its offset', () => {
    // A NUL would truncate the statement server-side, silently dropping whatever
    // followed it. The lexer reports it; main refuses the statement.
    const result = lex('ab\u0000cd');
    expect(result.error?.message).toMatch(/NUL/);
    expect(result.error?.at).toBe(2);
  });

  it('reports a NUL byte wherever it sits, even inside a literal', () => {
    // Postgres rejects a NUL anywhere in the query text — it is a C string — so the
    // check runs before lexing rather than only at top level. A NUL buried in an
    // unterminated literal would otherwise be reported as "unterminated", sending
    // the user to fix the wrong thing.
    const result = lex("'unterminated and \u0000");
    expect(result.error?.message).toMatch(/NUL/);
    expect(result.error?.at).toBe(18);
  });

  it('reports no error for a complete script', () => {
    for (const sql of [
      'select 1;',
      "select 'a;b'; -- done",
      '$$ x $$',
      '/* nested /* */ */ select 1',
      'select $1',
    ]) {
      expect(lex(sql).error, sql).toBeNull();
    }
  });
});

describe('keyword list', () => {
  it('covers the words a reader expects to see coloured', () => {
    for (const word of [
      'select',
      'from',
      'where',
      'insert',
      'update',
      'delete',
      'create',
      'table',
      'index',
      'join',
      'left',
      'group',
      'order',
      'limit',
      'returning',
      'begin',
      'commit',
      'rollback',
      'with',
      'as',
      'on',
      'and',
      'or',
      'not',
      'null',
      'true',
      'false',
      'case',
      'when',
      'then',
      'else',
      'end',
      'explain',
      'analyze',
    ]) {
      expect(KEYWORDS.has(word), word).toBe(true);
    }
  });

  it('stores keywords lowercase and rejects anything else', () => {
    for (const word of KEYWORDS) {
      expect(word, word).toBe(word.toLowerCase());
    }
    expect(isKeyword('users')).toBe(false);
    expect(isKeyword('')).toBe(false);
    expect(isKeyword('constructor')).toBe(false);
    expect(isKeyword('__proto__')).toBe(false);
  });

  it('is a Set, not an object literal, so prototype keys cannot resolve', () => {
    // `KEYWORDS['constructor']` on a plain object would be truthy and every
    // identifier named `constructor` would be coloured as a keyword.
    expect(KEYWORDS instanceof Set).toBe(true);
    expect(KEYWORDS.has('toString')).toBe(false);
    expect(KEYWORDS.has('hasOwnProperty')).toBe(false);
  });
});
