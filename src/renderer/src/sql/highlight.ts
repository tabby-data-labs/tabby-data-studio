/**
 * Rendering the lexer's tokens as HTML for the editor's highlight layer
 * (PLAN Phase 7).
 *
 * The editor is a transparent-text `<textarea>` stacked on a `<pre>` holding this
 * output, scroll-synced and styled identically. That design has one unforgiving
 * property: **the rendered text must be character-for-character the source text.**
 * One extra or missing character and every following line is offset, which the user
 * experiences as the caret being in the wrong place. The fidelity tests in
 * `tests/unit/sql-highlight.spec.ts` assert the round trip rather than eyeballing it.
 *
 * The output is assigned to `innerHTML`, so escaping is a security boundary and not
 * a nicety. `&`, `<` and `>` are escaped in every token kind, including inside
 * string literals and comments, which is where a `<` is most likely to appear.
 *
 * Known limit: this re-lexes the whole document, so a paste of tens of thousands of
 * lines costs tens of milliseconds per keystroke. Fine for the query console; a
 * file-sized editor would need incremental re-lexing from the last stable token.
 */
import { lex, type TokenKind } from '@shared/sql-lexer';

/**
 * Token kind → CSS class.
 *
 * Exported so a test can assert that every kind the lexer can produce has a class:
 * a kind that silently fell through to a default would render as unstyled text, and
 * that is invisible in a screenshot of a query that happens not to use it.
 *
 * Comments share one class and the three string forms share another, because the
 * distinctions the lexer needs (`E''` escapes a backslash, `'…'` does not; block
 * comments nest) are not distinctions a reader needs to see.
 */
export const TOKEN_CLASSES: ReadonlyMap<TokenKind, string> = new Map<TokenKind, string>([
  ['whitespace', 'tok-ws'],
  ['lineComment', 'tok-comment'],
  ['blockComment', 'tok-comment'],
  ['string', 'tok-string'],
  ['escapeString', 'tok-string'],
  ['dollarString', 'tok-string'],
  ['quotedIdent', 'tok-quoted'],
  ['identifier', 'tok-ident'],
  ['keyword', 'tok-keyword'],
  ['number', 'tok-number'],
  ['operator', 'tok-operator'],
  ['punctuation', 'tok-punctuation'],
  ['semicolon', 'tok-punctuation'],
  ['parameter', 'tok-param'],
]);

export function tokenClass(kind: TokenKind): string {
  return TOKEN_CLASSES.get(kind) ?? 'tok-ident';
}

/**
 * Escapes the characters that would otherwise start markup — and the carriage
 * return, which would otherwise vanish.
 *
 * `&` first, or the `&` introduced by escaping `<` would itself be escaped and the
 * text would come out double-encoded.
 *
 * `\r` becomes `&#13;` because the HTML parser normalizes newlines in parsed
 * content: `innerHTML = "a\r\nb"` yields a text node reading `a\nb`. A script
 * pasted with Windows line endings would then be one character shorter per line
 * than the textarea it is stacked behind, and every following line would be offset.
 * A character reference is not normalized, so it survives. (happy-dom does *not*
 * normalize, which is why the unit tests cannot catch this on their own — the
 * smoke harness asserts it in real Chromium.)
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

/**
 * The source, coloured. Whitespace is emitted bare rather than wrapped: a trailing
 * space inside an inline element can be collapsed differently from a bare one, which
 * would break the character alignment the whole design rests on.
 */
export function highlightToHtml(sql: string): string {
  if (typeof sql !== 'string' || sql === '') return '';
  const { tokens } = lex(sql);
  let html = '';
  for (const token of tokens) {
    const text = escapeHtml(sql.slice(token.start, token.end));
    html +=
      token.kind === 'whitespace' ? text : `<span class="${tokenClass(token.kind)}">${text}</span>`;
  }
  return html;
}

/**
 * What the component appends inside the `<pre>` after {@link highlightToHtml}.
 *
 * A `<pre>` whose text ends in `\n` renders one line fewer than a `<textarea>`
 * holding the same string, so the two drift apart the moment the user presses Enter
 * at the end of a script. Kept out of `highlightToHtml` so that function stays an
 * exact, reversible rendering of its input.
 */
export function trailingLineGuard(sql: string): string {
  return typeof sql === 'string' && sql.endsWith('\n') ? ' ' : '';
}

/** Start offset of every line, including a trailing empty one. */
export function lineOffsets(sql: string): readonly number[] {
  if (typeof sql !== 'string') return [0];
  const offsets = [0];
  for (let i = 0; i < sql.length; i += 1) {
    if (sql.charAt(i) === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/**
 * The zero-based line a caret offset falls on.
 *
 * A caret sitting *on* a newline belongs to the line the newline ends, which is
 * where every text editor puts it and what makes the current-line highlight match
 * the visible caret.
 */
export function lineOf(sql: string, caret: number): number {
  if (typeof sql !== 'string' || !Number.isFinite(caret)) return 0;
  const at = Math.max(0, Math.min(Math.trunc(caret), sql.length));
  let line = 0;
  for (let i = 0; i < at; i += 1) {
    if (sql.charAt(i) === '\n') line += 1;
  }
  return line;
}
