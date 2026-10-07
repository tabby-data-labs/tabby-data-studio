/**
 * PLAN Phase 8 — i18n hooks (string extraction, no runtime framework).
 *
 * Tier 1 pure logic, written test-first. The expectations here come from the
 * Phase 8 contract, not from the implementation:
 *
 *  - the English catalogue is a fixed table — a renamed key or a reworded value
 *    breaks the components that consume it, so the whole table is pinned;
 *  - `t()` interpolates `{name}` in a single pass, so a param value is data and
 *    is never re-scanned for placeholders;
 *  - a placeholder with no matching param stays **visible**. An invisible empty
 *    string reads as a broken sentence; `{file}` reads as a missing argument;
 *  - param values are substituted literally, so `$&`, `$'` and `$1` — which are
 *    special in a `String.prototype.replace` replacement *string* — survive.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  currentLocale,
  interpolate,
  setLocale,
  t,
  tPlural,
} from '@/i18n';
import type { Locale } from '@/i18n';
import { en } from '@/i18n/en';

/**
 * The catalogue exactly as shipped, so a reword is a test failure.
 *
 * Extended from the original Phase 8 contract while wiring the export dialog and
 * the palette: each message those components need is its own entry, because
 * building one by concatenating a label onto a reason would put English word order
 * back into the code. `export.browse` and `export.destination` were **removed**
 * rather than left unused — there is deliberately no browse button and no
 * destination field, since a renderer-supplied path would be a write-anywhere
 * primitive.
 */
const EN_CATALOGUE: Readonly<Record<string, string>> = {
  'app.name': 'Tabby',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.clear': 'Clear all',
  'theme.label': 'Theme',
  'theme.dark': 'Dark',
  'theme.light': 'Light',
  'history.title': 'Query history',
  'history.empty': 'Nothing has been run yet. Statements you run from the editor are listed here.',
  'history.filterPlaceholder': 'Filter by statement or connection…',
  'history.privacy':
    'Stored only on this machine, never synced. Statements may contain literals that are secrets.',
  'history.shown': '{count} shown',
  'history.cleared.one': 'Cleared {count} history entry',
  'history.cleared.other': 'Cleared {count} history entries',
  'history.truncated': 'That entry was too long to store in full — it is shown, not runnable',
  'history.loadNotice': 'Statement loaded from history — press Run to execute it',
  'palette.placeholder': 'Type a command…',
  'palette.empty': 'No command matches “{query}”',
  'palette.hint': '↑↓ to move · ↵ to run · esc to close',
  'palette.label': 'Command palette',
  'export.title': 'Export result',
  'export.format': 'Format',
  'export.start': 'Export',
  'export.includeHeader': 'Include header row',
  'export.delimiter': 'Delimiter',
  'export.nullText': 'NULL text',
  'export.encoding': 'Encoding',
  'export.lineEnding': 'Line ending',
  'export.rowsPerInsert': 'Rows per INSERT',
  'export.bom': 'Byte-order mark',
  'export.streaming': 'Rows stream from main straight to disk; none pass through this window.',
  'export.started': 'Exporting {file}',
  'export.targetIs': 'INSERT target: {target}',
  'export.targetDefault':
    'This result is not a table scan, so the statements will target {target}. Rename it before running the file.',
  'export.latin1Warning':
    'latin1 cannot represent characters above U+00FF; they will be written as ?.',
  'export.nullCollision':
    'With an empty NULL text, a NULL and an empty string produce identical bytes. That is a limit of delimited formats, not of this export.',
  'export.delimiterOneChar': 'Delimiter must be exactly one character',
  'export.delimiterForbidden': 'Delimiter cannot be a line break, a quote or a NUL byte',
  'export.nullTextControl': 'NULL text cannot contain control characters',
  'export.nullTextLong': 'NULL text must be at most 32 characters',
  'export.batchAtLeastOne': 'Rows per INSERT must be at least 1',
  'export.progress': '{rows} rows written',
  'export.done': 'Wrote {rows} rows to {file}',
  'export.failed': 'Export failed: {reason}',
  'export.cancelled': 'Export cancelled',
  'export.cancelAction': 'Cancel export',
  'export.dismiss': 'Dismiss',
};

const PLACEHOLDER = /\{([^}]*)\}/g;

afterEach(() => {
  // The module holds the active locale, so a test that changes it would leak.
  setLocale(DEFAULT_LOCALE);
});

describe('catalogue', () => {
  it('matches the specified table exactly', () => {
    expect(en).toEqual(EN_CATALOGUE);
    expect(Object.keys(en)).toHaveLength(Object.keys(EN_CATALOGUE).length);
  });

  it('has no empty key and no empty value', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(key.trim(), key).not.toBe('');
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('only uses placeholder names that t() can address', () => {
    for (const [key, value] of Object.entries(en)) {
      for (const match of value.matchAll(PLACEHOLDER)) {
        expect(match[1], `${key}: {${match[1]}}`).toMatch(/^[A-Za-z0-9_.]+$/);
      }
    }
  });

  it('pairs every .one form with an .other form', () => {
    const ones = Object.keys(en).filter((key) => key.endsWith('.one'));
    expect(ones.length).toBeGreaterThan(0);
    for (const key of ones) {
      const base = key.slice(0, -'.one'.length);
      expect(Object.keys(en), base).toContain(`${base}.other`);
    }
  });
});

describe('locale state', () => {
  it('starts at DEFAULT_LOCALE', () => {
    expect(currentLocale()).toBe(DEFAULT_LOCALE);
  });

  it('exposes exactly the supported locales, including the default', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en']);
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it('accepts the default locale', () => {
    setLocale(DEFAULT_LOCALE);
    expect(currentLocale()).toBe(DEFAULT_LOCALE);
  });

  it('refuses an unsupported locale rather than silently accepting it', () => {
    const unsupported = 'fr' as unknown as Locale;
    setLocale(unsupported);
    expect(currentLocale()).toBe(DEFAULT_LOCALE);
  });

  it('keeps translating after a refused locale change', () => {
    setLocale('de' as unknown as Locale);
    expect(t('common.close')).toBe('Close');
  });
});

describe('t()', () => {
  it('returns a value that has no placeholder unchanged', () => {
    expect(t('app.name')).toBe('Tabby');
    expect(t('palette.hint')).toBe('↑↓ to move · ↵ to run · esc to close');
  });

  it('interpolates a number param', () => {
    expect(t('history.shown', { count: 3 })).toBe('3 shown');
  });

  it('formats numbers with the active locale, not as raw digits', () => {
    // Pinned deliberately: a grouping separator is what a user expects, and this
    // is the assertion that catches a switch to String(value).
    expect(t('history.shown', { count: 1200 })).toBe('1,200 shown');
    expect(t('export.progress', { rows: 1000000 })).toBe('1,000,000 rows written');
  });

  it('formats zero as zero', () => {
    expect(t('history.shown', { count: 0 })).toBe('0 shown');
  });

  it('interpolates a string param verbatim', () => {
    expect(t('palette.empty', { query: 'selct' })).toBe('No command matches “selct”');
  });

  it('leaves a placeholder with no matching param visible', () => {
    expect(t('export.done', { rows: 5 })).toBe('Wrote 5 rows to {file}');
    expect(t('export.done')).toBe('Wrote {rows} rows to {file}');
    expect(t('export.failed', {})).toBe('Export failed: {reason}');
  });

  it('replaces a param that is present but empty', () => {
    // Present-but-empty is a caller decision and must be honoured; only a
    // *missing* param stays visible.
    expect(t('export.done', { rows: 5, file: '' })).toBe('Wrote 5 rows to ');
  });

  it('ignores a param with no matching placeholder', () => {
    expect(t('app.name', { unused: 'x' })).toBe('Tabby');
    expect(t('history.shown', { count: 3, surplus: 9 })).toBe('3 shown');
    expect(t('export.done', { rows: 5, file: 'a.csv', surplus: 9 })).toBe('Wrote 5 rows to a.csv');
  });

  it('interpolates every placeholder in a value', () => {
    expect(t('export.done', { rows: 5, file: 'a.csv' })).toBe('Wrote 5 rows to a.csv');
  });

  it('never throws, whatever it is handed', () => {
    expect(() => t('app.name')).not.toThrow();
    expect(() => t('export.done')).not.toThrow();
    expect(() => t('export.done', {})).not.toThrow();
  });
});

describe('interpolate()', () => {
  it('replaces the same placeholder in every position', () => {
    expect(interpolate('{a} and {a}', { a: 'x' })).toBe('x and x');
    expect(interpolate('{a}{a}{a}', { a: '1' })).toBe('111');
  });

  it('replaces adjacent distinct placeholders', () => {
    expect(interpolate('{a}{b}', { a: '1', b: '2' })).toBe('12');
    expect(interpolate('{a}-{b}-{a}', { a: '1', b: '2' })).toBe('1-2-1');
  });

  it('is single-pass: a param value is never re-interpolated', () => {
    // Param values come from user data — a filename or a query can contain braces.
    expect(interpolate('{rows} rows', { rows: '{rows}' })).toBe('{rows} rows');
    expect(interpolate('{a}', { a: '{b}', b: 'nope' })).toBe('{b}');
  });

  it('treats the param value literally, not as a $-replacement pattern', () => {
    for (const value of ['$&', "$'", '$`', '$1', '$$', '$<a>']) {
      expect(interpolate('[{a}]', { a: value }), value).toBe(`[${value}]`);
    }
  });

  it('accepts names made of letters, digits, _ and .', () => {
    expect(interpolate('{a.b_c1}', { 'a.b_c1': 'v' })).toBe('v');
    expect(interpolate('{_x}', { _x: 'v' })).toBe('v');
    expect(interpolate('{A1}', { A1: 'v' })).toBe('v');
  });

  it.each([
    ['{} with no name', '{}', '{}'],
    ['an empty value', '', ''],
    ['a value with no placeholder', 'plain text', 'plain text'],
    ['a brace that opens nothing', 'a { b', 'a { b'],
    ['a brace that closes nothing', 'a } b', 'a } b'],
    ['an unterminated placeholder', '{a', '{a'],
    ['a name with an illegal character', '{a-b}', '{a-b}'],
    ['a nested placeholder', '{{a}}', '{v}'],
    ['whitespace inside the braces', '{ a }', '{ a }'],
    ['a trailing brace pair', 'a{}', 'a{}'],
  ] as const)('leaves %s alone', (_label, value, expected) => {
    expect(interpolate(value, { a: 'v' })).toBe(expected);
  });

  it('returns the value unchanged when no params are supplied', () => {
    expect(interpolate('{a} and {b}')).toBe('{a} and {b}');
  });

  it('does not mutate the params object', () => {
    const params: Record<string, string | number> = { a: 1 };
    interpolate('{a}{a}', params);
    expect(params).toEqual({ a: 1 });
  });
});

describe('tPlural()', () => {
  it('selects the .one form for exactly one', () => {
    expect(tPlural('history.cleared', 1, { count: 1 })).toBe('Cleared 1 history entry');
  });

  it('selects the .other form for everything else', () => {
    expect(tPlural('history.cleared', 2, { count: 2 })).toBe('Cleared 2 history entries');
  });

  it('uses the .other form for zero', () => {
    expect(tPlural('history.cleared', 0, { count: 0 })).toBe('Cleared 0 history entries');
  });

  it.each([
    [0, 'Cleared 0 history entries'],
    [1, 'Cleared 1 history entry'],
    [2, 'Cleared 2 history entries'],
    [3, 'Cleared 3 history entries'],
    [1200, 'Cleared 1,200 history entries'],
    [-1, 'Cleared -1 history entries'],
    [1.5, 'Cleared 1.5 history entries'],
  ] as const)('count %s -> %s', (count, expected) => {
    expect(tPlural('history.cleared', count, { count })).toBe(expected);
  });

  it('interpolates params into the selected form', () => {
    expect(tPlural('history.cleared', 1, { count: 1, surplus: 'x' })).toBe(
      'Cleared 1 history entry',
    );
  });

  it('shows the missing key instead of throwing when the base has no plural forms', () => {
    // tPlural's base is a plain string, unlike t()'s MessageKey, so this *is* a
    // reachable runtime path. Failing visibly beats rendering an empty string.
    expect(() => tPlural('nope.missing', 1)).not.toThrow();
    expect(tPlural('nope.missing', 1)).toContain('nope.missing');
    expect(tPlural('nope.missing', 2)).toContain('nope.missing');
  });
});
