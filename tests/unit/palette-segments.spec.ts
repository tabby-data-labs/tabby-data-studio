/**
 * Splitting a label into matched and unmatched runs, for the palette's highlight.
 *
 * Tier 1, so test-first. The reason this exists as a module rather than inline
 * markup: the indexes come from `fuzzyMatch` and are UTF-16 offsets that can point
 * at the high surrogate of an astral character. Slicing them naively would put a
 * lone surrogate in the DOM, which renders as a replacement box — a visible defect
 * caused entirely by a highlight.
 */
import { describe, expect, it } from 'vitest';
import { highlightSegments, type Segment } from '../../src/renderer/src/palette/segments';

/** Joins the segments back, which must always reproduce the input exactly. */
function joined(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.text).join('');
}

describe('highlightSegments', () => {
  it('returns one unmatched segment for no indexes', () => {
    expect(highlightSegments('select', [])).toEqual([{ text: 'select', matched: false }]);
  });

  it('returns one matched segment when every character matched', () => {
    expect(highlightSegments('abc', [0, 1, 2])).toEqual([{ text: 'abc', matched: true }]);
  });

  it('splits around a single match', () => {
    expect(highlightSegments('abcdef', [2])).toEqual([
      { text: 'ab', matched: false },
      { text: 'c', matched: true },
      { text: 'def', matched: false },
    ]);
  });

  it('merges adjacent indexes into one run', () => {
    expect(highlightSegments('abcdef', [1, 2, 3])).toEqual([
      { text: 'a', matched: false },
      { text: 'bcd', matched: true },
      { text: 'ef', matched: false },
    ]);
  });

  it('emits no empty segment for a match at either end', () => {
    expect(highlightSegments('abc', [0])).toEqual([
      { text: 'a', matched: true },
      { text: 'bc', matched: false },
    ]);
    expect(highlightSegments('abc', [2])).toEqual([
      { text: 'ab', matched: false },
      { text: 'c', matched: true },
    ]);
  });

  it('returns nothing for an empty label', () => {
    expect(highlightSegments('', [])).toEqual([]);
    expect(highlightSegments('', [0])).toEqual([]);
  });

  it('ignores indexes outside the label rather than throwing', () => {
    // A stale match against a list that has since changed is reachable: the palette
    // re-ranks on every keystroke and the indexes belong to the previous render.
    expect(highlightSegments('ab', [5, 99, -1])).toEqual([{ text: 'ab', matched: false }]);
  });

  it('ignores a duplicate index', () => {
    expect(joined(highlightSegments('abc', [1, 1, 2]))).toBe('abc');
    expect(highlightSegments('abc', [1, 1, 2])).toEqual([
      { text: 'a', matched: false },
      { text: 'bc', matched: true },
    ]);
  });

  it('accepts unsorted indexes', () => {
    expect(highlightSegments('abcdef', [4, 1])).toEqual([
      { text: 'a', matched: false },
      { text: 'b', matched: true },
      { text: 'cd', matched: false },
      { text: 'e', matched: true },
      { text: 'f', matched: false },
    ]);
  });

  it('keeps an astral character whole, highlighting it as one segment', () => {
    // `fuzzyMatch` reports the offset of the high surrogate. Slicing at +1 would
    // split the pair and render two replacement boxes.
    const segments = highlightSegments('a😀b', [1]);
    expect(joined(segments)).toBe('a😀b');
    expect(segments).toEqual([
      { text: 'a', matched: false },
      { text: '😀', matched: true },
      { text: 'b', matched: false },
    ]);
  });

  it('reproduces the label exactly for every segment layout', () => {
    const label = 'Export result as CSV…';
    for (let mask = 0; mask < 1 << 8; mask += 1) {
      const indexes = [...label.slice(0, 8)]
        .map((_char, index) => index)
        .filter((index) => (mask & (1 << index)) !== 0);
      expect(joined(highlightSegments(label, indexes))).toBe(label);
    }
  });
});
