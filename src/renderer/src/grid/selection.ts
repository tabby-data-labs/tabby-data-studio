import type {
  CellRef,
  MoveDirection,
  SelRange,
  SelectionBounds,
  SelectionEvent,
  SelectionState,
} from './types';

export const EMPTY_SELECTION: SelectionState = {
  ranges: [],
  mode: 'cell',
  active: { row: 0, col: 0 },
};

/** Used when the caller does not report a viewport height in rows. */
const DEFAULT_PAGE_ROWS = 20;

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

function delta(direction: MoveDirection): { readonly dr: number; readonly dc: number } {
  switch (direction) {
    case 'up':
      return { dr: -1, dc: 0 };
    case 'down':
      return { dr: 1, dc: 0 };
    case 'left':
      return { dr: 0, dc: -1 };
    case 'right':
      return { dr: 0, dc: 1 };
  }
}

/** The sheet edge in a direction, ignoring data. */
function extentEdge(from: CellRef, direction: MoveDirection, bounds: SelectionBounds): CellRef {
  const { dr, dc } = delta(direction);
  return {
    row: dr === 0 ? from.row : dr > 0 ? bounds.rowCount - 1 : 0,
    col: dc === 0 ? from.col : dc > 0 ? bounds.colCount - 1 : 0,
  };
}

/**
 * Excel's cmd/ctrl+arrow: from a non-blank cell, stop at the last non-blank
 * before a gap; from a blank cell, jump across the gap to the next non-blank,
 * or to the sheet edge if there is none.
 */
function dataEdge(from: CellRef, direction: MoveDirection, bounds: SelectionBounds): CellRef {
  const isBlank = bounds.isBlank;
  if (!isBlank) return extentEdge(from, direction, bounds);

  const { dr, dc } = delta(direction);
  const maxRow = bounds.rowCount - 1;
  const maxCol = bounds.colCount - 1;
  const inside = (row: number, col: number): boolean =>
    row >= 0 && row <= maxRow && col >= 0 && col <= maxCol;

  let row = from.row;
  let col = from.col;
  let nextRow = row + dr;
  let nextCol = col + dc;
  if (!inside(nextRow, nextCol)) return from;

  const startBlank = isBlank(from.row, from.col);
  // Walk while the next cell matches the starting condition, then stop.
  while (inside(nextRow, nextCol) && isBlank(nextRow, nextCol) === startBlank) {
    row = nextRow;
    col = nextCol;
    nextRow += dr;
    nextCol += dc;
  }

  if (startBlank && inside(nextRow, nextCol)) {
    // Started in a gap: land on the first non-blank cell we found.
    return { row: nextRow, col: nextCol };
  }
  return { row, col };
}

/**
 * Tab walks rows, wrapping at the last column; arrows deliberately do not wrap.
 * At the very last cell Tab stops rather than leaving the grid.
 */
function tabTarget(from: CellRef, reverse: boolean, bounds: SelectionBounds): CellRef {
  const maxRow = bounds.rowCount - 1;
  const maxCol = bounds.colCount - 1;
  let { row, col } = from;

  if (!reverse) {
    if (col < maxCol) col += 1;
    else if (row < maxRow) {
      col = 0;
      row += 1;
    }
  } else if (col > 0) {
    col -= 1;
  } else if (row > 0) {
    col = maxCol;
    row -= 1;
  }

  return { row, col };
}

/** Apply a movement, either collapsing to the target or extending the primary range. */
function applyMove(
  state: SelectionState,
  target: CellRef,
  shift: boolean,
  bounds: SelectionBounds,
): SelectionState {
  const cell = clampCell(target.row, target.col, bounds);
  if (!cell) return EMPTY_SELECTION;

  if (!shift) {
    return { ranges: [{ anchor: cell, focus: cell }], mode: 'cell', active: cell };
  }

  const anchor = state.ranges[primaryIndex(state)]?.anchor ?? cell;
  return withPrimary(state, { anchor, focus: cell }, 'cell', cell);
}

/**
 * Pure selection reducer (GRID-SPEC §7).
 *
 * Pointer and header transitions landed in Phase 1 because the paint pass needs
 * them to draw a highlight; keyboard navigation is Phase 2. The reducer only
 * reports where the active cell moved to — scrolling it into view is the grid's
 * job, which is what keeps this module free of DOM and canvas concerns.
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

    case 'move': {
      const from = state.active;
      const target = event.meta
        ? dataEdge(from, event.direction, bounds)
        : (() => {
            const { dr, dc } = delta(event.direction);
            return { row: from.row + dr, col: from.col + dc };
          })();
      return applyMove(state, target, event.shift, bounds);
    }

    case 'movePage': {
      const pageRows = Math.max(1, Math.floor(bounds.pageRows ?? DEFAULT_PAGE_ROWS));
      const direction = event.direction === 'up' ? -pageRows : pageRows;
      return applyMove(
        state,
        { row: state.active.row + direction, col: state.active.col },
        event.shift,
        bounds,
      );
    }

    case 'moveToEdge': {
      const from = state.active;
      const maxRow = bounds.rowCount - 1;
      const maxCol = bounds.colCount - 1;
      let target: CellRef;
      switch (event.edge) {
        case 'firstRow':
          target = { row: 0, col: from.col };
          break;
        case 'lastRow':
          target = { row: maxRow, col: from.col };
          break;
        case 'firstCol':
          target = { row: from.row, col: 0 };
          break;
        case 'lastCol':
          target = { row: from.row, col: maxCol };
          break;
        case 'start':
          target = { row: 0, col: 0 };
          break;
        case 'end':
          target = { row: maxRow, col: maxCol };
          break;
      }
      return applyMove(state, target, event.shift, bounds);
    }

    case 'moveTab':
      return applyMove(state, tabTarget(state.active, event.reverse, bounds), false, bounds);

    case 'moveEnter': {
      const direction = event.reverse ? -1 : 1;
      return applyMove(
        state,
        { row: state.active.row + direction, col: state.active.col },
        false,
        bounds,
      );
    }
  }
}
