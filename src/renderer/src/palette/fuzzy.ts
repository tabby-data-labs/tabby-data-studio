/**
 * The command palette's fuzzy matcher (PLAN Phase 8).
 *
 * Three constraints shape this module, and none of them are visible in the code:
 *
 * **The query is untrusted keystroke-by-keystroke input**, so no `RegExp` is ever
 * built from it. `(((((((((a` is a non-match found in one linear pass, not a
 * catastrophic backtrace.
 *
 * **Indices are UTF-16 offsets into the original `text`, and matching walks code
 * points.** The two have to differ: highlighting uses `text.slice(i, i + 1)` and
 * DOM ranges, which count UTF-16 units, while an emoji or an accented character
 * has to match as one character. Characters are compared as lowercased code
 * points *without* Unicode normalisation — NFC can change a string's length,
 * which would silently invalidate every offset — so `é` (U+00E9) does not match
 * `e` + U+0301.
 *
 * **The alignment reported is the best one the text offers, not the leftmost.**
 * A greedy scan reports `ab` in `aabb` as `[0, 2]`, breaking a run the text
 * plainly contains, and the palette would both underline the wrong letters and
 * rank the item too low. Choosing the alignment is a small DP over
 * (query character, text code point) that carries whether the previous match was
 * contiguous: O(query × text) per item, single pass, no search on the way back.
 */

export interface FuzzyMatch {
  /** Higher is better. Always >= 0 for a match. */
  readonly score: number;
  /**
   * Indices into `text` of the characters that matched, strictly ascending.
   *
   * UTF-16 offsets, not code point ordinals: an astral character is reported at
   * the offset of its high surrogate, so `text.slice(index, index + 2)` is that
   * character.
   */
  readonly matchedIndexes: readonly number[];
}

export interface Ranked<T> {
  readonly item: T;
  readonly match: FuzzyMatch;
}

/**
 * A word separator. Any whitespace counts, not just U+0020 — a tab in a label
 * separates words exactly as a space does.
 */
const WHITESPACE = /\s/u;
const SEPARATORS: ReadonlySet<string> = new Set(['_', '.', '-', '/']);

/**
 * Scoring weights. The one relation that matters is
 * `BOUNDARY < CONTIGUOUS < 2 * BOUNDARY`, and both scoring rules fall out of it:
 *
 *  - a contiguous run beats the same characters scattered *even when every
 *    scattered character sits on a word boundary*, because a run of `m` earns
 *    `m - 1` contiguity bonuses against `m` boundary bonuses, and the difference
 *    is `(m - 1) * (CONTIGUOUS - BOUNDARY) > 0`;
 *  - two word-boundary hits still beat one mid-word contiguity, which is what
 *    makes `st` prefer `schemaTree` / `schema_tree` over `first`.
 *
 * `BASE` is the floor: every matched character earns it, so a score is at least
 * the number of matched characters before penalties.
 */
const BASE = 1;
const CONTIGUOUS = 9;
const BOUNDARY = 6;
const START = 4;
const MAX_PER_CHAR = BASE + CONTIGUOUS + BOUNDARY;

/**
 * Penalties for matching late in a long label. Both are capped so that their sum
 * stays strictly below one character's `BASE`: a match can then never be pushed
 * to zero, and two matches can never be flattened into a tie by clamping, so the
 * ordering above is decided by match quality alone.
 */
const POSITION_WEIGHT = 0.02;
const POSITION_CAP = 20;
const LENGTH_WEIGHT = 0.002;
const LENGTH_CAP = 250;

const NONE = Number.NEGATIVE_INFINITY;

/**
 * Returns null when `query` is not a subsequence of `text`. Never throws.
 *
 * Whitespace in the query is ignorable: it is neither matched nor counted, so
 * `sel ect` finds `select` and a trailing space — typed a beat before the palette
 * closed — does not lose the match. An empty or whitespace-only query matches
 * every text at score 0 with no indexes, which is what lets the palette show its
 * whole command list before the user types.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const wanted: string[] = [];
  for (const character of query) {
    if (!WHITESPACE.test(character)) wanted.push(character.toLowerCase());
  }
  if (wanted.length === 0) return { score: 0, matchedIndexes: [] };

  const lowered: string[] = [];
  const offsets: number[] = [];
  const wordStarts: boolean[] = [];
  let offset = 0;
  let previous: string | undefined;
  for (const character of text) {
    lowered.push(character.toLowerCase());
    offsets.push(offset);
    wordStarts.push(previous === undefined || isWordStart(previous, character));
    offset += character.length;
    previous = character;
  }

  // Cheap linear rejection first: in a palette most items do not match, and
  // those should cost one pass over the text rather than a whole DP.
  let found = 0;
  for (let index = 0; index < lowered.length && found < wanted.length; index += 1) {
    if (lowered[index] === wanted[found]) found += 1;
  }
  if (found < wanted.length) return null;

  const alignment = bestAlignment(wanted, lowered, wordStarts, offsets);
  if (alignment === null) return null;

  // Exactness must dominate for the same query, at any query length. Every
  // per-character bonus is bounded by MAX_PER_CHAR and START is awarded once, so
  // no non-exact text can score above MAX_PER_CHAR * m + START however long it is
  // — penalties only subtract. Awarding more than that ceiling makes `query ===
  // text` unconditionally first instead of first up to some length; the `+ 2`
  // covers the capped penalties, the only slack the argument needs.
  //
  // Case is not part of identity: matching is case-insensitive, so `SELECT`
  // against `select` scores exactly as `select` against `select` does.
  const exact = query.toLowerCase() === text.toLowerCase();
  const ceiling = MAX_PER_CHAR * wanted.length + START + 2;
  const lengthPenalty = LENGTH_WEIGHT * Math.min(text.length, LENGTH_CAP);

  return {
    score: alignment.score + (exact ? ceiling : 0) - lengthPenalty,
    matchedIndexes: alignment.ordinals.map((ordinal) => offsets[ordinal]!),
  };
}

/**
 * Scores every item against `query` and returns the matches, best first.
 * Items that do not match are omitted. `textOf` is called once per item.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  textOf: (item: T) => string,
): readonly Ranked<T>[] {
  const scored: { item: T; match: FuzzyMatch; position: number }[] = [];
  let position = 0;
  for (const item of items) {
    const match = fuzzyMatch(query, textOf(item));
    if (match !== null) scored.push({ item, match, position });
    position += 1;
  }
  // `Array.prototype.sort` has been stable since ES2019, but a palette list that
  // jittered as the user typed would be unusable, so stability is spelled out
  // here rather than inherited from the engine.
  scored.sort((a, b) => b.match.score - a.match.score || a.position - b.position);
  return scored.map(({ item, match }) => ({ item, match }));
}

interface Alignment {
  readonly score: number;
  /** Code point ordinals into the text, ascending. */
  readonly ordinals: readonly number[];
}

/**
 * The highest-scoring way to place `wanted` in the text.
 *
 * Two value arrays per (query character, text code point): the best score ending
 * there with the previous match *contiguous*, and the best ending there with a
 * gap. Keeping them apart is what lets a longer run outscore the same characters
 * broken up. A running maximum over the previous row supplies the gapped
 * transition in O(1), so the whole pass is O(query × text).
 *
 * The position penalty depends only on the first matched offset, so it is applied
 * in row 0 and the decomposition stays exact.
 */
function bestAlignment(
  wanted: readonly string[],
  lowered: readonly string[],
  wordStarts: readonly boolean[],
  offsets: readonly number[],
): Alignment | null {
  const rows = wanted.length;
  const columns = lowered.length;
  const cells = rows * columns;
  const contiguous = new Float64Array(cells).fill(NONE);
  const gapped = new Float64Array(cells).fill(NONE);
  const gappedFrom = new Int32Array(cells).fill(-1);

  for (let column = 0; column < columns; column += 1) {
    if (lowered[column] !== wanted[0]) continue;
    gapped[column] =
      BASE +
      (wordStarts[column] ? BOUNDARY : 0) +
      (column === 0 ? START : 0) -
      POSITION_WEIGHT * Math.min(offsets[column]!, POSITION_CAP);
  }

  for (let row = 1; row < rows; row += 1) {
    const target = wanted[row]!;
    const previousTarget = wanted[row - 1]!;
    const at = row * columns;
    const previous = at - columns;
    // Best previous-row value at a column strictly before `column - 1`, i.e. the
    // gapped transitions only; `column - 1` belongs to the contiguous case.
    let bestBefore = NONE;
    let bestBeforeAt = -1;
    for (let column = 0; column < columns; column += 1) {
      if (column >= 2) {
        const candidate = previous + column - 2;
        const value = Math.max(contiguous[candidate]!, gapped[candidate]!);
        // Strict `>` keeps the earliest argmax, so equal scores always resolve
        // the same way.
        if (value > bestBefore) {
          bestBefore = value;
          bestBeforeAt = column - 2;
        }
      }
      if (lowered[column] !== target) continue;
      const bonus = BASE + (wordStarts[column] ? BOUNDARY : 0);
      if (column >= 1 && lowered[column - 1] === previousTarget) {
        const adjacent = previous + column - 1;
        const value = Math.max(contiguous[adjacent]!, gapped[adjacent]!);
        if (value !== NONE) contiguous[at + column] = value + bonus + CONTIGUOUS;
      }
      if (bestBefore !== NONE) {
        gapped[at + column] = bestBefore + bonus;
        gappedFrom[at + column] = bestBeforeAt;
      }
    }
  }

  const last = (rows - 1) * columns;
  let best = NONE;
  let bestAt = -1;
  let viaContiguous = false;
  for (let column = 0; column < columns; column += 1) {
    const run = contiguous[last + column]!;
    const gap = gapped[last + column]!;
    // On a tie prefer the contiguous reading: same score, tighter highlight.
    const byRun = run !== NONE && run >= gap;
    const value = byRun ? run : gap;
    if (value > best) {
      best = value;
      bestAt = column;
      viaContiguous = byRun;
    }
  }
  if (bestAt < 0) return null;

  const ordinals: number[] = new Array<number>(rows);
  let row = rows - 1;
  let column = bestAt;
  let byRun = viaContiguous;
  for (;;) {
    ordinals[row] = column;
    if (row === 0) break;
    column = byRun ? column - 1 : gappedFrom[row * columns + column]!;
    row -= 1;
    const at = row * columns + column;
    const run = contiguous[at]!;
    const gap = gapped[at]!;
    byRun = run !== NONE && run >= gap;
  }
  return { score: best, ordinals };
}

/** A character is a word start after a separator, or on a lower→upper transition. */
function isWordStart(previous: string, current: string): boolean {
  if (WHITESPACE.test(previous) || SEPARATORS.has(previous)) return true;
  return isCasedLower(previous) && isCasedUpper(current);
}

/**
 * Cased comparisons rather than `/[a-z]/`, so non-ASCII letters count: `É` is
 * upper and `é` is lower. Digits and marks are neither.
 */
function isCasedLower(character: string): boolean {
  return character !== character.toUpperCase() && character === character.toLowerCase();
}

function isCasedUpper(character: string): boolean {
  return character !== character.toLowerCase() && character === character.toUpperCase();
}
