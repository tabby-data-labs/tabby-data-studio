/**
 * The pure scanning helpers behind `scripts/check-i18n.mjs` (PLAN Phase 8).
 *
 * Tier 1, written test-first against small inline sources: reading the real
 * repository files here would couple the spec to trees other work is editing.
 * The single exception is the `scanDirectory` smoke check at the bottom, which
 * only asserts that a real walk neither throws nor returns junk.
 *
 * Expectations are derived from what the checker is for. A *missing* key is a
 * real bug the compiler cannot always catch (a key built by concatenation still
 * typechecks), so `findUsedKeys` must not invent call sites: `split('x')`,
 * `obj.t('x')` and a commented-out `t('x')` are not translations.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

interface ScanApi {
  findUsedKeys(source: string): string[];
  findCatalogueKeys(source: string): string[];
  diffKeys(
    used: readonly string[],
    catalogue: readonly string[],
  ): { missing: string[]; unused: string[] };
  scanDirectory(root: string, extensions: readonly string[]): { file: string; keys: string[] }[];
}

// The specifier is computed rather than literal on purpose: the CLI is a `.mjs`
// script and the tsconfigs do not enable allowJs, so TypeScript has no
// declaration to resolve for it. ScanApi above is the contract instead.
const scanModuleUrl = new URL('../../scripts/check-i18n.mjs', import.meta.url).href;
const { findUsedKeys, findCatalogueKeys, diffKeys, scanDirectory } = (await import(
  scanModuleUrl
)) as ScanApi;

describe('findUsedKeys()', () => {
  it('finds a single-quoted key', () => {
    expect(findUsedKeys(`t('common.close')`)).toEqual(['common.close']);
  });

  it('finds a double-quoted key', () => {
    expect(findUsedKeys(`t("common.cancel")`)).toEqual(['common.cancel']);
  });

  it('finds a backtick-quoted key', () => {
    expect(findUsedKeys('t(`theme.dark`)')).toEqual(['theme.dark']);
  });

  it('finds a key when a second argument follows', () => {
    expect(findUsedKeys(`t('history.shown', { count: 3 })`)).toEqual(['history.shown']);
  });

  it('returns keys in call order and keeps duplicates', () => {
    const source = [
      `const a = t('common.close');`,
      `const b = t('app.name');`,
      `const c = t('common.close');`,
    ].join('\n');
    expect(findUsedKeys(source)).toEqual(['common.close', 'app.name', 'common.close']);
  });

  it('finds a call that spans multiple lines', () => {
    const source = [
      'const label = t(',
      `  'export.done',`,
      `  { rows: result.rows, file: chosen.path },`,
      ');',
    ].join('\n');
    expect(findUsedKeys(source)).toEqual(['export.done']);
  });

  it('finds calls in a Vue template, inside an attribute and in an interpolation', () => {
    const source = [
      '<template>',
      `  <button :title="t('common.close')">{{ t('history.title') }}</button>`,
      '  <!-- a comment -->',
      '</template>',
      '<script setup lang="ts">',
      `const hint = t('palette.hint');`,
      '</script>',
    ].join('\n');
    expect(findUsedKeys(source)).toEqual(['common.close', 'history.title', 'palette.hint']);
  });

  it.each([
    ['a different function whose name ends in t', `split('common.close')`],
    ['a different function containing t', `format('common.close')`],
    ['a different single-letter function', `f('common.close')`],
    ['a two-letter function', `at('common.close')`],
    ['tPlural, whose first argument is a base', `tPlural('history.cleared', 1)`],
    ['a t reached through a property', `i18n.t('common.close')`],
    ['a t reached through this', `this.t('common.close')`],
    ['a $-prefixed global helper', `$t('common.close')`],
    ['an identifier-boundary character', `_t('common.close')`],
    ['a bare string that merely looks like a key', `const key = 'common.close';`],
    ['a key used as an object property name', `const o = { 'common.close': 1 };`],
    ['a line comment', `// t('common.close')`],
    ['a block comment', `/* t('common.close') */`],
    ['an HTML comment in a template', `<!-- t('common.close') -->`],
    ['a comment swallowing the rest of the line', `const a = 1; // t('common.close')`],
    ['a dynamic first argument', `t(someVariable)`],
    ['a template literal with an expression', 't(`common.${part}`)'],
    ['an empty key', `t('')`],
    ['a key with a space in it', `t('not a key')`],
    ['no arguments at all', `t()`],
    ['an unterminated string', `t('common.close`],
    ['a first argument that is not a string', `t(42)`],
    ['empty source', ''],
  ] as const)('does not match %s', (_label, source) => {
    expect(findUsedKeys(source)).toEqual([]);
  });

  it('still finds a real call after an ignored one', () => {
    const source = [`split('x'); t('common.close'); // t('ignored')`].join('\n');
    expect(findUsedKeys(source)).toEqual(['common.close']);
  });

  it('finds a call nested in the second argument of another', () => {
    expect(findUsedKeys(`t('export.failed', { reason: t('common.cancel') })`)).toEqual([
      'export.failed',
      'common.cancel',
    ]);
  });

  it('does not throw on malformed input', () => {
    for (const source of ['t(', "t('", 't(/*', 't(//\n', '/*', '<!--', 't(`)', "t('a''b')"]) {
      expect(() => findUsedKeys(source), source).not.toThrow();
    }
  });

  it('never builds a RegExp from the source it is given', () => {
    // A source containing a pattern that would blow up a naive `new RegExp(key)`.
    const hostile = `t('a'); const bad = '('; t('*+'); t('[');`;
    expect(() => findUsedKeys(hostile)).not.toThrow();
    expect(findUsedKeys(hostile)).toEqual(['a']);
  });
});

describe('findCatalogueKeys()', () => {
  const catalogue = (body: string) => `export const en = {\n${body}\n} as const;\n`;

  it('reads single-quoted keys in file order', () => {
    const source = catalogue([`  'app.name': 'Tabby',`, `  'common.close': 'Close',`].join('\n'));
    expect(findCatalogueKeys(source)).toEqual(['app.name', 'common.close']);
  });

  it('reads double-quoted keys', () => {
    const source = catalogue([`  "app.name": "Tabby",`, `  'common.close': 'Close',`].join('\n'));
    expect(findCatalogueKeys(source)).toEqual(['app.name', 'common.close']);
  });

  it('reads a key whose value starts on the next line', () => {
    const source = catalogue(
      [`  'history.privacy':`, `    'Stored only on this machine, never synced.',`, ``].join('\n'),
    );
    expect(findCatalogueKeys(source)).toEqual(['history.privacy']);
  });

  it('is not confused by braces inside a value', () => {
    const source = catalogue(
      [
        `  'history.shown': '{count} shown',`,
        `  'export.done': 'Wrote {rows} rows to {file}',`,
      ].join('\n'),
    );
    expect(findCatalogueKeys(source)).toEqual(['history.shown', 'export.done']);
  });

  it('does not report a colon inside a value as a key', () => {
    const source = catalogue(
      [`  'export.failed': 'Export failed: {reason}',`, `  'common.close': 'Close',`].join('\n'),
    );
    expect(findCatalogueKeys(source)).toEqual(['export.failed', 'common.close']);
  });

  it('does not end a value at an escaped quote', () => {
    const source = catalogue([`  'a.b': 'it\\'s: fine',`, `  'c.d': 'x',`].join('\n'));
    expect(findCatalogueKeys(source)).toEqual(['a.b', 'c.d']);
  });

  it('ignores comments inside the object', () => {
    const source = catalogue(
      [`  // 'commented.out': 'x',`, `  /* 'block.out': 'x', */`, `  'real.key': 'value',`].join(
        '\n',
      ),
    );
    expect(findCatalogueKeys(source)).toEqual(['real.key']);
  });

  it('ignores trailing source after the object, including the MessageKey alias', () => {
    const source = [
      `export const en = {`,
      `  'app.name': 'Tabby',`,
      `} as const;`,
      ``,
      `export type MessageKey = keyof typeof en;`,
      `const unused = { 'not.a.key': 1 };`,
    ].join('\n');
    expect(findCatalogueKeys(source)).toEqual(['app.name']);
  });

  it.each([
    ['no en object at all', `export const other = { 'a.b': 'x' };`],
    ['an empty object', `export const en = {} as const;`],
    ['empty source', ''],
  ] as const)('returns nothing for %s', (_label, source) => {
    expect(findCatalogueKeys(source)).toEqual([]);
  });

  it('does not throw on an unterminated object', () => {
    expect(() => findCatalogueKeys(`export const en = { 'a.b': 'x'`)).not.toThrow();
  });
});

describe('diffKeys()', () => {
  it('reports nothing when the two sets agree', () => {
    expect(diffKeys(['a', 'b'], ['b', 'a'])).toEqual({ missing: [], unused: [] });
  });

  it('reports a used key that the catalogue lacks', () => {
    expect(diffKeys(['a', 'gone'], ['a'])).toEqual({ missing: ['gone'], unused: [] });
  });

  it('reports a catalogue key nobody uses', () => {
    expect(diffKeys(['a'], ['a', 'idle'])).toEqual({ missing: [], unused: ['idle'] });
  });

  it('reports both at once', () => {
    expect(diffKeys(['a', 'gone'], ['a', 'idle'])).toEqual({
      missing: ['gone'],
      unused: ['idle'],
    });
  });

  it('dedupes and sorts both lists', () => {
    const used = ['z.dup', 'a.dup', 'z.dup', 'a.dup', 'missing.b', 'missing.a'];
    const catalogue = ['a.dup', 'z.dup', 'unused.b', 'unused.a'];
    expect(diffKeys(used, catalogue)).toEqual({
      missing: ['missing.a', 'missing.b'],
      unused: ['unused.a', 'unused.b'],
    });
  });

  it.each([
    ['both empty', [], []],
    ['nothing used', [], ['a', 'b']],
    ['an empty catalogue', ['a', 'b'], []],
  ] as const)('handles %s', (_label, used, catalogue) => {
    const result = diffKeys(used, catalogue);
    expect(result.missing).toEqual([...used].sort());
    expect(result.unused).toEqual([...catalogue].sort());
  });

  it('does not mutate its inputs', () => {
    const used = ['b', 'a'];
    const catalogue = ['a', 'c'];
    diffKeys(used, catalogue);
    expect(used).toEqual(['b', 'a']);
    expect(catalogue).toEqual(['a', 'c']);
  });
});

describe('scanDirectory() against the real renderer tree', () => {
  const root = fileURLToPath(new URL('../../src/renderer', import.meta.url));
  const extensions = ['.ts', '.vue'];

  it('walks the tree without throwing', () => {
    expect(() => scanDirectory(root, extensions)).not.toThrow();
  });

  it('returns one entry per matching file, with the keys that file uses', () => {
    const found = scanDirectory(root, extensions);

    expect(Array.isArray(found)).toBe(true);
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) {
      expect(typeof entry.file, entry.file).toBe('string');
      expect(entry.file, entry.file).toMatch(/\.(ts|vue)$/);
      expect(Array.isArray(entry.keys), entry.file).toBe(true);
      for (const key of entry.keys) expect(typeof key, entry.file).toBe('string');
    }
  });

  it('ignores extensions it was not asked for', () => {
    expect(scanDirectory(root, [])).toEqual([]);
  });
});
