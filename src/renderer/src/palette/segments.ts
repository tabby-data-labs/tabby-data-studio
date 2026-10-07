/**
 * Splitting a label into matched and unmatched runs (PLAN Phase 8).
 *
 * The indexes come from `fuzzyMatch` and are UTF-16 offsets that may point at the
 * high surrogate of an astral character. Walking by code point rather than by index
 * increment is what keeps a pair in one segment; slicing at `index + 1` instead
 * would put a lone surrogate in the DOM and render a replacement box, a visible
 * defect caused entirely by a highlight.
 */

export interface Segment {
  readonly text: string;
  readonly matched: boolean;
}

/**
 * Returns the runs of `text`, alternating matched and unmatched.
 *
 * Indexes that are fractional, negative, out of range or duplicated are ignored
 * rather than rejected: the palette re-ranks on every keystroke, so a highlight
 * computed against the previous list is reachable, and dropping a stale index is
 * better than throwing inside a render.
 *
 * The segments always join back to `text` exactly.
 */
export function highlightSegments(
  text: string,
  matchedIndexes: readonly number[],
): readonly Segment[] {
  if (text === '') return [];

  const wanted = new Set<number>();
  for (const index of matchedIndexes) {
    if (Number.isInteger(index) && index >= 0 && index < text.length) wanted.add(index);
  }

  const segments: Segment[] = [];
  let start = 0;
  let matched = wanted.has(0);

  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    const isMatched = wanted.has(index);
    if (isMatched !== matched) {
      segments.push({ text: text.slice(start, index), matched });
      start = index;
      matched = isMatched;
    }
    index += width;
  }

  segments.push({ text: text.slice(start), matched });
  return segments;
}
