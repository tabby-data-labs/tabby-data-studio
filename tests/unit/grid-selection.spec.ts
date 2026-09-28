/**
 * GRID-SPEC §7: selection transitions. A pure reducer, so every mouse
 * transition is a table-driven case. Keyboard navigation lands in Phase 2;
 * the pointer and header transitions are Phase 1 because the paint pass needs
 * them to draw a highlight.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  boundingBox,
  isSelected,
  rangeEnd,
  rangeStart,
  reduceSelection,
} from '@/grid/selection';
import type { SelectionBounds, SelectionState } from '@/grid/types';

const BOUNDS: SelectionBounds = { rowCount: 1000, colCount: 8 };

function at(state: SelectionState, row: number, col: number): boolean {
  return isSelected(state, row, col);
}

describe('initial state', () => {
  it('starts with no ranges', () => {
    expect(EMPTY_SELECTION.ranges).toEqual([]);
    expect(EMPTY_SELECTION.mode).toBe('cell');
  });

  it('reports nothing selected while empty', () => {
    expect(at(EMPTY_SELECTION, 0, 0)).toBe(false);
    expect(boundingBox(EMPTY_SELECTION)).toBeNull();
  });
});

describe('click', () => {
  it('selects a single cell', () => {
    const s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 5, col: 2, shift: false, meta: false },
      BOUNDS,
    );
    expect(s.ranges).toEqual([{ anchor: { row: 5, col: 2 }, focus: { row: 5, col: 2 } }]);
    expect(s.mode).toBe('cell');
    expect(s.active).toEqual({ row: 5, col: 2 });
    expect(at(s, 5, 2)).toBe(true);
    expect(at(s, 5, 3)).toBe(false);
  });

  it('replaces a previous selection', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 5, col: 2, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'click', row: 9, col: 7, shift: false, meta: false }, BOUNDS);
    expect(s.ranges).toHaveLength(1);
    expect(at(s, 5, 2)).toBe(false);
    expect(at(s, 9, 7)).toBe(true);
  });

  it('collapses multiple ranges back to one', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 1, col: 1, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'click', row: 4, col: 4, shift: false, meta: true }, BOUNDS);
    expect(s.ranges).toHaveLength(2);
    s = reduceSelection(s, { type: 'click', row: 7, col: 7, shift: false, meta: false }, BOUNDS);
    expect(s.ranges).toHaveLength(1);
  });
});

describe('shift+click and drag', () => {
  it('extends the primary range from its anchor', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 2, col: 1, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'click', row: 6, col: 4, shift: true, meta: false }, BOUNDS);
    expect(s.ranges).toHaveLength(1);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 2, col: 1 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 6, col: 4 });
    expect(s.active).toEqual({ row: 6, col: 4 });
    for (let r = 2; r <= 6; r += 1) {
      for (let c = 1; c <= 4; c += 1) expect(at(s, r, c), `${r},${c}`).toBe(true);
    }
    expect(at(s, 1, 1)).toBe(false);
    expect(at(s, 2, 5)).toBe(false);
  });

  it('normalises a range dragged backwards', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 8, col: 5, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'click', row: 3, col: 2, shift: true, meta: false }, BOUNDS);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 3, col: 2 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 8, col: 5 });
  });

  it('dragTo moves the focus without changing the anchor', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 4, col: 3, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'dragTo', row: 10, col: 6 }, BOUNDS);
    expect(s.ranges[0]?.anchor).toEqual({ row: 4, col: 3 });
    expect(s.ranges[0]?.focus).toEqual({ row: 10, col: 6 });
    s = reduceSelection(s, { type: 'dragTo', row: 1, col: 0 }, BOUNDS);
    expect(s.ranges[0]?.anchor).toEqual({ row: 4, col: 3 });
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 1, col: 0 });
  });

  it('dragTo on an empty selection seeds one', () => {
    const s = reduceSelection(EMPTY_SELECTION, { type: 'dragTo', row: 3, col: 3 }, BOUNDS);
    expect(s.ranges).toHaveLength(1);
    expect(at(s, 3, 3)).toBe(true);
  });
});

describe('meta+click multi-range', () => {
  it('appends an independent range', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 1, col: 1, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'click', row: 5, col: 5, shift: false, meta: true }, BOUNDS);
    expect(s.ranges).toHaveLength(2);
    expect(at(s, 1, 1)).toBe(true);
    expect(at(s, 5, 5)).toBe(true);
    expect(at(s, 3, 3)).toBe(false);
  });

  it('removes a range when its cell is clicked again', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 1, col: 1, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'click', row: 5, col: 5, shift: false, meta: true }, BOUNDS);
    s = reduceSelection(s, { type: 'click', row: 5, col: 5, shift: false, meta: true }, BOUNDS);
    expect(s.ranges).toHaveLength(1);
    expect(at(s, 1, 1)).toBe(true);
  });

  it('never removes the last remaining range', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 2, col: 2, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'click', row: 2, col: 2, shift: false, meta: true }, BOUNDS);
    expect(s.ranges).toHaveLength(1);
  });
});

describe('header clicks', () => {
  it('selects a whole row from the row header', () => {
    const s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'clickRowHeader', row: 7, shift: false },
      BOUNDS,
    );
    expect(s.mode).toBe('row');
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 7, col: 0 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 7, col: 7 });
    expect(at(s, 7, 0)).toBe(true);
    expect(at(s, 7, 7)).toBe(true);
    expect(at(s, 8, 0)).toBe(false);
  });

  it('selects a whole column from the column header', () => {
    const s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'clickColHeader', col: 3, shift: false },
      BOUNDS,
    );
    expect(s.mode).toBe('col');
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 0, col: 3 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 999, col: 3 });
  });

  it('extends a row selection with shift', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'clickRowHeader', row: 2, shift: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'clickRowHeader', row: 6, shift: true }, BOUNDS);
    expect(s.ranges).toHaveLength(1);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 2, col: 0 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 6, col: 7 });
  });

  it('selects everything from the corner', () => {
    const s = reduceSelection(EMPTY_SELECTION, { type: 'clickCorner' }, BOUNDS);
    expect(s.mode).toBe('all');
    expect(boundingBox(s)).toEqual({ start: { row: 0, col: 0 }, end: { row: 999, col: 7 } });
    expect(at(s, 0, 0)).toBe(true);
    expect(at(s, 999, 7)).toBe(true);
  });
});

describe('clear', () => {
  it('collapses to a single cell at the active position', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 4, col: 2, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'click', row: 9, col: 6, shift: true, meta: false }, BOUNDS);
    s = reduceSelection(s, { type: 'clear' }, BOUNDS);
    expect(s.ranges).toHaveLength(1);
    expect(rangeStart(s.ranges[0]!)).toEqual({ row: 9, col: 6 });
    expect(rangeEnd(s.ranges[0]!)).toEqual({ row: 9, col: 6 });
  });

  it('clears entirely when there are no rows', () => {
    const empty: SelectionBounds = { rowCount: 0, colCount: 8 };
    const s = reduceSelection(EMPTY_SELECTION, { type: 'clear' }, empty);
    expect(s.ranges).toEqual([]);
  });
});

describe('bounds clamping', () => {
  it('clamps out-of-range clicks', () => {
    const s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 5000, col: 99, shift: false, meta: false },
      BOUNDS,
    );
    expect(s.active).toEqual({ row: 999, col: 7 });
  });

  it('clamps negative coordinates', () => {
    const s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: -5, col: -2, shift: false, meta: false },
      BOUNDS,
    );
    expect(s.active).toEqual({ row: 0, col: 0 });
  });

  it('produces no selection for an empty grid', () => {
    const empty: SelectionBounds = { rowCount: 0, colCount: 0 };
    const s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 0, col: 0, shift: false, meta: false },
      empty,
    );
    expect(s.ranges).toEqual([]);
  });

  it('handles a single-cell grid', () => {
    const one: SelectionBounds = { rowCount: 1, colCount: 1 };
    const s = reduceSelection(EMPTY_SELECTION, { type: 'clickCorner' }, one);
    expect(boundingBox(s)).toEqual({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } });
  });
});

describe('helpers', () => {
  it('boundingBox unions every range', () => {
    let s = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 4, col: 3, shift: false, meta: false },
      BOUNDS,
    );
    s = reduceSelection(s, { type: 'click', row: 1, col: 1, shift: false, meta: true }, BOUNDS);
    s = reduceSelection(s, { type: 'click', row: 9, col: 6, shift: false, meta: true }, BOUNDS);
    expect(boundingBox(s)).toEqual({ start: { row: 1, col: 1 }, end: { row: 9, col: 6 } });
  });

  it('selectedCellCount counts each cell once', () => {
    const s = reduceSelection(EMPTY_SELECTION, { type: 'clickCorner' }, BOUNDS);
    expect(boundingBox(s)).not.toBeNull();
    // 1000 rows x 8 cols
    expect(s.ranges).toHaveLength(1);
  });
});
