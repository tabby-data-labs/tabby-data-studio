import type { CellRef, SelRange, SelectionBounds, SelectionEvent, SelectionState } from './types';

export const EMPTY_SELECTION: SelectionState = {
  ranges: [],
  mode: 'cell',
  active: { row: 0, col: 0 },
};

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Returns null when the grid has no cells at all. */
function clampCell(row: number, col: number, bounds: SelectionBounds): CellRef | null {
  if (bounds.rowCount <= 0 || bounds.colCount <= 0) return null;
  return {
    row: clamp(Math.floor(row), 0, bounds.rowCount - 1),
    col: clamp(Math.floor(col), 0, bounds.colCount - 1),
  };
}

/** Normalised (top-left) corner of a range, regardless of drag direction. */
export function rangeStart(range: SelRange): CellRef {
  return {
    row: Math.min(range.anchor.row, range.focus.row),
    col: Math.min(range.anchor.col, range.focus.col),
  };
}

/** Normalised (bottom-right) corner of a range. */
export function rangeEnd(range: SelRange): CellRef {
  return {
    row: Math.max(range.anchor.row, range.focus.row),
    col: Math.max(range.anchor.col, range.focus.col),
  };
}

export function isSelected(state: SelectionState, row: number, col: number): boolean {
  for (const range of state.ranges) {
    const start = rangeStart(range);
    const end = rangeEnd(range);
    if (row >= start.row && row <= end.row && col >= start.col && col <= end.col) return true;
  }
  return false;
}

export interface SelectionBox {
  readonly start: CellRef;
  readonly end: CellRef;
}

/** Union of every range — what copy/export serialises. Null when nothing is selected. */
export function boundingBox(state: SelectionState): SelectionBox | null {
  if (state.ranges.length === 0) return null;
  let startRow = Infinity;
  let startCol = Infinity;
  let endRow = -Infinity;
  let endCol = -Infinity;
  for (const range of state.ranges) {
    const start = rangeStart(range);
    const end = rangeEnd(range);
    if (start.row < startRow) startRow = start.row;
    if (start.col < startCol) startCol = start.col;
    if (end.row > endRow) endRow = end.row;
    if (end.col > endCol) endCol = end.col;
  }
  return { start: { row: startRow, col: startCol }, end: { row: endRow, col: endCol } };
}

export function selectedCellCount(state: SelectionState): number {
  let total = 0;
  for (const range of state.ranges) {
    const start = rangeStart(range);
    const end = rangeEnd(range);
    total += (end.row - start.row + 1) * (end.col - start.col + 1);
  }
  return total;
}

/**
 * The range a shift-click or drag extends. Prefers the one containing the
 * active cell so that extending after a meta-click edits the range the user is
 * looking at, not whichever happens to be first.
 */
function primaryIndex(state: SelectionState): number {
  if (state.ranges.length === 0) return -1;
  const index = state.ranges.findIndex((range) => {
    const start = rangeStart(range);
    const end = rangeEnd(range);
    const { row, col } = state.active;
    return row >= start.row && row <= end.row && col >= start.col && col <= end.col;
  });
  return index >= 0 ? index : 0;
}

function withPrimary(
  state: SelectionState,
  range: SelRange,
  mode: SelectionState['mode'],
  active: CellRef,
): SelectionState {
  const index = primaryIndex(state);
  const ranges = state.ranges.slice();
  if (index < 0) ranges.push(range);
  else ranges[index] = range;
  return { ranges, mode, active };
}

/**
 * Pure selection reducer (GRID-SPEC §7).
 *
 * Phase 1 covers the pointer and header transitions, which the paint pass needs
 * to draw a highlight. Keyboard navigation is Phase 2 and adds events here
 * without changing this signature.
 */
export function reduceSelection(
  state: SelectionState,
  event: SelectionEvent,
  bounds: SelectionBounds,
): SelectionState {
  switch (event.type) {
    case 'click': {
      const cell = clampCell(event.row, event.col, bounds);
      if (!cell) return EMPTY_SELECTION;
      const single: SelRange = { anchor: cell, focus: cell };

      if (event.meta) {
        const index = state.ranges.findIndex((range) => {
          const start = rangeStart(range);
          const end = rangeEnd(range);
          return (
            cell.row >= start.row &&
            cell.row <= end.row &&
            cell.col >= start.col &&
            cell.col <= end.col
          );
        });

        if (index >= 0) {
          // Deselecting the last range would leave nothing selected, which is
          // Esc's job — so a meta-click there is a no-op, not a duplicate.
          if (state.ranges.length === 1) return state;
          const ranges = state.ranges.filter((_, i) => i !== index);
          const fallback = ranges[ranges.length - 1];
          return { ranges, mode: state.mode, active: fallback ? rangeStart(fallback) : cell };
        }

        return { ranges: [...state.ranges, single], mode: 'cell', active: cell };
      }

      if (event.shift)
        return withPrimary(
          state,
          { anchor: state.ranges[primaryIndex(state)]?.anchor ?? cell, focus: cell },
          'cell',
          cell,
        );

      return { ranges: [single], mode: 'cell', active: cell };
    }

    case 'dragTo': {
      const cell = clampCell(event.row, event.col, bounds);
      if (!cell) return EMPTY_SELECTION;
      const anchor = state.ranges[primaryIndex(state)]?.anchor ?? cell;
      return withPrimary(state, { anchor, focus: cell }, 'cell', cell);
    }

    case 'clickRowHeader': {
      const cell = clampCell(event.row, 0, bounds);
      if (!cell) return EMPTY_SELECTION;
      const row = cell.row;
      const anchorRow = event.shift ? (state.ranges[primaryIndex(state)]?.anchor.row ?? row) : row;
      const range: SelRange = {
        anchor: { row: anchorRow, col: 0 },
        focus: { row, col: bounds.colCount - 1 },
      };
      return event.shift
        ? withPrimary(state, range, 'row', { row, col: 0 })
        : { ranges: [range], mode: 'row', active: { row, col: 0 } };
    }

    case 'clickColHeader': {
      const cell = clampCell(0, event.col, bounds);
      if (!cell) return EMPTY_SELECTION;
      const col = cell.col;
      const anchorCol = event.shift ? (state.ranges[primaryIndex(state)]?.anchor.col ?? col) : col;
      const range: SelRange = {
        anchor: { row: 0, col: anchorCol },
        focus: { row: bounds.rowCount - 1, col },
      };
      return event.shift
        ? withPrimary(state, range, 'col', { row: 0, col })
        : { ranges: [range], mode: 'col', active: { row: 0, col } };
    }

    case 'clickCorner': {
      if (bounds.rowCount <= 0 || bounds.colCount <= 0) return EMPTY_SELECTION;
      return {
        ranges: [
          {
            anchor: { row: 0, col: 0 },
            focus: { row: bounds.rowCount - 1, col: bounds.colCount - 1 },
          },
        ],
        mode: 'all',
        active: { row: 0, col: 0 },
      };
    }

    case 'clear': {
      const cell = clampCell(state.active.row, state.active.col, bounds);
      if (!cell) return EMPTY_SELECTION;
      return { ranges: [{ anchor: cell, focus: cell }], mode: 'cell', active: cell };
    }
  }
}
