/**
 * The SQL highlight layer (PLAN Phase 7).
 *
 * Tier 1 under AGENTS.md: a pure function from text to an HTML string, with no DOM
 * and no Vue. Written test-first, because the two properties that matter are easy
 * to get subtly wrong and invisible when they are:
 *
 *  - **The output must contain exactly the input's characters.** The highlight
 *    layer is a `<pre>` sitting behind a `<textarea>` whose text is transparent;
 *    one added or dropped character and every line after it is misaligned, which
 *    reads as the caret being in the wrong place. `tests` assert the round trip by
 *    stripping the tags back out and comparing to the source.
 *  - **Nothing in the source may become markup.** The result goes into
 *    `innerHTML`. A query containing `<img src=x onerror=…>` is ordinary text to
 *    Postgres and must stay ordinary text here — the CSP would block the handler,
 *    but relying on the CSP to cover an escaping bug is not a design.
 */
import { describe, expect, it } from 'vitest';
import {
  TOKEN_CLASSES,
  highlightToHtml,
  lineOf,
  lineOffsets,
  tokenClass,
  trailingLineGuard,
} from '@/sql/highlight';
import type { TokenKind } from '@shared/sql-lexer';

/**
 * The inverse of `highlightToHtml`, used to assert character fidelity.
 *
 * A test utility, so it lives here rather than in the module: shipping a
 * "remove the markup I just added" function next to the code that adds it would
 * invite someone to use it for real.
 *
 * Unescape order matters — `&lt;` and `&gt;` before `&amp;`, or a source that
 * literally contains `&lt;` would come back as `<`.
 */
function stripHighlight(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#13;/g, '\r')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

describe('character fidelity', () => {
  const CASES = [
    '',
    'select 1',
    'select * from t where a = 1;',
    "select 'a;b' -- note\nfrom t",
    '/* multi\nline */ select 1',
    '$$ body ; with $$',
    "select E'a\\'b'",
    'select "Mixed Case", a::text, b->>c',
    'line one\nline two\n\nline four\n',
    'trailing newline\n',
    '\n\nleading blanks',
    '\t\ttabs  and   runs   of spaces',
    'a\r\nb',
    'ünïcødé 日本語',
    '<script>alert(1)</script>',
    'select 1 & 2 < 3 > 0',
    "'unterminated",
    '"unterminated',
    '/* unterminated',
    '$$ unterminated',
  ];

  it('reproduces the source exactly for every case', () => {
    for (const sql of CASES) {
      expect(stripHighlight(highlightToHtml(sql)), JSON.stringify(sql)).toBe(sql);
    }
  });

  it('keeps the same number of line breaks as the source', () => {
    for (const sql of CASES) {
      const html = highlightToHtml(sql);
      const newlines = (text: string): number => text.split('\n').length - 1;
      expect(newlines(stripHighlight(html)), JSON.stringify(sql)).toBe(newlines(sql));
    }
  });

  it('produces no output for empty input', () => {
    expect(highlightToHtml('')).toBe('');
  });
});

describe('the trailing-line guard', () => {
  it('is a space when the source ends in a newline, and nothing otherwise', () => {
    // A `<pre>` whose text ends in `\n` renders one line fewer than a `<textarea>`
    // holding the same string, so the two drift apart as soon as the user presses
    // Enter at the end of the script. The component appends this inside the `<pre>`.
    //
    // It is a separate function rather than part of `highlightToHtml` so that the
    // highlight output stays an exact, reversible rendering of the source — the
    // fidelity property above would otherwise need to know about the guard.
    expect(trailingLineGuard('select 1\n')).toBe(' ');
    expect(trailingLineGuard('\n')).toBe(' ');
    expect(trailingLineGuard('\n\n')).toBe(' ');
    expect(trailingLineGuard('select 1')).toBe('');
    expect(trailingLineGuard('')).toBe('');
    expect(trailingLineGuard('a\r\n')).toBe(' ');
  });
});

describe('escaping', () => {
  it('escapes the three characters that would otherwise become markup', () => {
    const html = highlightToHtml('a < b & c > d');
    expect(html).toContain('&lt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&gt;');
    expect(html).not.toContain(' < ');
    expect(html).not.toContain(' & ');
  });

  it('leaves an injected tag inert', () => {
    const html = highlightToHtml("<img src=x onerror='alert(1)'>");
    expect(html).not.toContain('<img');
    // The lexer splits `<` from `img`, so the escaped form straddles two spans. What
    // matters is that no bare `<` survives and the characters round-trip.
    expect(html).toContain('&lt;');
    expect(html).not.toMatch(/<(?!span|\/span)/);
    expect(stripHighlight(html)).toBe("<img src=x onerror='alert(1)'>");
  });

  it('escapes a carriage return as a character reference, so it survives parsing', () => {
    // The HTML parser normalizes `\r\n` in parsed content to `\n`. A bare `\r` in
    // the generated markup would therefore vanish, making the highlight layer one
    // character shorter per line than the textarea behind it — every following line
    // offset. `&#13;` is not normalized. happy-dom does not normalize either, so
    // this asserts the escaping directly and the smoke harness proves it in Chromium.
    const html = highlightToHtml('a\r\nb');
    expect(html).toContain('&#13;');
    expect(html).not.toMatch(/\r/);
    expect(stripHighlight(html)).toBe('a\r\nb');
    expect(highlightToHtml("select '\r\n'")).toContain('&#13;');
  });

  it('round-trips a source that already looks like an entity', () => {
    // The source is SQL, not HTML: `&amp;` in a query is five literal characters
    // (an `&` operator followed by the identifier `amp` followed by `;`) and must
    // come back as those same five characters, neither collapsed to `&` nor
    // double-encoded on the way out.
    expect(stripHighlight(highlightToHtml('&amp;'))).toBe('&amp;');
    expect(stripHighlight(highlightToHtml('&lt;div&gt;'))).toBe('&lt;div&gt;');
  });

  it('escapes inside string literals and comments too, not only in code', () => {
    expect(highlightToHtml("select '<b>'")).toContain('&lt;b&gt;');
    expect(highlightToHtml('-- <b>')).toContain('&lt;b&gt;');
    // A quoted identifier is one token, so its text is escaped as a unit.
    expect(highlightToHtml('"a<b"')).toContain('&lt;b');
    expect(highlightToHtml('"a<b"')).not.toContain('<b');
  });
});

describe('token classes', () => {
  it('gives every token kind a class, so nothing renders unstyled by accident', () => {
    const kinds: TokenKind[] = [
      'whitespace',
      'lineComment',
      'blockComment',
      'string',
      'escapeString',
      'dollarString',
      'quotedIdent',
      'identifier',
      'keyword',
      'number',
      'operator',
      'punctuation',
      'semicolon',
      'parameter',
    ];
    for (const kind of kinds) {
      expect(typeof tokenClass(kind), kind).toBe('string');
      expect(tokenClass(kind).length, kind).toBeGreaterThan(0);
    }
    expect(kinds).toHaveLength(TOKEN_CLASSES.size);
  });

  it('uses a `tok-` prefix, so a class can never collide with app styling', () => {
    for (const className of TOKEN_CLASSES.values()) {
      expect(className.startsWith('tok-'), className).toBe(true);
    }
  });

  it('distinguishes the kinds a reader needs to tell apart', () => {
    expect(tokenClass('keyword')).not.toBe(tokenClass('identifier'));
    expect(tokenClass('string')).not.toBe(tokenClass('quotedIdent'));
    expect(tokenClass('lineComment')).toBe(tokenClass('blockComment'));
    expect(tokenClass('string')).toBe(tokenClass('escapeString'));
    expect(tokenClass('string')).toBe(tokenClass('dollarString'));
  });

  it('wraps code in spans and leaves whitespace bare', () => {
    const html = highlightToHtml('select 1');
    expect(html).toContain('<span class="tok-keyword">select</span>');
    expect(html).toContain('<span class="tok-number">1</span>');
    // Whitespace between tokens must not be inside a span: a trailing space inside
    // an inline element can be collapsed differently from a bare one.
    expect(html).toContain('</span> <span');
  });

  it('colours a whole script by kind', () => {
    const html = highlightToHtml("select 'x' -- c\nfrom t;");
    expect(html).toContain('tok-keyword">select');
    expect(html).toContain('tok-string');
    expect(html).toContain('tok-comment');
    expect(html).toContain('tok-keyword">from');
    expect(html).toContain('tok-punctuation">;');
  });
});

describe('line geometry', () => {
  it('reports the offset of every line, including a trailing empty one', () => {
    expect(lineOffsets('')).toEqual([0]);
    expect(lineOffsets('abc')).toEqual([0]);
    expect(lineOffsets('a\nb')).toEqual([0, 2]);
    expect(lineOffsets('a\n')).toEqual([0, 2]);
    expect(lineOffsets('\n\n')).toEqual([0, 1, 2]);
    expect(lineOffsets('a\r\nb')).toEqual([0, 3]);
  });

  it('maps a caret offset to a zero-based line number', () => {
    const sql = 'select 1;\nselect 2;\nselect 3';
    expect(lineOf(sql, 0)).toBe(0);
    expect(lineOf(sql, 8)).toBe(0);
    expect(lineOf(sql, 9)).toBe(0); // the newline itself still belongs to line 0
    expect(lineOf(sql, 10)).toBe(1);
    expect(lineOf(sql, 19)).toBe(1);
    expect(lineOf(sql, 20)).toBe(2);
    expect(lineOf(sql, 27)).toBe(2);
  });

  it('clamps an out-of-range or non-finite caret', () => {
    expect(lineOf('a\nb', -5)).toBe(0);
    expect(lineOf('a\nb', 999)).toBe(1);
    expect(lineOf('a\nb', Number.NaN)).toBe(0);
    expect(lineOf('a\nb', 1.9)).toBe(0);
  });

  it('agrees with the lexer about where lines start', () => {
    // The gutter, the current-line highlight and the pre all count lines the same
    // way; if they disagreed the highlight would sit on the wrong row.
    const sql = "select 'a\nb' -- c\nfrom t;\n";
    const offsets = lineOffsets(sql);
    expect(offsets).toHaveLength(4);
    for (let line = 0; line < offsets.length; line += 1) {
      expect(lineOf(sql, offsets[line] as number), `line ${line}`).toBe(line);
    }
  });
});
