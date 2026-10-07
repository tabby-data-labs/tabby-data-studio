/**
 * The command palette's fuzzy matcher (PLAN Phase 8).
 *
 * Tier 1, written test-first. Expectations are derived from the module contract,
 * not from an implementation, and two of them are checked structurally rather
 * than against hard-coded numbers because they are what the palette UI rests on:
 *
 *  - `fuzzyMatch` returns null **exactly** when the query is not a subsequence of
 *    the text — checked against the independent reference scan below, over a
 *    corpus that includes empty, single-character, repeated-character, astral,
 *    combining-mark, lone-surrogate and regex-metacharacter inputs;
 *  - `matchedIndexes` are UTF-16 offsets into `text`, strictly ascending and in
 *    range, so `text.slice(i, i + 1)` can underline a single matched letter. The
 *    astral cases pin the UTF-16 basis; a code-point basis would disagree.
 *
 * Scores are only ever *compared*, never snapshotted. The contract is an
 * ordering; pinning numbers would pin the implementation instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { fuzzyMatch, fuzzyRank } from '@/palette/fuzzy';

const WHITESPACE = /\s/u;

/** The query characters that must be found in the text, in order. */
function matchable(query: string): readonly string[] {
  return [...query].filter((character) => !WHITESPACE.test(character));
}

/**
 * Reference subsequence test, written from the contract independently of the
 * module: whitespace in the query is ignorable, comparison is case-insensitive.
 */
function isSubsequence(query: string, text: string): boolean {
  const wanted = matchable(query);
  let found = 0;
  for (const character of text) {
    if (found >= wanted.length) break;
    if (character.toLowerCase() === wanted[found]!.toLowerCase()) found += 1;
  }
  return found === wanted.length;
}

/** BMP-only, so `text[i]` is a whole character and the contract's literal form applies. */
function isBmp(value: string): boolean {
  return [...value].every((character) => character.length === 1);
}

/**
 * Boundary and degenerate inputs first, then the shapes the palette actually
 * sees, then the inputs chosen to be hostile: regex metacharacters (the query is
 * untrusted keystroke-by-keystroke input), astral characters, combining marks,
 * a lone surrogate, NUL, and sizes big enough to expose a superlinear matcher.
 */
const CORPUS: readonly (readonly [query: string, text: string])[] = [
  ['', ''],
  ['', 'select'],
  ['   ', 'select'],
  ['\t\n', ''],
  ['s', ''],
  ['s', 'select'],
  ['a', 'a'],
  ['b', 'a'],
  ['select', ''],
  ['select', 'select'],
  ['SELECT', 'select'],
  ['select', 'SELECT'],
  ['selects', 'select'],
  ['slct', 'select'],
  ['sel', 's_x_e_l'],
  ['ee', 'select'],
  ['aaa', 'aaaa'],
  ['aaaa', 'aaa'],
  ['a b', 'ab'],
  ['select ', 'select'],
  [' sel ', 'select'],
  ['st', 'schemaTree'],
  ['st', 'schema_tree'],
  ['st', 'first'],
  ['st', 'ST'],
  ['.b', 'a.b'],
  ['.*', 'select'],
  ['((((*', '((((*'],
  ['(((((((((a', 'aaaaaaaaaa'],
  ['[a-z]+', 'abc'],
  ['\\d', 'a\\d'],
  ['nst', 'no such thing here'],
  ['🐘', 'a🐘b'],
  ['🐘b', 'a🐘b'],
  ['ab', 'a🐘b'],
  ['🐘🐘', '🐘x🐘'],
  ['Él', 'Élève'],
  ['è', 'Élève'],
  // Precomposed vs combining: deliberately NOT equivalent, because normalising
  // would change the text's length and invalidate the UTF-16 index contract.
  ['é', 'e\u0301'],
  ['e\u0301', 'é'],
  ['\uD800', 'a\uD800b'],
  ['ab', 'a\uD800b'],
  ['\u0000', 'a\u0000b'],
  ['x'.repeat(300), 'x'.repeat(300)],
  ['abc', 'a'.repeat(5000)],
];

describe('fuzzyMatch — subsequence semantics', () => {
  it('treats an empty or whitespace-only query as matching everything, at score 0', () => {
    for (const query of ['', ' ', '   ', '\t', '\n', ' \t\n ']) {
      for (const text of ['', 'select', '🐘']) {
        const result = fuzzyMatch(query, text);
        expect(result, `query ${JSON.stringify(query)}`).not.toBeNull();
        expect(result!.score).toBe(0);
        expect(result!.matchedIndexes).toEqual([]);
      }
    }
  });

  it('matches a subsequence, not a substring', () => {
    expect(fuzzyMatch('slct', 'select')?.matchedIndexes).toEqual([0, 2, 4, 5]);
    expect(fuzzyMatch('sel', 's_x_e_l')?.matchedIndexes).toEqual([0, 4, 6]);
  });

  it('is case-insensitive in both directions', () => {
    expect(fuzzyMatch('SELECT', 'select')?.matchedIndexes).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fuzzyMatch('select', 'SELECT')?.matchedIndexes).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fuzzyMatch('Él', 'Élève')?.matchedIndexes).toEqual([0, 1]);
  });

  it('ignores whitespace inside the query', () => {
    expect(fuzzyMatch('a b', 'ab')?.matchedIndexes).toEqual([0, 1]);
    expect(fuzzyMatch(' sel ', 'select')?.matchedIndexes).toEqual([0, 1, 2]);
    // A trailing space is what a user types before noticing the palette closed.
    expect(fuzzyMatch('select ', 'select')?.matchedIndexes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('returns null when the query is longer than the text', () => {
    expect(fuzzyMatch('selects', 'select')).toBeNull();
    expect(fuzzyMatch('select', '')).toBeNull();
    expect(fuzzyMatch('aaaa', 'aaa')).toBeNull();
    expect(fuzzyMatch('s', '')).toBeNull();
  });

  it('handles single characters and repeated characters', () => {
    expect(fuzzyMatch('a', 'a')?.matchedIndexes).toEqual([0]);
    expect(fuzzyMatch('b', 'a')).toBeNull();
    expect(fuzzyMatch('ee', 'select')?.matchedIndexes).toEqual([1, 3]);
    expect(fuzzyMatch('aaa', 'aaaa')?.matchedIndexes).toEqual([0, 1, 2]);
  });

  it('returns null exactly when the query is not a subsequence of the text', () => {
    for (const [query, text] of CORPUS) {
      const label = `${JSON.stringify(query)} in ${JSON.stringify(text)}`;
      expect(fuzzyMatch(query, text) !== null, label).toBe(isSubsequence(query, text));
    }
  });

  it('indexes astral characters by their UTF-16 offset', () => {
    const text = 'a🐘b';
    const result = fuzzyMatch('🐘b', text);
    expect(result).not.toBeNull();
    expect(result!.matchedIndexes).toEqual([1, 3]);
    // The point of the UTF-16 basis: these slices are what highlighting uses.
    expect(text.slice(1, 3)).toBe('🐘');
    expect(text.slice(3, 4)).toBe('b');
    expect(text.length).toBe(4);
  });

  it('keeps offsets exact around an unpaired surrogate', () => {
    const text = 'a\uD800b';
    expect(fuzzyMatch('\uD800', text)?.matchedIndexes).toEqual([1]);
    expect(fuzzyMatch('ab', text)?.matchedIndexes).toEqual([0, 2]);
    expect(text.slice(2, 3)).toBe('b');
  });

  it('does not build a RegExp from the query', () => {
    // Unbalanced metacharacters: a compiled pattern would either throw or
    // backtrack catastrophically. This must simply be a non-match, quickly.
    const started = performance.now();
    expect(fuzzyMatch('('.repeat(24) + 'a', '('.repeat(400))).toBeNull();
    expect(fuzzyMatch('(((((((((a', 'aaaaaaaaaa')).toBeNull();
    expect(fuzzyMatch('.*', 'select')).toBeNull();
    expect(fuzzyMatch('((((*', '((((*')?.matchedIndexes).toEqual([0, 1, 2, 3, 4]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('fuzzyMatch — matchedIndexes invariants', () => {
  it('are strictly ascending, in range, and one per matchable query character', () => {
    for (const [query, text] of CORPUS) {
      const result = fuzzyMatch(query, text);
      if (result === null) continue;
      const label = `${JSON.stringify(query)} in ${JSON.stringify(text)}`;
      const expected = matchable(query);
      expect(result.matchedIndexes, label).toHaveLength(expected.length);
      let previous = -1;
      for (const index of result.matchedIndexes) {
        expect(index, label).toBeGreaterThan(previous);
        expect(index, label).toBeGreaterThanOrEqual(0);
        expect(index, label).toBeLessThan(text.length);
        previous = index;
      }
    }
  });

  it('point at the query characters they claim, in order', () => {
    for (const [query, text] of CORPUS) {
      const result = fuzzyMatch(query, text);
      if (result === null) continue;
      const label = `${JSON.stringify(query)} in ${JSON.stringify(text)}`;
      const expected = matchable(query);
      result.matchedIndexes.forEach((index, k) => {
        // `text[index]` is a lone surrogate when an astral character matched, so
        // the contract's `text[i].toLowerCase() === q.toLowerCase()` is asserted
        // per code point here and in its literal single-unit form below.
        const matched = String.fromCodePoint(text.codePointAt(index)!);
        expect(matched.toLowerCase(), label).toBe(expected[k]!.toLowerCase());
      });
    }
  });

  it('satisfy the literal single-unit form for BMP text', () => {
    for (const [query, text] of CORPUS) {
      if (!isBmp(query) || !isBmp(text)) continue;
      const result = fuzzyMatch(query, text);
      if (result === null) continue;
      const expected = matchable(query);
      result.matchedIndexes.forEach((index, k) => {
        expect(text[index]!.toLowerCase()).toBe(expected[k]!.toLowerCase());
      });
    }
  });

  it('is finite, non-negative, positive for a real match, and deterministic', () => {
    for (const [query, text] of CORPUS) {
      const first = fuzzyMatch(query, text);
      const second = fuzzyMatch(query, text);
      const label = `${JSON.stringify(query)} in ${JSON.stringify(text)}`;
      expect(second, label).toStrictEqual(first);
      if (first === null) continue;
      expect(Number.isFinite(first.score), label).toBe(true);
      expect(first.score, label).toBeGreaterThanOrEqual(0);
      if (matchable(query).length > 0) expect(first.score, label).toBeGreaterThan(0);
    }
  });

  it('never throws, for any input in the corpus', () => {
    for (const [query, text] of CORPUS) {
      expect(() => fuzzyMatch(query, text)).not.toThrow();
    }
  });
});

describe('fuzzyMatch — scoring order', () => {
  function scoreOf(query: string, text: string): number {
    const result = fuzzyMatch(query, text);
    expect(result, `${JSON.stringify(query)} in ${JSON.stringify(text)}`).not.toBeNull();
    return result!.score;
  }

  it('1. an exact match outscores everything else', () => {
    const exact = scoreOf('select', 'select');
    expect(exact).toBeGreaterThan(scoreOf('select', 'select from users'));
    expect(exact).toBeGreaterThan(scoreOf('select', 'selectall'));
    expect(exact).toBeGreaterThan(scoreOf('select', 's.e.l.e.c.t'));
    expect(exact).toBeGreaterThan(scoreOf('select', 'preselect'));
    // Case is not part of identity here: matching is case-insensitive.
    expect(scoreOf('select', 'SELECT')).toBe(exact);
  });

  it('2. a contiguous substring outscores a scattered subsequence', () => {
    expect(scoreOf('sel', 'select')).toBeGreaterThan(scoreOf('sel', 's_x_e_l'));
  });

  it('3. a match at the start of the text outscores the same match later', () => {
    // Equal lengths, so the length penalty cannot be the cause.
    expect(scoreOf('el', 'elxxxx')).toBeGreaterThan(scoreOf('el', 'xxelxx'));
  });

  it('4. a word-boundary match outscores a mid-word match', () => {
    const midWord = scoreOf('st', 'first');
    expect(scoreOf('st', 'schemaTree')).toBeGreaterThan(midWord);
    expect(scoreOf('st', 'schema_tree')).toBeGreaterThan(midWord);
    expect(scoreOf('st', 'schema.tree')).toBeGreaterThan(midWord);
    expect(scoreOf('st', 'schema-tree')).toBeGreaterThan(midWord);
    expect(scoreOf('st', 'schema tree')).toBeGreaterThan(midWord);
  });

  it('5. a longer contiguous run outscores the same characters broken up', () => {
    // Both texts are 6 long, both start the match at index 1, neither match is on
    // a word boundary: only the run length differs.
    expect(scoreOf('sel', 'xselxx')).toBeGreaterThan(scoreOf('sel', 'xsexlx'));
  });

  it('6. a shorter text outscores a longer one for the same match shape', () => {
    expect(scoreOf('sel', 'select')).toBeGreaterThan(scoreOf('sel', 'select from users'));
  });

  it('7. a match earlier in the text outscores a later one', () => {
    // Equal lengths and equal shape (one adjacent pair, no word boundary), so
    // only the position of the first matched character differs.
    expect(scoreOf('el', 'xxelxx')).toBeGreaterThan(scoreOf('el', 'xxxelx'));
  });
});

interface Command {
  readonly id: number;
  readonly label: string;
}

const command = (id: number, label: string): Command => ({ id, label });

describe('fuzzyRank', () => {
  it('returns matches best first', () => {
    const items = [
      command(0, 'first'),
      command(1, 'schemaTree'),
      command(2, 'select'),
      command(3, 'unrelated'),
    ];
    const ranked = fuzzyRank('st', items, (item) => item.label);
    expect(ranked.map((entry) => entry.item.id)).toEqual([1, 2, 0]);
    const scores = ranked.map((entry) => entry.match.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('preserves input order for items that score identically', () => {
    const items = [
      command(0, 'select'),
      command(1, 'select'),
      command(2, 'select'),
      command(3, 'select'),
      command(4, 'select'),
    ];
    const ranked = fuzzyRank('sel', items, (item) => item.label);
    // Without this the ordering assertion below would prove nothing.
    expect(new Set(ranked.map((entry) => entry.match.score)).size).toBe(1);
    expect(ranked.map((entry) => entry.item.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('omits items that do not match', () => {
    const items = [command(0, 'select'), command(1, 'insert'), command(2, 'drop table')];
    const ranked = fuzzyRank('sel', items, (item) => item.label);
    expect(ranked.map((entry) => entry.item.id)).toEqual([0]);
  });

  it('returns every item in input order for an empty query', () => {
    const items = [command(0, 'zzz'), command(1, 'select'), command(2, 'aaa')];
    for (const query of ['', ' ', '\t\n']) {
      const ranked = fuzzyRank(query, items, (item) => item.label);
      expect(
        ranked.map((entry) => entry.item.id),
        JSON.stringify(query),
      ).toEqual([0, 1, 2]);
      for (const entry of ranked) {
        expect(entry.match.score).toBe(0);
        expect(entry.match.matchedIndexes).toEqual([]);
      }
    }
  });

  it('returns an empty list for an empty item list', () => {
    expect(fuzzyRank('sel', [], (item: Command) => item.label)).toEqual([]);
    expect(fuzzyRank('', [], (item: Command) => item.label)).toEqual([]);
  });

  it('calls textOf exactly once per item', () => {
    const items = [command(0, 'select'), command(1, 'insert'), command(2, 'schemaTree')];
    const textOf = vi.fn((item: Command) => item.label);
    const ranked = fuzzyRank('sel', items, textOf);
    expect(ranked).toHaveLength(1);
    expect(textOf).toHaveBeenCalledTimes(items.length);

    const emptyTextOf = vi.fn((item: Command) => item.label);
    expect(fuzzyRank('', items, emptyTextOf)).toHaveLength(items.length);
    expect(emptyTextOf).toHaveBeenCalledTimes(items.length);
  });

  it('does not mutate the input array', () => {
    const items = [command(2, 'zzz'), command(0, 'select'), command(1, 'aaa')];
    const before = JSON.stringify(items);
    // Frozen, so an in-place sort would throw instead of silently corrupting.
    const ranked = fuzzyRank('sel', Object.freeze([...items]), (item) => item.label);
    expect(ranked).toHaveLength(1);
    expect(JSON.stringify(items)).toBe(before);
    expect(items.map((item) => item.id)).toEqual([2, 0, 1]);
  });

  it('returns the caller’s own item references', () => {
    const items = [command(0, 'aaa'), command(1, 'select')];
    const ranked = fuzzyRank('sel', items, (item) => item.label);
    expect(ranked[0]!.item).toBe(items[1]);
  });

  it('ranks 5,000 items without a pathological blow-up', () => {
    const items = Array.from({ length: 5000 }, (_, index) =>
      command(index, `command_${index}_select_from_users_where_id = ${index}`),
    );
    const started = performance.now();
    const ranked = fuzzyRank('select from users', items, (item) => item.label);
    const elapsed = performance.now() - started;
    expect(ranked).toHaveLength(items.length);
    expect(elapsed).toBeLessThan(2000);
  });
});
