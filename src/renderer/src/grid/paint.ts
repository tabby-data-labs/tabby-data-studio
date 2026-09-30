import type { BlockCache } from './block-cache';
import { cellText, type CellStyle } from './cell-format';
import type { GridGeometry, VisibleCol } from './layout';
import type { TextMetricsCache } from './text-metrics';
import type { ColumnMeta, GridTheme, SelectionState, SortSpec } from './types';
import { rangeEnd, rangeStart } from './selection';

/**
 * The structural subset of CanvasRenderingContext2D the painters use, taken as a
 * Pick so a real context is always assignable and a recording mock can stand in
 * for tests. AGENTS.md puts paint draw-order assertions in Tier 2, but they are
 * still required — this type is what makes them possible without a native
 * canvas dependency.
 */
export type PaintContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'globalAlpha'
  | 'lineWidth'
  | 'clearRect'
  | 'fillRect'
  | 'strokeRect'
  | 'fillText'
  | 'measureText'
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'rect'
  | 'clip'
  | 'setTransform'
>;

export interface PaintInput {
  readonly ctx: PaintContext;
  readonly geometry: GridGeometry;
  readonly columns: readonly ColumnMeta[];
  readonly cache: BlockCache;
  readonly theme: GridTheme;
  readonly selection: SelectionState;
  readonly metrics: TextMetricsCache;
  readonly sort: SortSpec | null;
  /** CSS pixel size of the target canvas layer. */
  readonly width: number;
  readonly height: number;
}

function styleColor(theme: GridTheme, style: CellStyle): string {
  switch (style) {
    case 'null':
    case 'muted':
      return theme.muted;
    case 'error':
      return theme.selectionStroke;
    case 'normal':
      return theme.text;
  }
}

/**
 * NULL renders italic and muted so a null is distinguishable from the empty
 * string at a glance — the single most common source of "why is this row wrong"
 * confusion in a database viewer.
 *
 * Prepending to the CSS font shorthand is safe (`italic 12px mono` is valid), and
 * the measurement cache keys on the font string, so italic widths are computed
 * separately rather than reusing the upright ones.
 */
function styleFont(theme: GridTheme, style: CellStyle): string {
  return style === 'null' ? `italic ${theme.cellFont}` : theme.cellFont;
}

/** Pixel-space Y of a row range, intersected with the body. Null when off-screen. */
function rowSpan(
  g: GridGeometry,
  startRow: number,
  endRow: number,
  height: number,
): { y: number; h: number } | null {
  const rowHeight = g.visibleRows[0]?.height ?? 22;
  const top = g.rowY(startRow);
  const bottom = g.rowY(endRow) + rowHeight;
  const y = Math.max(0, top);
  const h = Math.min(height, bottom) - y;
  return h > 0 ? { y, h } : null;
}

/** Columns of `band` that fall inside [startCol, endCol], as a pixel span. */
function colSpan(
  band: readonly VisibleCol[],
  startCol: number,
  endCol: number,
): { x: number; w: number } | null {
  let left = Infinity;
  let right = -Infinity;
  for (const entry of band) {
    if (entry.col < startCol || entry.col > endCol) continue;
    if (entry.x < left) left = entry.x;
    if (entry.x + entry.width > right) right = entry.x + entry.width;
  }
  return right > left ? { x: left, w: right - left } : null;
}

function paintCells(
  input: PaintInput,
  band: readonly VisibleCol[],
  clipX: number,
  clipW: number,
): void {
  const { ctx, geometry: g, cache, theme, metrics } = input;
  if (clipW <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(clipX, 0, clipW, input.height);
  ctx.clip();

  const pad = theme.cellPaddingX;
  let currentFont = theme.cellFont;
  ctx.font = currentFont;
  ctx.textBaseline = 'middle';

  for (const { row, y, height } of g.visibleRows) {
    const midY = y + height / 2;
    for (const entry of band) {
      const available = entry.width - pad * 2;
      if (available <= 0) continue;

      const cell = cache.get(row, entry.col);
      if (cell === undefined) {
        // Skeleton bar: the block has not arrived yet. Never guess a value.
        ctx.fillStyle = theme.placeholder;
        ctx.fillRect(entry.x + pad, midY - 1, Math.min(available, 24), 2);
        continue;
      }

      const formatted = cellText(cell);
      if (formatted.text === '') continue;

      // Assigning ctx.font is not free, so only touch it when the style changes.
      // In practice NULLs are scattered, so this flips a handful of times a frame.
      const font = styleFont(theme, formatted.style);
      if (font !== currentFont) {
        currentFont = font;
        ctx.font = font;
      }

      const fitted = metrics.fit(ctx, formatted.text, available);
      if (fitted.text === '') continue;

      ctx.fillStyle = styleColor(theme, formatted.style);
      ctx.textAlign =
        formatted.align === 'center' ? 'center' : formatted.align === 'right' ? 'right' : 'left';
      const textX =
        formatted.align === 'center'
          ? entry.x + entry.width / 2
          : formatted.align === 'right'
            ? entry.x + entry.width - pad
            : entry.x + pad;
      ctx.fillText(fitted.text, textX, midY);
    }
  }

  // Vertical gridlines, drawn after text so they are not covered by it.
  ctx.strokeStyle = theme.gridline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const entry of band) {
    const x = Math.round(entry.x + entry.width) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, input.height);
  }
  for (const { y, height } of g.visibleRows) {
    const ly = Math.round(y + height) + 0.5;
    ctx.moveTo(clipX, ly);
    ctx.lineTo(clipX + clipW, ly);
  }
  ctx.stroke();

  ctx.restore();
}

function paintSelectionBand(
  input: PaintInput,
  band: readonly VisibleCol[],
  clipX: number,
  clipW: number,
): void {
  const { ctx, geometry: g, selection, theme } = input;
  if (clipW <= 0 || selection.ranges.length === 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(clipX, 0, clipW, input.height);
  ctx.clip();

  for (const range of selection.ranges) {
    const start = rangeStart(range);
    const end = rangeEnd(range);
    const rows = rowSpan(g, start.row, end.row, input.height);
    const cols = colSpan(band, start.col, end.col);
    if (!rows || !cols) continue;

    ctx.fillStyle = theme.selectionFill;
    ctx.fillRect(cols.x, rows.y, cols.w, rows.h);
    ctx.strokeStyle = theme.selectionStroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(cols.x + 1, rows.y + 1, cols.w - 2, rows.h - 2);
  }

  // Active-cell handle, Excel style.
  const activeCol = band.find((entry) => entry.col === selection.active.col);
  if (activeCol) {
    const rows = rowSpan(g, selection.active.row, selection.active.row, input.height);
    if (rows) {
      const size = 6;
      ctx.fillStyle = theme.activeHandle;
      ctx.fillRect(
        activeCol.x + activeCol.width - size / 2,
        rows.y + rows.h - size / 2,
        size,
        size,
      );
    }
  }

  ctx.restore();
}

/**
 * Body layer. Draw order is fixed and back-to-front (GRID-SPEC §4):
 * background → stripes → cells → gridlines → selection → frozen shadow.
 *
 * Cells are painted in two clipped bands so a scrollable column sliding under
 * the frozen band is covered rather than blended into it — this must match
 * `hitTest`, which resolves those pixels to the frozen column.
 */
export function paintBody(input: PaintInput): void {
  const { ctx, geometry: g, theme } = input;
  const { width, height } = input;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = theme.stripe;
  for (const { row, y, height: rowHeight } of g.visibleRows) {
    if (row % 2 === 1) ctx.fillRect(0, y, width, rowHeight);
  }

  const frozenBand = g.visibleCols.filter((entry) => entry.frozen);
  const scrollBand = g.visibleCols.filter((entry) => !entry.frozen);

  paintCells(input, scrollBand, g.frozenWidth, width - g.frozenWidth);
  paintCells(input, frozenBand, 0, g.frozenWidth);

  paintSelectionBand(input, scrollBand, g.frozenWidth, width - g.frozenWidth);
  paintSelectionBand(input, frozenBand, 0, g.frozenWidth);

  // Shadow only while something is actually scrolled under the band.
  if (g.frozenWidth > 0 && g.scrollLeft > 0) {
    for (let i = 0; i < 6; i += 1) {
      ctx.globalAlpha = 0.05 * (6 - i);
      ctx.fillStyle = theme.frozenShadow;
      ctx.fillRect(g.frozenWidth + i, 0, 1, height);
    }
    ctx.globalAlpha = 1;
  }
}

export function paintColHeader(input: PaintInput): void {
  const { ctx, geometry: g, theme, columns, sort } = input;
  const { width, height } = input;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(0, 0, width, height);

  const bands: [readonly VisibleCol[], number, number][] = [
    [g.visibleCols.filter((e) => !e.frozen), g.frozenWidth, width - g.frozenWidth],
    [g.visibleCols.filter((e) => e.frozen), 0, g.frozenWidth],
  ];

  for (const [band, clipX, clipW] of bands) {
    if (clipW <= 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, 0, clipW, height);
    ctx.clip();

    for (const entry of band) {
      const meta = columns[entry.col];
      if (!meta) continue;
      const selected = input.selection.ranges.some((range) => {
        const s = rangeStart(range);
        const e = rangeEnd(range);
        return entry.col >= s.col && entry.col <= e.col;
      });
      if (selected) {
        ctx.fillStyle = theme.selectionFill;
        ctx.fillRect(entry.x, 0, entry.width, height);
      }

      const pad = theme.cellPaddingX;
      const available = entry.width - pad * 2;
      if (available <= 0) continue;

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const twoLine = height >= 34;
      ctx.font = theme.headerFont;
      ctx.fillStyle = theme.headerText;
      const name = metricsFit(input, meta.name, available);
      ctx.fillText(name, entry.x + pad, twoLine ? height * 0.36 : height / 2);

      if (twoLine) {
        ctx.font = theme.headerSubFont;
        ctx.fillStyle = theme.muted;
        const sub = metricsFit(input, meta.typeName, available);
        ctx.fillText(sub, entry.x + pad, height * 0.72);
      }

      if (sort && sort.columnIndex === entry.col) {
        ctx.fillStyle = theme.headerText;
        const cx = entry.x + entry.width - pad - 4;
        const cy = height / 2;
        ctx.beginPath();
        ctx.moveTo(cx - 4, sort.direction === 'asc' ? cy + 2 : cy - 2);
        ctx.lineTo(cx + 4, sort.direction === 'asc' ? cy + 2 : cy - 2);
        ctx.lineTo(cx, sort.direction === 'asc' ? cy - 4 : cy + 4);
        ctx.stroke();
      }

      // Resize handle
      ctx.strokeStyle = theme.headerBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const hx = Math.round(entry.x + entry.width) + 0.5;
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, height);
      ctx.stroke();
    }

    ctx.restore();
  }

  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height - 0.5);
  ctx.lineTo(width, height - 0.5);
  ctx.stroke();
}

function metricsFit(input: PaintInput, text: string, maxWidth: number): string {
  return input.metrics.fit(input.ctx, text, maxWidth).text;
}

export function paintRowHeader(input: PaintInput): void {
  const { ctx, geometry: g, theme, selection } = input;
  const { width, height } = input;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(0, 0, width, height);

  ctx.font = theme.headerSubFont;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (const { row, y, height: rowHeight } of g.visibleRows) {
    const selected = selection.ranges.some((range) => {
      const s = rangeStart(range);
      const e = rangeEnd(range);
      return row >= s.row && row <= e.row;
    });
    if (selected) {
      ctx.fillStyle = theme.selectionFill;
      ctx.fillRect(0, y, width, rowHeight);
    }
    ctx.fillStyle = selected ? theme.headerText : theme.muted;
    ctx.fillText(String(row + 1), width - theme.cellPaddingX, y + rowHeight / 2);
  }

  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(width - 0.5, 0);
  ctx.lineTo(width - 0.5, height);
  ctx.moveTo(0, height - 0.5);
  ctx.lineTo(width, height - 0.5);
  ctx.stroke();
}

export function paintCorner(input: PaintInput): void {
  const { ctx, theme } = input;
  ctx.clearRect(0, 0, input.width, input.height);
  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(0, 0, input.width, input.height);
  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(input.width - 0.5, 0);
  ctx.lineTo(input.width - 0.5, input.height);
  ctx.moveTo(0, input.height - 0.5);
  ctx.lineTo(input.width, input.height - 0.5);
  ctx.stroke();
}

export interface OverlayState {
  /** Vertical guide drawn while a column is being resized. */
  readonly resizeGuideX: number | null;
}

export function paintOverlay(
  ctx: PaintContext,
  width: number,
  height: number,
  state: OverlayState,
): void {
  ctx.clearRect(0, 0, width, height);
  if (state.resizeGuideX === null) return;
  ctx.strokeStyle = 'rgba(59, 118, 240, 0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const x = Math.round(state.resizeGuideX) + 0.5;
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}
