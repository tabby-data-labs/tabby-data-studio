/**
 * The grid's own contract types.
 *
 * The grid imports ONLY this module and `@shared/domain` (cell/column shapes).
 * It must not import Vue, Pinia, app components, or the IPC contract — enforced
 * by an ESLint rule so the module stays headlessly testable and extractable.
 */
import type { CellValue, ColumnMeta, RowBlock, SortDirection, SortSpec } from '@shared/domain';

export type { CellValue, ColumnMeta, RowBlock, SortDirection, SortSpec };

/**
 * The single dependency the grid has on the outside world. Phase 1 drives it
 * with FakeDataSource; Phase 5 swaps in a RemoteDataSource without touching
 * grid code — that is the test of whether this boundary is right.
 */
export interface DataSource {
  readonly columns: readonly ColumnMeta[];
  readonly rowCount: number;
  readonly rowCountIsEstimate: boolean;
  getBlock(startRow: number, rowCount: number, signal: AbortSignal): Promise<RowBlock>;
  sort(columnIndex: number, direction: 'asc' | 'desc' | null): Promise<void>;
}

// ── Geometry inputs ──────────────────────────────────────────────────────────

/** Per-column view state. Frozen-ness is positional (leading N visible columns). */
export interface ColumnSpec {
  readonly width: number;
  readonly visible: boolean;
}

export interface GeometryInput {
  readonly columns: readonly ColumnSpec[];
  readonly rowCount: number;
  readonly rowHeight: number;
  readonly headerHeight: number;
  readonly rowHeaderWidth: number;
  /** Number of leading *visible* columns pinned to the left. */
  readonly frozenColumnCount: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Extra rows/columns rendered beyond the viewport. Defaults to 1. */
  readonly overscan?: number;
}

// ── Hit testing ──────────────────────────────────────────────────────────────

/**
 * A discriminated union rather than the `{ row: -1 }` sentinel sketched in
 * GRID-SPEC §3: exhaustiveness checking catches unhandled regions at compile
 * time, which a sentinel value cannot.
 */
export type HitResult =
  | { readonly kind: 'corner' }
  | { readonly kind: 'colHeader'; readonly col: number }
  | { readonly kind: 'rowHeader'; readonly row: number }
  | { readonly kind: 'cell'; readonly row: number; readonly col: number }
  | { readonly kind: 'outside' };

// ── Selection ────────────────────────────────────────────────────────────────

export interface CellRef {
  readonly row: number;
  readonly col: number;
}

export interface SelRange {
  readonly anchor: CellRef;
  readonly focus: CellRef;
}

export type SelectionMode = 'cell' | 'row' | 'col' | 'all';

export interface SelectionState {
  readonly ranges: readonly SelRange[];
  readonly mode: SelectionMode;
  /** The cell an editor or inspector would target. */
  readonly active: CellRef;
}

export type SelectionEvent =
  | {
      readonly type: 'click';
      readonly row: number;
      readonly col: number;
      readonly shift: boolean;
      readonly meta: boolean;
    }
  | { readonly type: 'dragTo'; readonly row: number; readonly col: number }
  | { readonly type: 'clickRowHeader'; readonly row: number; readonly shift: boolean }
  | { readonly type: 'clickColHeader'; readonly col: number; readonly shift: boolean }
  | { readonly type: 'clickCorner' }
  | { readonly type: 'clear' }
  // ── Phase 2: keyboard ──────────────────────────────────────────────────────
  | {
      readonly type: 'move';
      readonly direction: MoveDirection;
      readonly shift: boolean;
      /** cmd/ctrl: jump to the edge of contiguous data instead of one cell. */
      readonly meta: boolean;
    }
  | { readonly type: 'movePage'; readonly direction: 'up' | 'down'; readonly shift: boolean }
  | { readonly type: 'moveToEdge'; readonly edge: SelectionEdge; readonly shift: boolean }
  | { readonly type: 'moveTab'; readonly reverse: boolean }
  | { readonly type: 'moveEnter'; readonly reverse: boolean };

export type MoveDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Absolute extent targets. `move` with `meta` is *data*-relative (it stops at a
 * blank cell); these are always the sheet edges, which is what Cmd+Home/Cmd+End
 * and Home/End mean in Excel.
 */
export type SelectionEdge = 'firstRow' | 'lastRow' | 'firstCol' | 'lastCol' | 'start' | 'end';

export interface SelectionBounds {
  readonly rowCount: number;
  readonly colCount: number;
  /** Viewport size in cells, for Page Up/Down. Defaults to 20 rows / 10 cols. */
  readonly pageRows?: number;
  readonly pageCols?: number;
  /**
   * Reports whether a cell is blank, so cmd+arrow can stop at the edge of a
   * contiguous run the way Excel does. Omit it and cmd+arrow goes to the extent
   * edge instead — a deliberate, testable fallback rather than a guess.
   */
  readonly isBlank?: (row: number, col: number) => boolean;
}

// ── Theme ────────────────────────────────────────────────────────────────────

export interface GridTheme {
  readonly background: string;
  readonly stripe: string;
  readonly gridline: string;
  readonly text: string;
  readonly muted: string;
  readonly headerBackground: string;
  readonly headerText: string;
  readonly headerBorder: string;
  readonly selectionFill: string;
  readonly selectionStroke: string;
  readonly activeHandle: string;
  readonly frozenShadow: string;
  readonly placeholder: string;
  readonly cellFont: string;
  readonly headerFont: string;
  readonly headerSubFont: string;
  readonly cellPaddingX: number;
  readonly rowHeight: number;
  readonly headerHeight: number;
  readonly rowHeaderWidth: number;
}
