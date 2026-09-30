/**
 * GRID-SPEC §7 keyboard transitions — Phase 2.
 *
 * Expectations are derived from Excel's documented behaviour and from the spec
 * table, not from the implementation. The reducer stays pure: it reports where
 * the active cell moved to, and the grid is responsible for scrolling it into
 * view. That split is what keeps this file free of DOM and canvas concerns.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, rangeEnd, rangeStart, reduceSelection } from '@/grid/selection';
import type { SelectionBounds, SelectionState } from '@/grid/types';

const B: SelectionBounds = { rowCount: 100, colCount: 10, pageRows: 25, pageCols: 5 };

/** Selection with a single active cell at (row, col). */
function at(row: number, col: number): SelectionState {
  return reduceSelection(
    EMPTY_SELECTION,
    { type: 'click', row, col, shift: false, meta: false },
    B,
  );
}

function move(
  state: SelectionState,
  direction: 'up' | 'down' | 'left' | 'right',
  mods: { shift?: boolean; meta?: boolean } = {},
  bounds: SelectionBounds = B,
): SelectionState {
  return reduceSelection(
    state,
    { type: 'move', direction, shift: mods.shift ?? false, meta: mods.meta ?? false },
    bounds,
  );
}

describe('arrow keys', () => {
  it.each([
    ['up', { row: 9, col: 4 }],
    ['down', { row: 11, col: 4 }],
    ['left', { row: 10, col: 3 }],
    ['right', { row: 10, col: 5 }],
  ] as const)('moves one cell %s', (direction, expected) => {
    const next = move(at(10, 4), direction);
    expect(next.active).toEqual(expected);
  });

  it('collapses a multi-cell selection to the new single cell', () => {
    let s = at(10, 4);
    s = reduceSelection(s, { type: 'click', row: 20, col: 8, shift: true, meta: false }, B);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 10, col: 4 });
    // The shift-click made (20,8) the active cell, so arrows move from there.
    expect(s.active).toEqual({ row: 20, col: 8 });

    s = move(s, 'right');
    expect(s.ranges).toHaveLength(1);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 20, col: 9 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 20, col: 9 });
  });

  it('clamps at every edge instead of wrapping', () => {
    expect(move(at(0, 0), 'up').active).toEqual({ row: 0, col: 0 });
    expect(move(at(0, 0), 'left').active).toEqual({ row: 0, col: 0 });
    expect(move(at(99, 9), 'down').active).toEqual({ row: 99, col: 9 });
    expect(move(at(99, 9), 'right').active).toEqual({ row: 99, col: 9 });
  });

  it('does not wrap from the last column to the next row', () => {
    // Tab wraps; arrows deliberately do not, matching Excel.
    expect(move(at(5, 9), 'right').active).toEqual({ row: 5, col: 9 });
  });
});

describe('shift+arrow extends', () => {
  it('grows the primary range and keeps the anchor put', () => {
    let s = at(10, 4);
    s = move(s, 'down', { shift: true });
    s = move(s, 'down', { shift: true });
    s = move(s, 'right', { shift: true });

    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 10, col: 4 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 12, col: 5 });
    expect(s.active).toEqual({ row: 12, col: 5 });
    expect(s.ranges).toHaveLength(1);
  });

  it('shrinks back when reversing direction', () => {
    let s = at(10, 4);
    s = move(s, 'down', { shift: true });
    s = move(s, 'down', { shift: true });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 12, col: 4 });

    s = move(s, 'up', { shift: true });
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 10, col: 4 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 11, col: 4 });

    // Walking back past the anchor flips the normalised corners:
    // active 11 -> 10 -> 9 while the anchor stays at 10.
    s = move(s, 'up', { shift: true });
    s = move(s, 'up', { shift: true });
    expect(s.active).toEqual({ row: 9, col: 4 });
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 9, col: 4 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 10, col: 4 });
  });

  it('extends only the primary range, leaving other ranges untouched', () => {
    let s = at(10, 4);
    s = reduceSelection(s, { type: 'click', row: 50, col: 5, shift: false, meta: true }, B);
    expect(s.ranges).toHaveLength(2);

    s = move(s, 'right', { shift: true });
    expect(s.ranges).toHaveLength(2);
    // The range containing the active cell (50,5) is the one that grew.
    const grown = s.ranges.find((r) => rangeStart(r).row === 50 && rangeEnd(r).col === 6);
    expect(grown).toBeDefined();
    expect(s.ranges[0]).toEqual({ anchor: { row: 10, col: 4 }, focus: { row: 10, col: 4 } });
  });
});

describe('cmd+arrow jumps to the edge of contiguous data', () => {
  /** Blank at rows 20-24 and column 7, non-blank elsewhere. */
  const blanks: SelectionBounds = {
    ...B,
    isBlank: (row, col) => (row >= 20 && row <= 24) || col === 7,
  };

  it('stops at the last non-blank cell before a gap', () => {
    expect(move(at(10, 4), 'down', { meta: true }, blanks).active).toEqual({ row: 19, col: 4 });
  });

  it('stops at the extent edge when data runs all the way', () => {
    expect(move(at(30, 4), 'down', { meta: true }, blanks).active).toEqual({ row: 99, col: 4 });
  });

  it('jumps across a gap when starting from a blank cell', () => {
    expect(move(at(22, 4), 'down', { meta: true }, blanks).active).toEqual({ row: 25, col: 4 });
  });

  it('goes to the extent edge when everything ahead is blank', () => {
    const allBlank: SelectionBounds = { ...B, isBlank: () => true };
    expect(move(at(10, 4), 'down', { meta: true }, allBlank).active).toEqual({ row: 99, col: 4 });
  });

  it('treats a starting cell inside a gap as blank in both directions', () => {
    expect(move(at(22, 4), 'up', { meta: true }, blanks).active).toEqual({ row: 19, col: 4 });
  });

  it('falls back to the extent edge when no blank predicate is supplied', () => {
    expect(move(at(10, 4), 'down', { meta: true }).active).toEqual({ row: 99, col: 4 });
    expect(move(at(10, 4), 'up', { meta: true }).active).toEqual({ row: 0, col: 4 });
  });

  it('combines with shift to select through to the edge', () => {
    const s = move(at(10, 4), 'down', { meta: true, shift: true }, blanks);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 10, col: 4 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 19, col: 4 });
  });

  it('stops at the column gap', () => {
    expect(move(at(10, 4), 'right', { meta: true }, blanks).active).toEqual({ row: 10, col: 6 });
  });
});

describe('page navigation', () => {
  it('moves by the viewport height', () => {
    const s = reduceSelection(at(10, 4), { type: 'movePage', direction: 'down', shift: false }, B);
    expect(s.active).toEqual({ row: 35, col: 4 });
  });

  it('moves up by the viewport height', () => {
    const s = reduceSelection(at(40, 4), { type: 'movePage', direction: 'up', shift: false }, B);
    expect(s.active).toEqual({ row: 15, col: 4 });
  });

  it('clamps at the last row rather than overshooting', () => {
    const s = reduceSelection(at(90, 4), { type: 'movePage', direction: 'down', shift: false }, B);
    expect(s.active).toEqual({ row: 99, col: 4 });
  });

  it('extends with shift', () => {
    const s = reduceSelection(at(10, 4), { type: 'movePage', direction: 'down', shift: true }, B);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 10, col: 4 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 35, col: 4 });
  });

  it('defaults the page size when the viewport is not supplied', () => {
    const s = reduceSelection(
      at(10, 4),
      { type: 'movePage', direction: 'down', shift: false },
      { rowCount: 100, colCount: 10 },
    );
    expect(s.active.row).toBeGreaterThan(10);
  });
});

describe('Home / End / cmd+Home / cmd+End', () => {
  it.each([
    ['firstCol', { row: 10, col: 0 }],
    ['lastCol', { row: 10, col: 9 }],
    ['firstRow', { row: 0, col: 4 }],
    ['lastRow', { row: 99, col: 4 }],
    ['start', { row: 0, col: 0 }],
    ['end', { row: 99, col: 9 }],
  ] as const)('%s goes to the absolute extent', (edge, expected) => {
    const s = reduceSelection(at(10, 4), { type: 'moveToEdge', edge, shift: false }, B);
    expect(s.active).toEqual(expected);
  });

  it('extends to the edge with shift', () => {
    const s = reduceSelection(at(10, 4), { type: 'moveToEdge', edge: 'start', shift: true }, B);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 0, col: 0 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 10, col: 4 });
  });
});

describe('Tab and Enter', () => {
  it('Tab moves right', () => {
    const s = reduceSelection(at(10, 4), { type: 'moveTab', reverse: false }, B);
    expect(s.active).toEqual({ row: 10, col: 5 });
  });

  it('Tab wraps from the last column to the first column of the next row', () => {
    const s = reduceSelection(at(10, 9), { type: 'moveTab', reverse: false }, B);
    expect(s.active).toEqual({ row: 11, col: 0 });
  });

  it('Shift+Tab wraps backwards from the first column', () => {
    const s = reduceSelection(at(10, 0), { type: 'moveTab', reverse: true }, B);
    expect(s.active).toEqual({ row: 9, col: 9 });
  });

  it('Tab stops at the very last cell instead of leaving the grid', () => {
    const s = reduceSelection(at(99, 9), { type: 'moveTab', reverse: false }, B);
    expect(s.active).toEqual({ row: 99, col: 9 });
  });

  it('Shift+Tab stops at the very first cell', () => {
    const s = reduceSelection(at(0, 0), { type: 'moveTab', reverse: true }, B);
    expect(s.active).toEqual({ row: 0, col: 0 });
  });

  it('Enter moves down and Shift+Enter moves up, without wrapping columns', () => {
    expect(reduceSelection(at(10, 4), { type: 'moveEnter', reverse: false }, B).active).toEqual({
      row: 11,
      col: 4,
    });
    expect(reduceSelection(at(10, 4), { type: 'moveEnter', reverse: true }, B).active).toEqual({
      row: 9,
      col: 4,
    });
  });

  it('Enter clamps at the last row', () => {
    const s = reduceSelection(at(99, 4), { type: 'moveEnter', reverse: false }, B);
    expect(s.active).toEqual({ row: 99, col: 4 });
  });
});

describe('Escape', () => {
  it('collapses to a single cell at the active position', () => {
    let s = at(10, 4);
    s = move(s, 'down', { shift: true });
    s = move(s, 'right', { shift: true });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 11, col: 5 });

    s = reduceSelection(s, { type: 'clear' }, B);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 11, col: 5 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 11, col: 5 });
  });
});

describe('degenerate grids', () => {
  it('ignores movement in an empty grid', () => {
    const empty: SelectionBounds = { rowCount: 0, colCount: 0 };
    expect(move(EMPTY_SELECTION, 'down', {}, empty)).toEqual(EMPTY_SELECTION);
    expect(reduceSelection(EMPTY_SELECTION, { type: 'moveTab', reverse: false }, empty)).toEqual(
      EMPTY_SELECTION,
    );
  });

  it('handles a single-cell grid', () => {
    const one: SelectionBounds = { rowCount: 1, colCount: 1 };
    const s = at2(one);
    expect(move(s, 'down', {}, one).active).toEqual({ row: 0, col: 0 });
    expect(move(s, 'right', {}, one).active).toEqual({ row: 0, col: 0 });
    expect(reduceSelection(s, { type: 'moveTab', reverse: false }, one).active).toEqual({
      row: 0,
      col: 0,
    });
  });

  it('handles a single column (Tab cannot advance)', () => {
    const single: SelectionBounds = { rowCount: 10, colCount: 1 };
    const s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 3, col: 0, shift: false, meta: false },
      single,
    );
    expect(reduceSelection(s, { type: 'moveTab', reverse: false }, single).active).toEqual({
      row: 4,
      col: 0,
    });
  });

  it('handles a single row (Enter cannot advance)', () => {
    const single: SelectionBounds = { rowCount: 1, colCount: 10 };
    const s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 0, col: 3, shift: false, meta: false },
      single,
    );
    expect(reduceSelection(s, { type: 'moveEnter', reverse: false }, single).active).toEqual({
      row: 0,
      col: 3,
    });
  });

  it('seeds a selection when navigating from an empty state', () => {
    const s = move(EMPTY_SELECTION, 'down');
    expect(s.ranges).toHaveLength(1);
    expect(s.active).toEqual({ row: 1, col: 0 });
  });
});

function at2(bounds: SelectionBounds): SelectionState {
  return reduceSelection(
    EMPTY_SELECTION,
    { type: 'click', row: 0, col: 0, shift: false, meta: false },
    bounds,
  );
}

describe('mode preservation', () => {
  it('switches back to cell mode after a whole-row selection', () => {
    let s = reduceSelection(EMPTY_SELECTION, { type: 'clickRowHeader', row: 5, shift: false }, B);
    expect(s.mode).toBe('row');
    s = move(s, 'right');
    expect(s.mode).toBe('cell');
    expect(s.ranges).toHaveLength(1);
  });

  it('moving within a row selection keeps the anchor semantics sane', () => {
    let s = reduceSelection(EMPTY_SELECTION, { type: 'clickRowHeader', row: 5, shift: false }, B);
    s = move(s, 'down', { shift: true });
    // The anchor was the whole row; extending down should not lose it.
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 5, col: 0 });
    expect(rangeEnd(s.ranges[0]!).row).toBeGreaterThanOrEqual(6);
  });
});
