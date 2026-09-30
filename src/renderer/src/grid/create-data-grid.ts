import { AriaProxy } from './aria';
import { BlockCache } from './block-cache';
import { CanvasLayers } from './canvas-layers';
import { cellText } from './cell-format';
import { serialise, type ClipboardFormat } from './clipboard';
import { ColumnController } from './columns';
import { ContextMenu, type MenuItem } from './context-menu';
import { DataWindowController } from './data-window';
import { CellInspector } from './inspector';
import { detectPlatform, selectionActionFromKey, type Platform } from './keyboard';
import { computeGeometry, type GridGeometry } from './layout';
import {
  paintBody,
  paintColHeader,
  paintCorner,
  paintOverlay,
  paintRowHeader,
  type PaintInput,
} from './paint';
import { RenderLoop } from './render-loop';
import {
  EMPTY_SELECTION,
  boundingBox,
  isSelected,
  reduceSelection,
  selectedCellCount,
} from './selection';
import { ScrollController, scrollOffsetFromThumb, thumbGeometry, type ScrollAlign } from './scroll';
import { TextMetricsCache } from './text-metrics';
import { DARK_THEME } from './theme';
import { Tooltip } from './tooltip';
import type {
  CellRef,
  CellValue,
  DataSource,
  GridTheme,
  HitResult,
  SelectionBounds,
  SelectionEvent,
  SelectionState,
  SortDirection,
  SortSpec,
} from './types';

export interface DataGridOptions {
  readonly host: HTMLElement;
  readonly source: DataSource;
  readonly theme?: Partial<GridTheme>;
  readonly frozenColumnCount?: number;
  readonly blockSize?: number;
  readonly prefetch?: number;
  readonly overscan?: number;
  readonly a11y?: { readonly label: string };
  readonly platform?: Platform;
  /** Where the Cell Inspector panel is mounted. Defaults to the grid host's parent. */
  readonly inspectorHost?: HTMLElement;
  readonly onSelectionChange?: (selection: SelectionState) => void;
  readonly onCellActivate?: (cell: CellRef) => void;
  readonly onColumnResize?: (col: number, width: number) => void;
  readonly onSort?: (col: number, direction: SortDirection | null) => void;
  readonly onInspect?: (cell: CellRef) => void;
}

export interface CopyOptions {
  readonly format?: ClipboardFormat;
  readonly includeHeader?: boolean;
  readonly nullText?: string;
  readonly table?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (rowsDone: number, rowsTotal: number) => void;
}

export interface DataGrid {
  invalidate(): void;
  resize(): void;
  scrollToRow(row: number, align?: ScrollAlign): void;
  scrollToCell(row: number, col: number): void;
  getSelection(): SelectionState;
  setSelection(selection: SelectionState): void;
  /** Number of cells a copy would serialise, so callers can warn before a huge one. */
  selectedCellCount(): number;
  copy(options?: CopyOptions): Promise<string>;
  /**
   * Why the last clipboard write failed, or null when it succeeded. A packaged
   * renderer is a non-secure `file://` origin, so the async clipboard API can be
   * unavailable; callers must be able to tell "copied" from "serialised but not
   * copied" instead of showing a false success.
   */
  lastCopyError(): string | null;
  setFrozenColumnCount(count: number): void;
  setColumnWidth(col: number, width: number): void;
  autoFitColumn(col: number): void;
  setColumnVisible(col: number, visible: boolean): void;
  setSort(sort: SortSpec | null): Promise<void>;
  inspect(row: number, col: number): void;
  closeInspector(): void;
  updateTheme(theme: Partial<GridTheme>): void;
  /** Frame statistics for the benchmark overlay. */
  stats(): ReturnType<RenderLoop['stats']>;
  resetStats(): void;
  destroy(): void;
}

const SCROLLBAR_SIZE = 12;
const AUTOFIT_SAMPLE_ROWS = 200;
/** Rows fetched per batch while collecting a copy, so the UI stays responsive. */
const COPY_BATCH_ROWS = 500;
/**
 * ARIA proxy refresh interval, on its own timer rather than inside the paint
 * loop. See flushAria() for why that separation matters.
 */
const ARIA_UPDATE_MS = 100;

interface DragState {
  readonly kind: 'select' | 'resize';
  readonly col?: number;
  readonly startX?: number;
  readonly startWidth?: number;
  readonly pointerId: number;
}

/**
 * The grid facade (GRID-SPEC §12).
 *
 * Deliberately framework-free: no Vue reactivity anywhere inside. 30k reactive
 * cells would destroy the frame budget, so the Vue adapter drives this through
 * method calls and this drives itself through one coalesced rAF loop.
 */
export function createDataGrid(options: DataGridOptions): DataGrid {
  const theme: GridTheme = { ...DARK_THEME, ...options.theme };
  const source = options.source;
  const overscan = options.overscan ?? 1;

  const layers = new CanvasLayers(options.host);
  const metrics = new TextMetricsCache();
  const columns = new ColumnController({ columns: source.columns });
  columns.setFrozenColumnCount(options.frozenColumnCount ?? 0);

  const cache = new BlockCache({ blockSize: options.blockSize ?? 200 });
  const loop = new RenderLoop(renderFrame);
  const window_ = new DataWindowController({
    source,
    cache,
    prefetch: options.prefetch ?? 2,
    onArrive: () => loop.invalidate(),
  });

  let selection: SelectionState = EMPTY_SELECTION;
  let sort: SortSpec | null = null;
  let drag: DragState | null = null;
  let resizeGuideX: number | null = null;
  let ariaDirty = true;
  /** Set when a clipboard write failed, so the UI can report it honestly. */
  let lastCopyError: string | null = null;

  // Declared before `geometry` on purpose: compute() reads the scroll offsets,
  // so initialising geometry first would hit a TDZ error on `scroll`. The
  // viewportHeight callback is lazy, so it may close over `geometry`.
  const scroll = new ScrollController({
    target: layers.root,
    rowHeight: () => theme.rowHeight,
    viewportHeight: () => geometry.bodyHeightPx,
    onScroll: () => loop.invalidate(),
  });

  let geometry: GridGeometry = compute();

  // ── Scrollbars ─────────────────────────────────────────────────────────────
  const vTrack = document.createElement('div');
  const vThumb = document.createElement('div');
  const hTrack = document.createElement('div');
  const hThumb = document.createElement('div');

  for (const track of [vTrack, hTrack]) {
    track.style.position = 'absolute';
    track.style.pointerEvents = 'auto';
    track.style.background = 'rgba(255,255,255,0.03)';
    track.style.zIndex = '3';
  }
  for (const thumb of [vThumb, hThumb]) {
    thumb.style.position = 'absolute';
    thumb.style.borderRadius = '4px';
    thumb.style.background = 'rgba(139,160,187,0.45)';
    thumb.style.pointerEvents = 'auto';
    thumb.style.zIndex = '4';
  }
  vTrack.style.top = `${theme.headerHeight}px`;
  vTrack.style.right = '0';
  vTrack.style.width = `${SCROLLBAR_SIZE}px`;
  hTrack.style.left = `${theme.rowHeaderWidth}px`;
  hTrack.style.bottom = '0';
  hTrack.style.height = `${SCROLLBAR_SIZE}px`;
  layers.root.append(vTrack, vThumb, hTrack, hThumb);

  // ── Accessibility, overlays ────────────────────────────────────────────────
  // A canvas exposes nothing to assistive tech, so AriaProxy mirrors the visible
  // window into a real role="grid" subtree (GRID-SPEC §10).
  const platform = options.platform ?? detectPlatform();
  const aria = new AriaProxy({
    container: layers.root,
    label: options.a11y?.label ?? 'Data grid',
  });
  aria.describeFocusElement(layers.root);
  layers.root.setAttribute('aria-label', options.a11y?.label ?? 'Data grid');

  const contextMenu = new ContextMenu(layers.root);
  const tooltip = new Tooltip(layers.root);
  // The inspector is a slide-over positioned against the grid root, so it needs
  // no cooperation from the app shell's layout.
  const inspector = new CellInspector(options.inspectorHost ?? layers.root);

  // ── Geometry ───────────────────────────────────────────────────────────────
  function compute(): GridGeometry {
    return computeGeometry({
      columns: columns.specs(),
      rowCount: source.rowCount,
      rowHeight: theme.rowHeight,
      headerHeight: theme.headerHeight,
      rowHeaderWidth: theme.rowHeaderWidth,
      frozenColumnCount: columns.frozenColumnCount,
      scrollTop: scroll.scrollTop,
      scrollLeft: scroll.scrollLeft,
      viewportWidth: layers.viewportWidth,
      viewportHeight: layers.viewportHeight,
      overscan,
    });
  }

  function measureViewport(): void {
    const rect = options.host.getBoundingClientRect();
    layers.resize(
      rect.width,
      rect.height,
      theme.rowHeaderWidth,
      theme.headerHeight,
      window.devicePixelRatio || 1,
    );
  }

  function paintInput(width: number, height: number): PaintInput {
    return {
      ctx: layers.layer('body').ctx,
      geometry,
      columns: source.columns,
      cache,
      theme,
      selection,
      metrics,
      sort,
      width,
      height,
    };
  }

  function updateScrollbars(): void {
    const bodyW = geometry.bodyWidthPx;
    const bodyH = geometry.bodyHeightPx;
    const vTrackHeight = Math.max(0, bodyH - SCROLLBAR_SIZE);
    const hTrackWidth = Math.max(0, bodyW - SCROLLBAR_SIZE);

    vTrack.style.top = `${theme.headerHeight}px`;
    vTrack.style.height = `${vTrackHeight}px`;
    hTrack.style.left = `${theme.rowHeaderWidth}px`;
    hTrack.style.width = `${hTrackWidth}px`;

    const vertical = thumbGeometry(geometry.contentHeight, bodyH, scroll.scrollTop, vTrackHeight);
    if (vertical) {
      vTrack.style.display = '';
      vThumb.style.display = '';
      vThumb.style.width = `${SCROLLBAR_SIZE - 2}px`;
      vThumb.style.height = `${vertical.size}px`;
      vThumb.style.right = '1px';
      vThumb.style.top = `${theme.headerHeight + vertical.offset}px`;
    } else {
      vTrack.style.display = 'none';
      vThumb.style.display = 'none';
    }

    const horizontal = thumbGeometry(geometry.contentWidth, bodyW, scroll.scrollLeft, hTrackWidth);
    if (horizontal) {
      hTrack.style.display = '';
      hThumb.style.display = '';
      hThumb.style.height = `${SCROLLBAR_SIZE - 2}px`;
      hThumb.style.width = `${horizontal.size}px`;
      hThumb.style.bottom = '1px';
      hThumb.style.left = `${theme.rowHeaderWidth + horizontal.offset}px`;
    } else {
      hTrack.style.display = 'none';
      hThumb.style.display = 'none';
    }
  }

  function renderFrame(): void {
    // Bracket the frame so the measureText budget is a real measurement rather
    // than a number that quietly reads zero.
    metrics.resetStats();

    geometry = compute();
    scroll.setExtents(geometry.maxScrollTop, geometry.maxScrollLeft);
    window_.update(geometry.firstRow, geometry.lastRow);

    const body = layers.region('body');
    const header = layers.region('colHeader');
    const rowHeader = layers.region('rowHeader');
    const corner = layers.region('corner');

    paintBody({ ...paintInput(body.width, body.height), ctx: layers.layer('body').ctx });
    paintColHeader({
      ...paintInput(header.width, header.height),
      ctx: layers.layer('colHeader').ctx,
    });
    paintRowHeader({
      ...paintInput(rowHeader.width, rowHeader.height),
      ctx: layers.layer('rowHeader').ctx,
    });
    paintCorner({ ...paintInput(corner.width, corner.height), ctx: layers.layer('corner').ctx });
    paintOverlay(layers.layer('overlay').ctx, layers.viewportWidth, layers.viewportHeight, {
      resizeGuideX,
    });

    updateScrollbars();
    markAriaDirty();

    const measured = metrics.stats;
    loop.recordMeasureText(measured.lookups, measured.misses);
  }

  // ── Selection plumbing ─────────────────────────────────────────────────────
  function bounds(): SelectionBounds {
    return {
      rowCount: source.rowCount,
      colCount: columns.count,
      // Page size in cells, so Page Up/Down moves a viewport rather than a guess.
      pageRows: Math.max(1, Math.floor(geometry.bodyHeightPx / theme.rowHeight)),
      isBlank,
    };
  }

  function cellAt(row: number, col: number): CellValue | undefined {
    return cache.get(row, col);
  }

  function textAt(row: number, col: number): string {
    const cell = cellAt(row, col);
    return cell ? cellText(cell).text : '';
  }

  /**
   * Blank for cmd+arrow purposes: a NULL, or a row the block cache has not
   * fetched yet. Treating an unloaded cell as blank would make cmd+Down stop at
   * the edge of the loaded window, so unloaded is reported as non-blank and the
   * jump runs to the data edge instead — a wrong-but-useful answer beats a
   * silently truncated one.
   */
  function isBlank(row: number, col: number): boolean {
    const cell = cellAt(row, col);
    if (cell === undefined) return false;
    if (cell.kind === 'null') return true;
    return cell.kind === 'text' && cell.value === '';
  }

  function updateAria(): void {
    aria.update({
      rowCount: source.rowCount,
      colCount: columns.count,
      columns: source.columns,
      visibleRows: geometry.visibleRows.map((entry) => entry.row),
      active: selection.active,
      isSelected: (row, col) => isSelected(selection, row, col),
      cellText: textAt,
    });
  }

  /**
   * ARIA refresh, decoupled from the paint loop.
   *
   * The proxy rebuilds ~1,200 DOM nodes for a full window. Running that inside
   * the rAF callback — even throttled — puts a spike on whichever frame it lands
   * on, which showed up as p95 8.9ms / p99 11.0ms against a 10ms budget.
   *
   * A screen reader does not need frame-synced updates, so the proxy now refreshes
   * on its own 10Hz timer and only when something actually changed. Paint frames
   * never touch the DOM tree, and an idle grid does no work at all.
   */
  function markAriaDirty(): void {
    ariaDirty = true;
  }

  function flushAria(): void {
    if (!ariaDirty) return;
    ariaDirty = false;
    updateAria();
  }

  function applySelection(next: SelectionState, announce = true): void {
    const previous = selection.active;
    selection = next;
    options.onSelectionChange?.(next);

    if (announce) {
      const { row, col } = next.active;
      const column = source.columns[col];
      const name = column?.name ?? `column ${col + 1}`;
      const value = textAt(row, col);
      const position = `Row ${row + 1} of ${source.rowCount}, column ${name}`;
      aria.announce(value === '' ? position : `${position}, ${value}`);
    }

    options.onCellActivate?.(next.active);
    // Keep the active cell on screen after a keyboard move, but do not fight the
    // user when the movement came from a click they already positioned.
    if (announce && (next.active.row !== previous.row || next.active.col !== previous.col)) {
      scrollActiveIntoView();
    }
    loop.invalidate();
  }

  function scrollActiveIntoView(): void {
    scroll.scrollToRow(selection.active.row, 'nearest');
    const x = geometry.colX(selection.active.col);
    const width = columns.width(selection.active.col);
    if (x < geometry.frozenWidth) return;
    const right = x + width;
    if (right > geometry.bodyWidthPx) {
      scroll.set(scroll.scrollTop, scroll.scrollLeft + (right - geometry.bodyWidthPx));
    } else if (x < geometry.frozenWidth) {
      scroll.set(scroll.scrollTop, scroll.scrollLeft + (x - geometry.frozenWidth));
    }
  }

  function dispatch(event: SelectionEvent): void {
    applySelection(reduceSelection(selection, event, bounds()));
  }

  // ── Pointer handling ───────────────────────────────────────────────────────
  function localPoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = layers.root.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const { x, y } = localPoint(event);
    layers.root.focus();

    const handle = columns.hitResizeHandle(x, y, geometry, theme.headerHeight);
    if (handle) {
      drag = {
        kind: 'resize',
        col: handle.col,
        startX: x,
        startWidth: columns.width(handle.col),
        pointerId: event.pointerId,
      };
      resizeGuideX = handle.edgeX;
      layers.root.setPointerCapture(event.pointerId);
      loop.invalidate();
      return;
    }

    const hit = geometry.hitTest(x, y);
    switch (hit.kind) {
      case 'corner':
        dispatch({ type: 'clickCorner' });
        break;
      case 'colHeader':
        dispatch({ type: 'clickColHeader', col: hit.col, shift: event.shiftKey });
        break;
      case 'rowHeader':
        dispatch({ type: 'clickRowHeader', row: hit.row, shift: event.shiftKey });
        break;
      case 'cell':
        dispatch({
          type: 'click',
          row: hit.row,
          col: hit.col,
          shift: event.shiftKey,
          meta: event.metaKey || event.ctrlKey,
        });
        drag = { kind: 'select', pointerId: event.pointerId };
        layers.root.setPointerCapture(event.pointerId);
        break;
      case 'outside':
        break;
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) {
      handleHover(event);
      return;
    }
    const { x, y } = localPoint(event);

    if (drag.kind === 'resize' && drag.col !== undefined) {
      const delta = x - (drag.startX ?? x);
      columns.setWidth(drag.col, (drag.startWidth ?? 0) + delta);
      resizeGuideX = geometry.originX + geometry.colX(drag.col) + columns.width(drag.col);
      loop.invalidate();
      return;
    }

    const hit = geometry.hitTest(x, y);
    if (hit.kind === 'cell') dispatch({ type: 'dragTo', row: hit.row, col: hit.col });
    else if (hit.kind === 'rowHeader')
      dispatch({ type: 'clickRowHeader', row: hit.row, shift: true });
    else if (hit.kind === 'colHeader')
      dispatch({ type: 'clickColHeader', col: hit.col, shift: true });
  }

  /**
   * Hover feedback: a resize cursor over a column border, otherwise a tooltip
   * carrying the untruncated value. Cheap because the tooltip has its own delay
   * and a sweep across the grid only reschedules it.
   */
  function handleHover(event: PointerEvent): void {
    const { x, y } = localPoint(event);
    const handle = columns.hitResizeHandle(x, y, geometry, theme.headerHeight);
    layers.root.style.cursor = handle ? 'col-resize' : '';
    if (handle) {
      tooltip.hide();
      return;
    }

    const hit = geometry.hitTest(x, y);
    if (hit.kind === 'cell') {
      const column = source.columns[hit.col];
      const value = textAt(hit.row, hit.col);
      const label = column ? `${column.name}: ${value}` : value;
      tooltip.schedule(x, y, value === '' ? `${column?.name ?? ''} (empty)` : label);
    } else if (hit.kind === 'colHeader') {
      const column = source.columns[hit.col];
      tooltip.schedule(
        x,
        y,
        column
          ? `${column.name}\n${column.typeName}${column.nullable ? ' NULL' : ' NOT NULL'}`
          : '',
      );
    } else {
      tooltip.hide();
    }
  }

  function onPointerLeave(): void {
    tooltip.hide();
    layers.root.style.cursor = '';
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const { x, y } = localPoint(event);
    const hit = geometry.hitTest(x, y);

    // Right-clicking a cell that is not already selected selects it first, so
    // the menu acts on what the user is pointing at — the behaviour every file
    // manager and spreadsheet has trained people to expect.
    if (hit.kind === 'cell' && !isSelected(selection, hit.row, hit.col)) {
      dispatch({ type: 'click', row: hit.row, col: hit.col, shift: false, meta: false });
    }

    contextMenu.show(x, y, buildMenuItems(hit));
  }

  function buildMenuItems(hit: HitResult): MenuItem[] {
    const primary = window.navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
    const cells = selectedCellCount(selection);
    const hasSelection = cells > 0;

    const items: MenuItem[] = [
      {
        label: `Copy (${primary}+C)`,
        disabled: !hasSelection,
        action: () => void copySelection({ format: 'tsv' }),
      },
      {
        label: 'Copy as CSV',
        disabled: !hasSelection,
        action: () => void copySelection({ format: 'csv', includeHeader: true }),
        separatorAfter: true,
      },
      {
        label: 'Copy as JSON',
        disabled: !hasSelection,
        action: () => void copySelection({ format: 'json' }),
      },
      {
        label: 'Copy as SQL INSERT',
        disabled: !hasSelection,
        action: () => void copySelection({ format: 'sql' }),
      },
      {
        label: 'Copy as Markdown',
        disabled: !hasSelection,
        action: () => void copySelection({ format: 'markdown', includeHeader: true }),
        separatorAfter: true,
      },
    ];

    if (hit.kind === 'cell') {
      const column = source.columns[hit.col];
      items.push(
        {
          label: 'Inspect cell',
          action: () => inspectCell(hit.row, hit.col),
        },
        {
          label: `Sort ${column?.name ?? ''} ascending`,
          action: () => void applySort({ columnIndex: hit.col, direction: 'asc' }),
        },
        {
          label: `Sort ${column?.name ?? ''} descending`,
          action: () => void applySort({ columnIndex: hit.col, direction: 'desc' }),
        },
        {
          label: 'Clear sort',
          disabled: sort === null,
          action: () => void applySort(null),
          separatorAfter: true,
        },
      );
    }

    if (hit.kind === 'colHeader' || hit.kind === 'cell') {
      const col = hit.kind === 'colHeader' ? hit.col : hit.col;
      items.push(
        {
          label: `Freeze through ${source.columns[col]?.name ?? `column ${col + 1}`}`,
          action: () => {
            columns.setFrozenColumnCount(col + 1);
            loop.invalidate();
          },
        },
        {
          label: 'Unfreeze all columns',
          disabled: columns.frozenColumnCount === 0,
          action: () => {
            columns.setFrozenColumnCount(0);
            loop.invalidate();
          },
        },
        {
          label: `Hide ${source.columns[col]?.name ?? `column ${col + 1}`}`,
          disabled: columns.visibleCount <= 1,
          action: () => {
            columns.setVisible(col, false);
            columns.setFrozenColumnCount(columns.frozenColumnCount);
            loop.invalidate();
          },
          separatorAfter: true,
        },
      );
    }

    items.push({
      label: 'Select all',
      action: () => dispatch({ type: 'clickCorner' }),
    });

    return items;
  }

  function onDoubleClick(event: MouseEvent): void {
    const { x, y } = localPoint(event);
    const handle = columns.hitResizeHandle(x, y, geometry, theme.headerHeight);
    if (handle) {
      autoFit(handle.col);
      options.onColumnResize?.(handle.col, columns.width(handle.col));
      loop.invalidate();
      return;
    }
    // Double-clicking a cell opens the inspector: the canvas truncates to the
    // column width, so this is how a long value gets read in full.
    const hit = geometry.hitTest(x, y);
    if (hit.kind === 'cell') inspectCell(hit.row, hit.col);
  }

  function inspectCell(row: number, col: number): void {
    const column = source.columns[col];
    if (!column) return;
    inspector.show({ row, column, cell: cellAt(row, col) });
    options.onInspect?.({ row, col });
  }

  function onKeyDown(event: KeyboardEvent): void {
    // The context menu owns the keyboard while it is open.
    if (contextMenu.visible && contextMenu.handleKey(event)) {
      event.preventDefault();
      return;
    }

    const action = selectionActionFromKey(event, platform);
    if (!action) return;

    event.preventDefault();
    if (action.kind === 'copy') {
      void copySelection({ format: 'tsv' });
      return;
    }
    dispatch(action.event);
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === 'resize' && drag.col !== undefined) {
      options.onColumnResize?.(drag.col, columns.width(drag.col));
    }
    drag = null;
    resizeGuideX = null;
    if (layers.root.hasPointerCapture(event.pointerId)) {
      layers.root.releasePointerCapture(event.pointerId);
    }
    loop.invalidate();
  }

  // ── Scrollbar dragging ─────────────────────────────────────────────────────
  function attachThumbDrag(thumb: HTMLElement, track: HTMLElement, vertical: boolean): () => void {
    let offsetInThumb = 0;

    const onDown = (event: PointerEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const rect = thumb.getBoundingClientRect();
      offsetInThumb = vertical ? event.clientY - rect.top : event.clientX - rect.left;
      thumb.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent): void => {
        const trackRect = track.getBoundingClientRect();
        const trackSize = vertical ? trackRect.height : trackRect.width;
        const thumbSize = vertical ? rect.height : rect.width;
        const position = vertical
          ? moveEvent.clientY - trackRect.top - offsetInThumb
          : moveEvent.clientX - trackRect.left - offsetInThumb;

        if (vertical) {
          scroll.set(
            scrollOffsetFromThumb(
              position,
              thumbSize,
              trackSize,
              geometry.contentHeight,
              geometry.bodyHeightPx,
            ),
            scroll.scrollLeft,
          );
        } else {
          scroll.set(
            scroll.scrollTop,
            scrollOffsetFromThumb(
              position,
              thumbSize,
              trackSize,
              geometry.contentWidth,
              geometry.bodyWidthPx,
            ),
          );
        }
      };

      const onUp = (upEvent: PointerEvent): void => {
        thumb.removeEventListener('pointermove', onMove);
        thumb.removeEventListener('pointerup', onUp);
        if (thumb.hasPointerCapture(upEvent.pointerId))
          thumb.releasePointerCapture(upEvent.pointerId);
      };

      thumb.addEventListener('pointermove', onMove);
      thumb.addEventListener('pointerup', onUp);
    };

    const onTrackDown = (event: PointerEvent): void => {
      // Click the track to page, which is what every native scrollbar does.
      const trackRect = track.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      const before = vertical ? event.clientY < thumbRect.top : event.clientX < thumbRect.left;
      const page = vertical ? geometry.bodyHeightPx : geometry.bodyWidthPx;
      if (vertical) scroll.set(scroll.scrollTop + (before ? -page : page), scroll.scrollLeft);
      else scroll.set(scroll.scrollTop, scroll.scrollLeft + (before ? -page : page));
      event.stopPropagation();
      void trackRect;
    };

    thumb.addEventListener('pointerdown', onDown);
    track.addEventListener('pointerdown', onTrackDown);
    return () => {
      thumb.removeEventListener('pointerdown', onDown);
      track.removeEventListener('pointerdown', onTrackDown);
    };
  }

  // ── Auto-fit ───────────────────────────────────────────────────────────────
  function autoFit(col: number): void {
    const ctx = layers.layer('body').ctx as unknown as {
      font: string;
      measureText(t: string): { width: number };
    };
    ctx.font = theme.cellFont;
    const samples: string[] = [];
    const end = Math.min(source.rowCount - 1, geometry.firstRow + AUTOFIT_SAMPLE_ROWS);
    for (let row = geometry.firstRow; row <= end; row += 1) {
      const cell = cache.get(row, col);
      if (cell) samples.push(cellText(cell).text);
    }
    const header = source.columns[col]?.name ?? '';
    columns.autoFit(
      col,
      samples,
      ctx,
      (c, text) => metrics.measure(c, text),
      header,
      theme.cellPaddingX,
    );
  }

  // ── Clipboard ──────────────────────────────────────────────────────────────
  /**
   * Collects the selected block row-major, fetching any rows the cache does not
   * already hold.
   *
   * Work is batched with a yield to the event loop between batches: building a
   * 100k-cell string in one synchronous go would freeze the renderer for long
   * enough to look like a hang, and would leave no opening for a cancel.
   */
  async function collectRows(
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
    signal: AbortSignal | undefined,
    onProgress: ((rowsDone: number, rowsTotal: number) => void) | undefined,
  ): Promise<(readonly (CellValue | undefined)[])[]> {
    const total = endRow - startRow + 1;
    const out: (readonly (CellValue | undefined)[])[] = [];
    const width = endCol - startCol + 1;

    for (let batchStart = startRow; batchStart <= endRow; batchStart += COPY_BATCH_ROWS) {
      if (signal?.aborted) throw new Error('copy cancelled');

      const batchEnd = Math.min(endRow, batchStart + COPY_BATCH_ROWS - 1);

      // Fill gaps straight from the source rather than waiting for the window
      // controller, whose prefetch is tuned for painting, not for export.
      const missing: number[] = [];
      for (let row = batchStart; row <= batchEnd; row += 1) {
        if (!cache.has(row)) missing.push(row);
      }
      if (missing.length > 0) {
        const from = missing[0]!;
        const to = missing[missing.length - 1]!;
        const block = await source.getBlock(
          from,
          to - from + 1,
          signal ?? new AbortController().signal,
        );
        cache.put(block);
      }

      for (let row = batchStart; row <= batchEnd; row += 1) {
        const line: (CellValue | undefined)[] = new Array(width);
        for (let col = startCol; col <= endCol; col += 1) line[col - startCol] = cellAt(row, col);
        out.push(line);
      }

      onProgress?.(batchEnd - startRow + 1, total);
      // Let the renderer breathe so the UI stays responsive during a big copy.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return out;
  }

  async function copySelection(options_: CopyOptions): Promise<string> {
    const box = boundingBox(selection);
    if (!box) return '';

    const rows = await collectRows(
      box.start.row,
      box.end.row,
      box.start.col,
      box.end.col,
      options_.signal,
      options_.onProgress,
    );

    const text = serialise({
      format: options_.format ?? 'tsv',
      rows,
      columns: source.columns,
      firstCol: box.start.col,
      includeHeader: options_.includeHeader,
      nullText: options_.nullText,
      table: options_.table,
    });

    try {
      await navigator.clipboard.writeText(text);
      lastCopyError = null;
    } catch (error) {
      // Chromium rejects clipboard writes from an unfocused document, and a
      // permission can be denied. The serialised text is still returned, and the
      // failure is recorded so the UI reports the truth instead of a false
      // "copied".
      lastCopyError = error instanceof Error ? error.message : String(error);
    }
    return text;
  }

  async function applySort(next: SortSpec | null): Promise<void> {
    sort = next;
    cache.invalidate();
    window_.abortAll();
    await source.sort(next?.columnIndex ?? -1, next?.direction ?? null);
    loop.invalidate();
    if (next) options.onSort?.(next.columnIndex, next.direction);
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  layers.root.addEventListener('pointerdown', onPointerDown);
  layers.root.addEventListener('pointermove', onPointerMove);
  layers.root.addEventListener('pointerup', onPointerUp);
  layers.root.addEventListener('pointercancel', onPointerUp);
  layers.root.addEventListener('pointerleave', onPointerLeave);
  layers.root.addEventListener('dblclick', onDoubleClick);
  layers.root.addEventListener('contextmenu', onContextMenu);
  layers.root.addEventListener('keydown', onKeyDown);
  const detachVThumb = attachThumbDrag(vThumb, vTrack, true);
  const detachHThumb = attachThumbDrag(hThumb, hTrack, false);
  scroll.attach();

  const observer = new ResizeObserver(() => {
    measureViewport();
    metrics.invalidate();
    loop.invalidate();
  });
  observer.observe(options.host);

  const disposeDpr = layers.watchDpr(() => {
    measureViewport();
    metrics.invalidate();
    loop.invalidate();
  });

  // Accessibility mirror on its own clock, so paint frames never touch the DOM
  // tree. The dirty flag means an idle grid does no work at all.
  const ariaTimer = window.setInterval(flushAria, ARIA_UPDATE_MS);

  measureViewport();
  geometry = compute();
  updateAria();
  loop.start();

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    invalidate: () => loop.invalidate(),

    resize: () => {
      measureViewport();
      metrics.invalidate();
      loop.invalidate();
    },

    scrollToRow: (row, align) => {
      scroll.scrollToRow(row, align);
    },

    scrollToCell: (row, col) => {
      scroll.scrollToRow(row, 'nearest');
      const x = geometry.colX(col);
      if (x < geometry.frozenWidth) return;
      const right = x + columns.width(col);
      if (right > geometry.bodyWidthPx) {
        scroll.set(scroll.scrollTop, scroll.scrollLeft + (right - geometry.bodyWidthPx));
      } else if (x < 0) {
        scroll.set(scroll.scrollTop, scroll.scrollLeft + x);
      }
    },

    getSelection: () => selection,

    setSelection: (next) => applySelection(next),

    selectedCellCount: () => selectedCellCount(selection),

    copy: (copyOptions) => copySelection(copyOptions ?? {}),

    lastCopyError: () => lastCopyError,

    setFrozenColumnCount: (count) => {
      columns.setFrozenColumnCount(count);
      loop.invalidate();
    },

    setColumnWidth: (col, width) => {
      columns.setWidth(col, width);
      loop.invalidate();
    },

    autoFitColumn: (col) => {
      autoFit(col);
      loop.invalidate();
    },

    setColumnVisible: (col, visible) => {
      columns.setVisible(col, visible);
      loop.invalidate();
    },

    setSort: (next) => applySort(next),

    inspect: (row, col) => inspectCell(row, col),

    closeInspector: () => inspector.hide(),

    updateTheme: (patch) => {
      Object.assign(theme, patch);
      measureViewport();
      metrics.invalidate();
      loop.invalidate();
    },

    stats: () => loop.stats(),
    resetStats: () => loop.resetStats(),

    destroy: () => {
      observer.disconnect();
      window.clearInterval(ariaTimer);
      disposeDpr();
      detachVThumb();
      detachHThumb();
      scroll.destroy();
      loop.destroy();
      window_.abortAll();
      layers.root.removeEventListener('pointerdown', onPointerDown);
      layers.root.removeEventListener('pointermove', onPointerMove);
      layers.root.removeEventListener('pointerup', onPointerUp);
      layers.root.removeEventListener('pointercancel', onPointerUp);
      layers.root.removeEventListener('pointerleave', onPointerLeave);
      layers.root.removeEventListener('dblclick', onDoubleClick);
      layers.root.removeEventListener('contextmenu', onContextMenu);
      layers.root.removeEventListener('keydown', onKeyDown);
      contextMenu.destroy();
      tooltip.destroy();
      inspector.destroy();
      aria.destroy();
      layers.destroy();
    },
  };
}
