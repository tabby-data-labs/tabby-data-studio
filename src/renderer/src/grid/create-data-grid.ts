import { BlockCache } from './block-cache';
import { CanvasLayers } from './canvas-layers';
import { cellText } from './cell-format';
import { ColumnController } from './columns';
import { DataWindowController } from './data-window';
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
import { EMPTY_SELECTION, reduceSelection } from './selection';
import { ScrollController, scrollOffsetFromThumb, thumbGeometry, type ScrollAlign } from './scroll';
import { TextMetricsCache } from './text-metrics';
import { DARK_THEME } from './theme';
import type {
  CellRef,
  DataSource,
  GridTheme,
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
  readonly onSelectionChange?: (selection: SelectionState) => void;
  readonly onCellActivate?: (cell: CellRef) => void;
  readonly onColumnResize?: (col: number, width: number) => void;
  readonly onSort?: (col: number, direction: SortDirection | null) => void;
}

export interface DataGrid {
  invalidate(): void;
  resize(): void;
  scrollToRow(row: number, align?: ScrollAlign): void;
  scrollToCell(row: number, col: number): void;
  getSelection(): SelectionState;
  setSelection(selection: SelectionState): void;
  copy(): Promise<void>;
  setFrozenColumnCount(count: number): void;
  setColumnWidth(col: number, width: number): void;
  autoFitColumn(col: number): void;
  setSort(sort: SortSpec | null): Promise<void>;
  updateTheme(theme: Partial<GridTheme>): void;
  /** Frame statistics for the benchmark overlay. */
  stats(): ReturnType<RenderLoop['stats']>;
  resetStats(): void;
  destroy(): void;
}

const SCROLLBAR_SIZE = 12;
const AUTOFIT_SAMPLE_ROWS = 200;

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

  // ── Live region ────────────────────────────────────────────────────────────
  // A canvas exposes nothing to assistive tech. The full ARIA proxy grid is a
  // Phase 2 deliverable (GRID-SPEC §10); this announces selection meanwhile.
  const live = document.createElement('div');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.className = 'sr-only';
  Object.assign(live.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  });
  layers.root.appendChild(live);
  layers.root.setAttribute('aria-label', options.a11y?.label ?? 'Data grid');

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

    const measured = metrics.stats;
    loop.recordMeasureText(measured.lookups, measured.misses);
  }

  // ── Selection plumbing ─────────────────────────────────────────────────────
  function bounds(): { rowCount: number; colCount: number } {
    return { rowCount: source.rowCount, colCount: columns.count };
  }

  function applySelection(next: SelectionState, announce = true): void {
    selection = next;
    options.onSelectionChange?.(next);
    if (announce) {
      const { row, col } = next.active;
      const name = source.columns[col]?.name ?? `column ${col}`;
      const cell = cache.get(row, col);
      const value = cell ? cellText(cell).text : '';
      live.textContent = `Row ${row + 1}, column ${name}${value ? `, ${value}` : ''}`;
    }
    options.onCellActivate?.(next.active);
    loop.invalidate();
  }

  function dispatch(event: Parameters<typeof reduceSelection>[1]): void {
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
    if (!drag || drag.pointerId !== event.pointerId) return;
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

  function onDoubleClick(event: MouseEvent): void {
    const { x, y } = localPoint(event);
    const handle = columns.hitResizeHandle(x, y, geometry, theme.headerHeight);
    if (handle) {
      autoFit(handle.col);
      options.onColumnResize?.(handle.col, columns.width(handle.col));
      loop.invalidate();
    }
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

  // ── Wiring ─────────────────────────────────────────────────────────────────
  layers.root.addEventListener('pointerdown', onPointerDown);
  layers.root.addEventListener('pointermove', onPointerMove);
  layers.root.addEventListener('pointerup', onPointerUp);
  layers.root.addEventListener('pointercancel', onPointerUp);
  layers.root.addEventListener('dblclick', onDoubleClick);
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

  measureViewport();
  geometry = compute();
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

    copy: async () => {
      // TSV only in Phase 1: it is what Excel and Sheets paste as a grid.
      // CSV / JSON / SQL INSERT serialisers land in Phase 2 with the rest of
      // the clipboard work.
      const rows: string[] = [];
      for (const range of selection.ranges) {
        const startRow = Math.min(range.anchor.row, range.focus.row);
        const endRow = Math.max(range.anchor.row, range.focus.row);
        const startCol = Math.min(range.anchor.col, range.focus.col);
        const endCol = Math.max(range.anchor.col, range.focus.col);
        for (let row = startRow; row <= endRow; row += 1) {
          const cells: string[] = [];
          for (let col = startCol; col <= endCol; col += 1) {
            const cell = cache.get(row, col);
            cells.push(cell ? cellText(cell).text.replace(/\t/g, ' ') : '');
          }
          rows.push(cells.join('\t'));
        }
      }
      await navigator.clipboard.writeText(rows.join('\r\n'));
    },

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

    setSort: async (next) => {
      sort = next;
      cache.invalidate();
      window_.abortAll();
      await source.sort(next?.columnIndex ?? -1, next?.direction ?? null);
      loop.invalidate();
      if (next) options.onSort?.(next.columnIndex, next.direction);
    },

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
      layers.root.removeEventListener('dblclick', onDoubleClick);
      layers.destroy();
    },
  };
}
