import type { GridGeometry } from './layout';
import type { MeasureContext } from './text-metrics';
import type { ColumnMeta, ColumnSpec } from './types';

export interface ColumnControllerOptions {
  readonly columns: readonly ColumnMeta[];
  readonly minWidth?: number;
  readonly maxWidth?: number;
}

export interface ResizeHit {
  readonly col: number;
  /** Screen x of the border being dragged, for the overlay guide. */
  readonly edgeX: number;
}

const HANDLE_TOLERANCE = 4;

/**
 * Column view state: width, visibility, and how many leading columns are frozen.
 *
 * Kept separate from `ColumnMeta` (which describes the database) because widths
 * and visibility are UI state that must survive a re-query.
 */
export class ColumnController {
  private readonly widths: number[];
  private readonly visible: boolean[];
  private readonly minWidth: number;
  private readonly maxWidth: number;
  private frozen: number;

  constructor(options: ColumnControllerOptions) {
    this.minWidth = Math.max(8, options.minWidth ?? 40);
    this.maxWidth = Math.max(this.minWidth, options.maxWidth ?? 800);
    this.widths = options.columns.map((column) =>
      this.clampWidth(column.widthHint > 0 ? column.widthHint : 120),
    );
    this.visible = options.columns.map(() => true);
    this.frozen = 0;
  }

  get count(): number {
    return this.widths.length;
  }

  get visibleCount(): number {
    return this.visible.reduce((total, isVisible) => total + (isVisible ? 1 : 0), 0);
  }

  get frozenColumnCount(): number {
    return this.frozen;
  }

  setFrozenColumnCount(count: number): void {
    this.frozen = Math.max(0, Math.min(this.visibleCount, Math.floor(count)));
  }

  specs(): ColumnSpec[] {
    return this.widths.map((width, index) => ({ width, visible: this.visible[index] ?? true }));
  }

  width(col: number): number {
    return this.widths[col] ?? this.minWidth;
  }

  isVisible(col: number): boolean {
    return this.visible[col] ?? false;
  }

  setVisible(col: number, visible: boolean): void {
    if (col < 0 || col >= this.visible.length) return;
    this.visible[col] = visible;
    // A hidden column cannot stay frozen.
    this.setFrozenColumnCount(this.frozen);
  }

  private clampWidth(width: number): number {
    // Only NaN needs a special case: min/max clamp ±Infinity correctly on their
    // own, and mapping +Infinity to the minimum would be a surprising snap.
    if (Number.isNaN(width)) return this.minWidth;
    return Math.max(this.minWidth, Math.min(this.maxWidth, width));
  }

  setWidth(col: number, width: number): void {
    if (col < 0 || col >= this.widths.length) return;
    this.widths[col] = this.clampWidth(width);
  }

  resizeBy(col: number, delta: number): void {
    this.setWidth(col, this.width(col) + delta);
  }

  /**
   * Sizes a column to its widest sampled value.
   *
   * Takes a caller-supplied sample so this stays a pure measurement: the grid
   * decides which rows to sample (a full scan of 1M rows would be slower than
   * the resize itself).
   */
  autoFit(
    col: number,
    samples: readonly string[],
    ctx: MeasureContext,
    measure: (context: MeasureContext, text: string) => number,
    header: string,
    paddingX: number,
  ): void {
    if (col < 0 || col >= this.widths.length) return;
    let widest = measure(ctx, header);
    for (const sample of samples) {
      const width = measure(ctx, sample);
      if (width > widest) widest = width;
    }
    // Padding on both sides, plus room for the sort caret.
    this.setWidth(col, Math.ceil(widest + paddingX * 2 + 12));
  }

  /**
   * Whether a point is on a column's resize handle. Only visible columns have
   * handles, and the frozen band is searched in screen order.
   */
  hitResizeHandle(
    x: number,
    y: number,
    geometry: GridGeometry,
    headerHeight: number,
  ): ResizeHit | null {
    if (y > headerHeight) return null;
    for (const entry of geometry.visibleCols) {
      const edgeX = geometry.originX + entry.x + entry.width;
      if (Math.abs(x - edgeX) <= HANDLE_TOLERANCE) {
        return { col: entry.col, edgeX };
      }
    }
    return null;
  }

  /**
   * Widest column whose right edge is at or before `x`, used when freezing at a
   * pointer position.
   */
  frozenCountAt(x: number, geometry: GridGeometry): number {
    let count = 0;
    for (const entry of geometry.visibleCols) {
      if (!entry.frozen && geometry.originX + entry.x + entry.width > x) break;
      count += 1;
    }
    return Math.min(count, this.visibleCount);
  }
}
