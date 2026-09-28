import type { ColumnSpec, GeometryInput, HitResult } from './types';

export type { ColumnSpec, GeometryInput };

export interface VisibleRow {
  readonly row: number;
  /** Body-local y (the body canvas starts at originY). */
  readonly y: number;
  readonly height: number;
}

export interface VisibleCol {
  readonly col: number;
  /** Body-local x (the body and column-header canvases both start at originX). */
  readonly x: number;
  readonly width: number;
  readonly frozen: boolean;
}

/**
 * Everything the paint pass and hit-testing need for one frame.
 *
 * Coordinate rule, and the reason there are only two accessors: horizontal
 * coordinates are relative to `originX` (the row-header width) and vertical
 * coordinates relative to `originY` (the header height). The body canvas and
 * the column-header canvas share originX; the body canvas and the row-header
 * canvas share originY. So `colX` is valid on body + colHeader, and `rowY` is
 * valid on body + rowHeader, with no per-layer arithmetic at the call site.
 *
 * `hitTest` is the inverse: it takes host-relative pointer coordinates and
 * subtracts the origins itself.
 */
export interface GridGeometry {
  readonly rowCount: number;
  /** Inclusive; an empty range is firstRow 0, lastRow -1. */
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstCol: number;
  readonly lastCol: number;
  readonly visibleRows: readonly VisibleRow[];
  /** Frozen columns first, then scrollable, in screen order. */
  readonly visibleCols: readonly VisibleCol[];
  readonly frozenWidth: number;
  /** Total width of the scrollable (non-frozen) columns. */
  readonly contentWidth: number;
  readonly contentHeight: number;
  /** Width available to scrollable columns, after the frozen band. */
  readonly scrollAreaWidth: number;
  readonly scrollAreaHeight: number;
  readonly maxScrollLeft: number;
  readonly maxScrollTop: number;
  /** Clamped to [0, max]. */
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly originX: number;
  readonly originY: number;
  readonly bodyWidthPx: number;
  readonly bodyHeightPx: number;
  rowY(row: number): number;
  colX(col: number): number;
  hitTest(x: number, y: number): HitResult;
}

const OUTSIDE: HitResult = { kind: 'outside' };
const CORNER: HitResult = { kind: 'corner' };

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Pure: no DOM, no state, no allocation beyond the returned structure. Every
 * grid bug worth fearing lives in this function, which is why it carries the
 * heaviest test coverage in the project.
 */
export function computeGeometry(input: GeometryInput): GridGeometry {
  const columns = input.columns;
  const columnCount = columns.length;

  const originX = Math.max(0, input.rowHeaderWidth);
  const originY = Math.max(0, input.headerHeight);
  const bodyWidthPx = Math.max(0, input.viewportWidth - originX);
  const bodyHeightPx = Math.max(0, input.viewportHeight - originY);

  // A non-positive row height would make the visible-range arithmetic diverge
  // (division by zero -> Infinity -> an unbounded row loop), so it is clamped.
  const rowHeight = input.rowHeight > 0 ? input.rowHeight : 1;
  const overscan = Math.max(0, Math.floor(input.overscan ?? 1));
  const rowCount = Math.max(0, Math.floor(input.rowCount));

  // ── Column grouping ───────────────────────────────────────────────────────
  let visibleColumnCount = 0;
  for (let i = 0; i < columnCount; i += 1) {
    if (columns[i]?.visible) visibleColumnCount += 1;
  }
  const frozenCount = clamp(Math.floor(input.frozenColumnCount), 0, visibleColumnCount);

  const widths = new Float64Array(columnCount);
  const frozenOffsets = new Float64Array(columnCount);
  const scrollOffsets = new Float64Array(columnCount);
  const isFrozen = new Uint8Array(columnCount);
  const frozenList: number[] = [];
  const scrollList: number[] = [];

  let frozenRun = 0;
  let scrollRun = 0;
  let seenVisible = 0;

  for (let i = 0; i < columnCount; i += 1) {
    const spec = columns[i];
    const visible = spec?.visible ?? false;
    // Hidden columns take zero width and collapse onto their group boundary.
    const width = visible ? Math.max(0, spec?.width ?? 0) : 0;
    widths[i] = width;

    const inFrozenBand = seenVisible < frozenCount;
    if (inFrozenBand) {
      isFrozen[i] = 1;
      frozenOffsets[i] = frozenRun;
      frozenRun += width;
    } else {
      scrollOffsets[i] = scrollRun;
      scrollRun += width;
    }

    if (visible) {
      seenVisible += 1;
      if (inFrozenBand) frozenList.push(i);
      else scrollList.push(i);
    }
  }

  const frozenWidth = frozenRun;
  const contentWidth = scrollRun;
  const scrollAreaWidth = Math.max(0, bodyWidthPx - frozenWidth);
  const maxScrollLeft = Math.max(0, contentWidth - scrollAreaWidth);
  const scrollLeft = clamp(
    Number.isFinite(input.scrollLeft) ? input.scrollLeft : 0,
    0,
    maxScrollLeft,
  );

  const xs = new Float64Array(columnCount);
  for (let i = 0; i < columnCount; i += 1) {
    xs[i] =
      isFrozen[i] === 1
        ? (frozenOffsets[i] ?? 0)
        : frozenWidth + (scrollOffsets[i] ?? 0) - scrollLeft;
  }

  // ── Rows ──────────────────────────────────────────────────────────────────
  const contentHeight = rowCount * rowHeight;
  const maxScrollTop = Math.max(0, contentHeight - bodyHeightPx);
  const scrollTop = clamp(Number.isFinite(input.scrollTop) ? input.scrollTop : 0, 0, maxScrollTop);

  let firstRow = 0;
  let lastRow = -1;
  const visibleRows: VisibleRow[] = [];

  if (rowCount > 0 && bodyHeightPx > 0) {
    const firstVisible = Math.floor(scrollTop / rowHeight);
    const lastVisible = Math.ceil((scrollTop + bodyHeightPx) / rowHeight) - 1;
    firstRow = clamp(firstVisible - overscan, 0, rowCount - 1);
    lastRow = clamp(lastVisible + overscan, 0, rowCount - 1);
    for (let row = firstRow; row <= lastRow; row += 1) {
      visibleRows.push({ row, y: row * rowHeight - scrollTop, height: rowHeight });
    }
  }

  // ── Visible columns ───────────────────────────────────────────────────────
  const visibleCols: VisibleCol[] = [];
  for (const col of frozenList) {
    visibleCols.push({ col, x: xs[col] ?? 0, width: widths[col] ?? 0, frozen: true });
  }

  let firstScrollSlot = -1;
  let lastScrollSlot = -1;
  const right = scrollLeft + scrollAreaWidth;
  for (let k = 0; k < scrollList.length; k += 1) {
    const col = scrollList[k] ?? 0;
    const start = scrollOffsets[col] ?? 0;
    if (start > right) break;
    if (start + (widths[col] ?? 0) > scrollLeft) {
      if (firstScrollSlot < 0) firstScrollSlot = k;
      lastScrollSlot = k;
    }
  }

  if (firstScrollSlot >= 0) {
    const from = Math.max(0, firstScrollSlot - overscan);
    const to = Math.min(scrollList.length - 1, lastScrollSlot + overscan);
    for (let k = from; k <= to; k += 1) {
      const col = scrollList[k] ?? 0;
      visibleCols.push({ col, x: xs[col] ?? 0, width: widths[col] ?? 0, frozen: false });
    }
  }

  let firstCol = 0;
  let lastCol = -1;
  for (const entry of visibleCols) {
    if (lastCol < 0) firstCol = entry.col;
    firstCol = Math.min(firstCol, entry.col);
    lastCol = Math.max(lastCol, entry.col);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────
  const rowY = (row: number): number => row * rowHeight - scrollTop;
  const colX = (col: number): number => (col >= 0 && col < columnCount ? (xs[col] ?? 0) : 0);

  const rowAtY = (localY: number): number => {
    const row = Math.floor((localY + scrollTop) / rowHeight);
    return row >= 0 && row < rowCount ? row : -1;
  };

  const colInList = (list: readonly number[], offsets: Float64Array, target: number): number => {
    for (const col of list) {
      const start = offsets[col] ?? 0;
      if (start > target) break;
      if (target < start + (widths[col] ?? 0)) return col;
    }
    return -1;
  };

  const colAtX = (localX: number): number => {
    if (localX < 0) return -1;
    if (localX < frozenWidth) return colInList(frozenList, frozenOffsets, localX);
    return colInList(scrollList, scrollOffsets, localX - frozenWidth + scrollLeft);
  };

  const hitTest = (x: number, y: number): HitResult => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return OUTSIDE;
    if (x < 0 || y < 0 || x >= input.viewportWidth || y >= input.viewportHeight) return OUTSIDE;

    if (x < originX) {
      if (y < originY) return CORNER;
      const row = rowAtY(y - originY);
      return row < 0 ? OUTSIDE : { kind: 'rowHeader', row };
    }

    if (y < originY) {
      const col = colAtX(x - originX);
      return col < 0 ? OUTSIDE : { kind: 'colHeader', col };
    }

    const row = rowAtY(y - originY);
    const col = colAtX(x - originX);
    if (row < 0 || col < 0) return OUTSIDE;
    return { kind: 'cell', row, col };
  };

  return {
    rowCount,
    firstRow,
    lastRow,
    firstCol,
    lastCol,
    visibleRows,
    visibleCols,
    frozenWidth,
    contentWidth,
    contentHeight,
    scrollAreaWidth,
    scrollAreaHeight: bodyHeightPx,
    maxScrollLeft,
    maxScrollTop,
    scrollTop,
    scrollLeft,
    originX,
    originY,
    bodyWidthPx,
    bodyHeightPx,
    rowY,
    colX,
    hitTest,
  };
}
