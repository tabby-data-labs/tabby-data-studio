/**
 * Paint draw-order assertions against a recording mock context (GRID-SPEC §4).
 *
 * The order is load-bearing: text drawn before its background disappears, and an
 * unbalanced save/restore leaks a clip region into every subsequent frame.
 */
import { describe, expect, it } from 'vitest';
import { BlockCache } from '@/grid/block-cache';
import { computeGeometry } from '@/grid/layout';
import {
  paintBody,
  paintColHeader,
  paintCorner,
  paintOverlay,
  paintRowHeader,
  type PaintInput,
} from '@/grid/paint';
import { TextMetricsCache } from '@/grid/text-metrics';
import { EMPTY_SELECTION, reduceSelection } from '@/grid/selection';
import type { CellValue, ColumnMeta, GridTheme, RowBlock } from '@/grid/types';
import {
  countCalls,
  createRecordingCtx,
  drawnText,
  firstIndex,
  methodOrder,
  saveRestoreBalance,
} from './helpers/recording-ctx';

const THEME: GridTheme = {
  background: '#030b16',
  stripe: '#0a1626',
  gridline: '#1c3a5e',
  text: '#e6edf7',
  muted: '#8ba0bb',
  headerBackground: '#0a1626',
  headerText: '#e6edf7',
  headerBorder: '#1c3a5e',
  selectionFill: 'rgba(59,118,240,0.25)',
  selectionStroke: '#3b76f0',
  activeHandle: '#3b76f0',
  frozenShadow: '#000000',
  placeholder: '#1c3a5e',
  cellFont: '12px mono',
  headerFont: 'bold 12px mono',
  headerSubFont: '10px mono',
  cellPaddingX: 8,
  rowHeight: 22,
  headerHeight: 30,
  rowHeaderWidth: 50,
};

const COLUMNS: readonly ColumnMeta[] = [
  { name: 'id', typeName: 'int8', typeOid: 20, nullable: false, widthHint: 90 },
  { name: 'label', typeName: 'text', typeOid: 25, nullable: true, widthHint: 140 },
  { name: 'created_at', typeName: 'timestamptz', typeOid: 1184, nullable: false, widthHint: 180 },
];

const TEXT = (value: string): CellValue => ({ kind: 'text', value });

function filledCache(rows: number, cols: number): BlockCache {
  const cache = new BlockCache({ blockSize: 200 });
  const columns: CellValue[][] = [];
  for (let c = 0; c < cols; c += 1) {
    columns.push(Array.from({ length: rows }, (_unused, r) => TEXT(`v${r}-${c}`)));
  }
  const block: RowBlock = { startRow: 0, rowCount: rows, columns };
  cache.put(block);
  return cache;
}

function makeInput(options: {
  rowCount?: number;
  frozen?: number;
  scrollLeft?: number;
  scrollTop?: number;
  cache?: BlockCache;
  viewport?: { width: number; height: number };
  selection?: ReturnType<typeof reduceSelection>;
}): { input: PaintInput; calls: ReturnType<typeof createRecordingCtx>['calls'] } {
  const viewport = options.viewport ?? { width: 750, height: 570 };
  const rowCount = options.rowCount ?? 1000;
  const geometry = computeGeometry({
    columns: COLUMNS.map((c) => ({ width: c.widthHint, visible: true })),
    rowCount,
    rowHeight: THEME.rowHeight,
    headerHeight: THEME.headerHeight,
    rowHeaderWidth: THEME.rowHeaderWidth,
    frozenColumnCount: options.frozen ?? 0,
    scrollTop: options.scrollTop ?? 0,
    scrollLeft: options.scrollLeft ?? 0,
    viewportWidth: viewport.width + THEME.rowHeaderWidth,
    viewportHeight: viewport.height + THEME.headerHeight,
    overscan: 0,
  });

  const recording = createRecordingCtx();
  const input: PaintInput = {
    ctx: recording.ctx,
    geometry,
    columns: COLUMNS,
    cache: options.cache ?? filledCache(Math.min(rowCount, 200), COLUMNS.length),
    theme: THEME,
    selection: options.selection ?? EMPTY_SELECTION,
    metrics: new TextMetricsCache(),
    sort: null,
    width: viewport.width,
    height: viewport.height,
  };
  return { input, calls: recording.calls };
}

describe('paintBody draw order', () => {
  it('clears and fills the background before drawing anything else', () => {
    const { input, calls } = makeInput({});
    paintBody(input);
    const order = methodOrder(calls);
    expect(order[0]).toBe('clearRect');
    expect(order[1]).toBe('fillRect');
    expect(firstIndex(calls, 'fillText')).toBeGreaterThan(firstIndex(calls, 'fillRect'));
  });

  it('draws stripes before cell text', () => {
    const { input, calls } = makeInput({});
    paintBody(input);
    const stripes = calls.filter((c) => c.method === 'fillRect');
    expect(stripes.length).toBeGreaterThan(0);
    expect(firstIndex(calls, 'fillText')).toBeGreaterThan(firstIndex(calls, 'fillRect'));
  });

  it('balances every save with a restore', () => {
    for (const frozen of [0, 1, 2]) {
      const { input, calls } = makeInput({ frozen });
      paintBody(input);
      expect(saveRestoreBalance(calls), `frozen=${frozen}`).toBe(0);
    }
  });

  it('paints one text run per visible cell that has data', () => {
    const { input, calls } = makeInput({ rowCount: 1000 });
    paintBody(input);
    const expected = input.geometry.visibleRows.length * input.geometry.visibleCols.length;
    expect(countCalls(calls, 'fillText')).toBe(expected);
  });

  it('paints no text at all for an empty result', () => {
    const { input, calls } = makeInput({ rowCount: 0 });
    paintBody(input);
    expect(input.geometry.visibleRows).toHaveLength(0);
    expect(countCalls(calls, 'fillText')).toBe(0);
  });

  it('clips the frozen and scrollable bands separately', () => {
    // No frozen band -> a single clip region for the whole body.
    const withoutFrozen = makeInput({ frozen: 0 });
    paintBody(withoutFrozen.input);
    expect(countCalls(withoutFrozen.calls, 'clip')).toBe(1);

    // A frozen band needs its own clip so scrollable columns sliding underneath
    // are covered rather than blended.
    const withFrozen = makeInput({ frozen: 1 });
    paintBody(withFrozen.input);
    expect(countCalls(withFrozen.calls, 'clip')).toBe(2);
  });

  it('adds selection clips only when something is selected', () => {
    const selection = reduceSelection(
      EMPTY_SELECTION,
      { type: 'click', row: 2, col: 1, shift: false, meta: false },
      { rowCount: 1000, colCount: 3 },
    );

    const unfrozen = makeInput({ selection });
    paintBody(unfrozen.input);
    // 1 cell band + 1 selection band (the empty frozen band short-circuits)
    expect(countCalls(unfrozen.calls, 'clip')).toBe(2);

    const frozen = makeInput({ selection, frozen: 1 });
    paintBody(frozen.input);
    // 2 cell bands + 2 selection bands
    expect(countCalls(frozen.calls, 'clip')).toBe(4);
    expect(countCalls(frozen.calls, 'strokeRect')).toBeGreaterThan(0);
  });

  it('draws no selection clip at all when nothing is selected', () => {
    const { input, calls } = makeInput({ frozen: 1 });
    paintBody(input);
    expect(countCalls(calls, 'strokeRect')).toBe(0);
  });

  it('draws the frozen shadow only while scrolled', () => {
    // A 200px-wide body with a 90px frozen band leaves 110px for 320px of
    // scrollable content, so there is real room to scroll.
    const narrow = { width: 200, height: 570 };

    const atRest = makeInput({ frozen: 1, scrollLeft: 0, viewport: narrow });
    paintBody(atRest.input);
    expect(atRest.input.geometry.maxScrollLeft).toBeGreaterThan(0);
    const restAlphas = atRest.calls
      .filter((c) => c.method === 'set:globalAlpha')
      .map((c) => c.args[0]);
    expect(restAlphas.every((a) => a === 1)).toBe(true);

    const scrolled = makeInput({ frozen: 1, scrollLeft: 120, viewport: narrow });
    paintBody(scrolled.input);
    expect(scrolled.input.geometry.scrollLeft).toBe(120);
    const scrollAlphas = scrolled.calls
      .filter((c) => c.method === 'set:globalAlpha')
      .map((c) => c.args[0]);
    expect(scrollAlphas.some((a) => typeof a === 'number' && a < 1)).toBe(true);
  });

  it('draws no shadow when nothing is frozen, however far scrolled', () => {
    const { input, calls } = makeInput({
      frozen: 0,
      scrollLeft: 200,
      viewport: { width: 200, height: 570 },
    });
    paintBody(input);
    expect(input.geometry.scrollLeft).toBe(200);
    const alphas = calls.filter((c) => c.method === 'set:globalAlpha').map((c) => c.args[0]);
    expect(alphas.every((a) => a === 1)).toBe(true);
  });
});

describe('paintBody placeholders', () => {
  it('draws a skeleton bar and no text for rows that have not arrived', () => {
    const cache = new BlockCache({ blockSize: 200 });
    const { input, calls } = makeInput({ rowCount: 1000, cache, scrollTop: 5000 });
    paintBody(input);
    expect(countCalls(calls, 'fillText')).toBe(0);
    // one skeleton bar per visible cell
    const expected = input.geometry.visibleRows.length * input.geometry.visibleCols.length;
    // background + stripes + skeletons
    expect(countCalls(calls, 'fillRect')).toBeGreaterThanOrEqual(expected);
  });

  it('mixes placeholders and text when only part of the window is cached', () => {
    const cache = new BlockCache({ blockSize: 200 });
    cache.put({
      startRow: 0,
      rowCount: 200,
      columns: COLUMNS.map(() => Array.from({ length: 200 }, (_u, r) => TEXT(`v${r}`))),
    });
    const { input, calls } = makeInput({ rowCount: 1000, cache });
    paintBody(input);
    expect(countCalls(calls, 'fillText')).toBeGreaterThan(0);
  });
});

describe('type-aware styling', () => {
  /** One column of cells, so the assertions stay readable. */
  function singleColumn(cells: readonly CellValue[]): BlockCache {
    const cache = new BlockCache({ blockSize: 200 });
    cache.put({ startRow: 0, rowCount: cells.length, columns: [cells] });
    return cache;
  }

  it('renders NULL in an italic font and the muted colour', () => {
    const cache = singleColumn([TEXT('a'), { kind: 'null' }, TEXT('b')]);
    const { input, calls } = makeInput({ rowCount: 3, cache });
    paintBody(input);

    const fonts = calls.filter((c) => c.method === 'set:font').map((c) => String(c.args[0]));
    expect(fonts).toContain(`italic ${THEME.cellFont}`);
    expect(fonts).toContain(THEME.cellFont);

    const fills = calls.filter((c) => c.method === 'set:fillStyle').map((c) => String(c.args[0]));
    expect(fills).toContain(THEME.muted);
    expect(fills).toContain(THEME.text);
  });

  it('does not reassign the font when consecutive cells share a style', () => {
    const cache = singleColumn([TEXT('a'), TEXT('b'), TEXT('c')]);
    const { input, calls } = makeInput({ rowCount: 3, cache });
    paintBody(input);

    // One assignment establishes the cell font; there is no per-cell churn.
    const fontSets = calls.filter((c) => c.method === 'set:font' && c.args[0] === THEME.cellFont);
    expect(fontSets).toHaveLength(1);
  });

  it('right-aligns numbers, centres booleans, left-aligns text', () => {
    const cache = singleColumn([
      { kind: 'number', value: 42, raw: '42' },
      { kind: 'bool', value: true },
      TEXT('left'),
    ]);
    const { input, calls } = makeInput({ rowCount: 3, cache });
    paintBody(input);

    const aligns = calls.filter((c) => c.method === 'set:textAlign').map((c) => c.args[0]);
    expect(aligns).toContain('right');
    expect(aligns).toContain('center');
    expect(aligns).toContain('left');
  });

  it('draws a skeleton bar, never a value, for an unloaded cell', () => {
    const cache = new BlockCache({ blockSize: 200 });
    const { input, calls } = makeInput({ rowCount: 5, cache });
    paintBody(input);
    expect(countCalls(calls, 'fillText')).toBe(0);
    expect(countCalls(calls, 'fillRect')).toBeGreaterThan(0);
  });
});

describe('paintColHeader', () => {
  it('draws the column name and, when tall enough, its type', () => {
    const { input, calls } = makeInput({});
    paintColHeader(input);
    const text = drawnText(calls);
    for (const column of COLUMNS) {
      expect(text).toContain(column.name);
      expect(text).toContain(column.typeName);
    }
    expect(saveRestoreBalance(calls)).toBe(0);
  });

  it('drops the type line when the header is too short', () => {
    const { input, calls } = makeInput({});
    paintColHeader({ ...input, height: 24 });
    const text = drawnText(calls);
    expect(text).toContain('id');
    expect(text).not.toContain('int8');
  });

  it('draws nothing beyond the background when there are no columns', () => {
    const { input, calls } = makeInput({ rowCount: 10 });
    paintColHeader({
      ...input,
      geometry: computeGeometry({
        columns: [],
        rowCount: 10,
        rowHeight: 22,
        headerHeight: 30,
        rowHeaderWidth: 50,
        frozenColumnCount: 0,
        scrollTop: 0,
        scrollLeft: 0,
        viewportWidth: 800,
        viewportHeight: 600,
      }),
    });
    expect(countCalls(calls, 'fillText')).toBe(0);
  });
});

describe('paintRowHeader', () => {
  it('labels rows from 1, not 0', () => {
    const { input, calls } = makeInput({});
    paintRowHeader(input);
    const text = drawnText(calls);
    expect(text[0]).toBe('1');
    expect(text).not.toContain('0');
    expect(saveRestoreBalance(calls)).toBe(0);
  });

  it('labels the first visible row after scrolling', () => {
    const { input, calls } = makeInput({ scrollTop: 220 });
    paintRowHeader(input);
    // floor(220/22) = 10 -> label 11
    expect(drawnText(calls)[0]).toBe('11');
  });
});

describe('paintCorner and paintOverlay', () => {
  it('paints the corner without text', () => {
    const { input, calls } = makeInput({});
    paintCorner({ ...input, width: 50, height: 30 });
    expect(countCalls(calls, 'fillText')).toBe(0);
    expect(countCalls(calls, 'fillRect')).toBeGreaterThan(0);
  });

  it('clears only when there is no resize guide', () => {
    const { ctx, calls } = createRecordingCtx();
    paintOverlay(ctx, 750, 570, { resizeGuideX: null });
    expect(methodOrder(calls)).toEqual(['clearRect']);
  });

  it('draws a vertical guide while resizing', () => {
    const { ctx, calls } = createRecordingCtx();
    paintOverlay(ctx, 750, 570, { resizeGuideX: 123.4 });
    expect(methodOrder(calls)).toEqual(['clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke']);
    const moveTo = calls.find((c) => c.method === 'moveTo');
    // Math.round(123.4) + 0.5: snapped to a half-pixel so a 1px line is crisp
    // instead of being blurred across two device pixels.
    expect(moveTo?.args[0]).toBe(123.5);
    expect(moveTo?.args[1]).toBe(0);
  });
});
