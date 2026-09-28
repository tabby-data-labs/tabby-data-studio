/**
 * GRID-SPEC §3: coordinate system and layout math.
 *
 * Every expectation below is hand-computed from the spec, not read off an
 * implementation. Reference fixture used throughout:
 *
 *   rowHeight 22, headerHeight 30, rowHeaderWidth 50, viewport 800x600
 *   => originX 50, originY 30, bodyWidthPx 750, bodyHeightPx 570
 */
import { describe, expect, it } from 'vitest';
import { computeGeometry, type GeometryInput } from '@/grid/layout';
import type { ColumnSpec } from '@/grid/types';

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 30;
const ROW_HEADER_WIDTH = 50;

/** 5 columns; with frozenColumnCount 2 the frozen band is 200px wide. */
const WIDE: readonly ColumnSpec[] = [
  { width: 120, visible: true },
  { width: 80, visible: true },
  { width: 400, visible: true },
  { width: 300, visible: true },
  { width: 250, visible: true },
];

/** Content narrower than the viewport, so a right-hand gap exists. */
const NARROW: readonly ColumnSpec[] = [
  { width: 100, visible: true },
  { width: 100, visible: true },
];

function input(overrides: Partial<GeometryInput> = {}): GeometryInput {
  return {
    columns: WIDE,
    rowCount: 1_000_000,
    rowHeight: ROW_HEIGHT,
    headerHeight: HEADER_HEIGHT,
    rowHeaderWidth: ROW_HEADER_WIDTH,
    frozenColumnCount: 0,
    scrollTop: 0,
    scrollLeft: 0,
    viewportWidth: 800,
    viewportHeight: 600,
    overscan: 0,
    ...overrides,
  };
}

describe('extents and clamping', () => {
  it('computes content and scroll extents from the column widths', () => {
    const g = computeGeometry(input());
    // 120+80+400+300+250
    expect(g.contentWidth).toBe(1150);
    expect(g.contentHeight).toBe(1_000_000 * ROW_HEIGHT);
    expect(g.scrollAreaWidth).toBe(800 - ROW_HEADER_WIDTH);
    expect(g.scrollAreaHeight).toBe(600 - HEADER_HEIGHT);
    expect(g.maxScrollLeft).toBe(1150 - 750);
    expect(g.maxScrollTop).toBe(1_000_000 * ROW_HEIGHT - 570);
  });

  it('reserves frozen width out of the scrollable area', () => {
    const g = computeGeometry(input({ frozenColumnCount: 2 }));
    expect(g.frozenWidth).toBe(200);
    expect(g.scrollAreaWidth).toBe(750 - 200);
    // scrollable content is 400+300+250
    expect(g.maxScrollLeft).toBe(950 - 550);
  });

  it('clamps negative scroll offsets to zero', () => {
    const g = computeGeometry(input({ scrollTop: -500, scrollLeft: -12 }));
    expect(g.scrollTop).toBe(0);
    expect(g.scrollLeft).toBe(0);
    expect(g.firstRow).toBe(0);
    expect(g.rowY(0)).toBe(0);
  });

  it('clamps scroll offsets past the maximum', () => {
    const g = computeGeometry(input({ scrollTop: 1e12, scrollLeft: 1e9 }));
    expect(g.scrollTop).toBe(g.maxScrollTop);
    expect(g.scrollLeft).toBe(g.maxScrollLeft);
    expect(g.lastRow).toBe(999_999);
  });

  it('never produces a negative max scroll when content is smaller than the viewport', () => {
    const g = computeGeometry(input({ columns: NARROW, rowCount: 3 }));
    expect(g.maxScrollLeft).toBe(0);
    // 3 rows * 22 = 66 < 570
    expect(g.maxScrollTop).toBe(0);
  });

  it('stays finite at a 10M-row extent', () => {
    const g = computeGeometry(input({ rowCount: 10_000_000, scrollTop: 219_999_000 }));
    expect(Number.isFinite(g.contentHeight)).toBe(true);
    expect(Number.isFinite(g.maxScrollTop)).toBe(true);
    expect(g.lastRow).toBeLessThan(10_000_000);
  });
});

describe('visible row range', () => {
  it('covers exactly the rows intersecting the body at scrollTop 0', () => {
    const g = computeGeometry(input());
    // row r visible while r*22 < 570 -> r <= 25
    expect(g.firstRow).toBe(0);
    expect(g.lastRow).toBe(25);
    expect(g.visibleRows).toHaveLength(26);
    expect(g.visibleRows[0]).toEqual({ row: 0, y: 0, height: ROW_HEIGHT });
    expect(g.visibleRows[25]).toEqual({ row: 25, y: 25 * ROW_HEIGHT, height: ROW_HEIGHT });
  });

  it('adds overscan rows on both sides, clamped at the start', () => {
    const g = computeGeometry(input({ overscan: 2, scrollTop: 0 }));
    expect(g.firstRow).toBe(0);
    expect(g.lastRow).toBe(27);
  });

  it('adds overscan above the first visible row when scrolled', () => {
    const g = computeGeometry(input({ overscan: 2, scrollTop: 220 }));
    // first intersecting row = floor(220/22) = 10
    expect(g.firstRow).toBe(8);
    expect(g.visibleRows[0]?.row).toBe(8);
  });

  it('handles a fractional scroll offset without dropping the partial row', () => {
    const g = computeGeometry(input({ scrollTop: 100.5 }));
    // floor(100.5/22) = 4
    expect(g.firstRow).toBe(4);
    // 4*22 - 100.5 = -12.5 : the row is partially scrolled off, still drawn
    expect(g.rowY(4)).toBeCloseTo(-12.5, 10);
    expect(g.visibleRows[0]?.y).toBeCloseTo(-12.5, 10);
  });

  it('stops at the last row when scrolled to the bottom', () => {
    const g = computeGeometry(input({ rowCount: 40, scrollTop: 1e9 }));
    expect(g.lastRow).toBe(39);
    expect(g.visibleRows.at(-1)?.row).toBe(39);
  });

  it('returns an empty range for zero rows', () => {
    const g = computeGeometry(input({ rowCount: 0 }));
    expect(g.firstRow).toBe(0);
    expect(g.lastRow).toBe(-1);
    expect(g.visibleRows).toEqual([]);
    expect(g.contentHeight).toBe(0);
  });

  it('returns an empty range when the viewport is shorter than the header', () => {
    const g = computeGeometry(input({ viewportHeight: 20 }));
    expect(g.scrollAreaHeight).toBe(0);
    expect(g.visibleRows).toEqual([]);
    expect(g.lastRow).toBe(-1);
  });
});

describe('visible column range', () => {
  it('includes every column when content fits the viewport', () => {
    const g = computeGeometry(input({ columns: NARROW }));
    expect(g.visibleCols.map((c) => c.col)).toEqual([0, 1]);
    expect(g.firstCol).toBe(0);
    expect(g.lastCol).toBe(1);
  });

  it('excludes columns scrolled out of view', () => {
    const g = computeGeometry(input({ scrollLeft: 100 }));
    // scrollable window in content coords: [100, 850)
    // col0 [0,120) hits, col1 [120,200) hits, col2 [200,600) hits,
    // col3 [600,900) hits, col4 [900,1150) misses
    expect(g.visibleCols.map((c) => c.col)).toEqual([0, 1, 2, 3]);
  });

  it('keeps frozen columns pinned while scrollLeft moves', () => {
    const g = computeGeometry(input({ frozenColumnCount: 2, scrollLeft: 300 }));
    expect(g.colX(0)).toBe(0);
    expect(g.colX(1)).toBe(120);
    // col2 content offset 0 -> 200 + (0 - 300) = -100 (partially scrolled under)
    expect(g.colX(2)).toBe(-100);
    expect(g.colX(3)).toBe(300);
    const frozen = g.visibleCols.filter((c) => c.frozen);
    expect(frozen.map((c) => c.col)).toEqual([0, 1]);
    expect(frozen.every((c) => c.x >= 0)).toBe(true);
  });

  it('clamps frozenColumnCount to the number of visible columns', () => {
    const g = computeGeometry(input({ columns: NARROW, frozenColumnCount: 9 }));
    expect(g.frozenWidth).toBe(200);
    expect(g.visibleCols.every((c) => c.frozen)).toBe(true);
  });

  it('gives hidden columns zero width and excludes them from the visible set', () => {
    const columns: ColumnSpec[] = [
      { width: 100, visible: true },
      { width: 100, visible: false },
      { width: 100, visible: true },
    ];
    const g = computeGeometry(input({ columns }));
    expect(g.contentWidth).toBe(200);
    expect(g.visibleCols.map((c) => c.col)).toEqual([0, 2]);
    // the hidden column collapses to the boundary of the one before it
    expect(g.colX(1)).toBe(100);
    expect(g.colX(2)).toBe(100);
  });

  it('counts frozen slots against visible columns only', () => {
    const columns: ColumnSpec[] = [
      { width: 100, visible: false },
      { width: 50, visible: true },
      { width: 60, visible: true },
      { width: 70, visible: true },
    ];
    const g = computeGeometry(input({ columns, frozenColumnCount: 2 }));
    // frozen = visible cols 1 and 2
    expect(g.frozenWidth).toBe(110);
    expect(g.visibleCols.filter((c) => c.frozen).map((c) => c.col)).toEqual([1, 2]);
  });

  it('returns an empty column set when every column is hidden', () => {
    const columns: ColumnSpec[] = [
      { width: 100, visible: false },
      { width: 100, visible: false },
    ];
    const g = computeGeometry(input({ columns }));
    expect(g.visibleCols).toEqual([]);
    expect(g.firstCol).toBe(0);
    expect(g.lastCol).toBe(-1);
    expect(g.contentWidth).toBe(0);
  });

  it('handles a single column', () => {
    const g = computeGeometry(input({ columns: [{ width: 300, visible: true }], rowCount: 1 }));
    expect(g.visibleCols).toHaveLength(1);
    expect(g.firstCol).toBe(0);
    expect(g.lastCol).toBe(0);
    expect(g.visibleRows).toHaveLength(1);
  });

  it('adds overscan columns at the trailing edge', () => {
    const g = computeGeometry(input({ scrollLeft: 100, overscan: 1 }));
    expect(g.visibleCols.map((c) => c.col)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('hitTest', () => {
  const frozen = computeGeometry(input({ frozenColumnCount: 2, rowCount: 10 }));
  const gap = computeGeometry(input({ columns: NARROW, rowCount: 10 }));

  it('identifies the corner', () => {
    expect(frozen.hitTest(10, 10)).toEqual({ kind: 'corner' });
    // exactly on the boundary belongs to the corner's complement
    expect(frozen.hitTest(49, 29)).toEqual({ kind: 'corner' });
  });

  it('identifies column headers in both the frozen and scrollable bands', () => {
    // localX = 100 - 50 = 50 -> inside frozen col0 [0,120)
    expect(frozen.hitTest(100, 10)).toEqual({ kind: 'colHeader', col: 0 });
    // localX = 180 -> 130 -> frozen col1 [120,200)
    expect(frozen.hitTest(180, 10)).toEqual({ kind: 'colHeader', col: 1 });
    // localX = 300 -> 250 -> scroll offset 50 -> col2 [0,400)
    expect(frozen.hitTest(300, 10)).toEqual({ kind: 'colHeader', col: 2 });
  });

  it('identifies row headers', () => {
    // row = floor((100 - 30 + 0) / 22) = 3
    expect(frozen.hitTest(10, 100)).toEqual({ kind: 'rowHeader', row: 3 });
    expect(frozen.hitTest(49, 30)).toEqual({ kind: 'rowHeader', row: 0 });
  });

  it('identifies cells in the frozen band', () => {
    expect(frozen.hitTest(60, 100)).toEqual({ kind: 'cell', row: 3, col: 0 });
    expect(frozen.hitTest(170, 100)).toEqual({ kind: 'cell', row: 3, col: 1 });
  });

  it('identifies cells in the scrollable band', () => {
    // localX 300 -> 250 -> scroll offset 50 -> col2
    expect(frozen.hitTest(300, 100)).toEqual({ kind: 'cell', row: 3, col: 2 });
    // localX 700 -> 650 -> scroll offset 450 -> col3 [400,700)
    expect(frozen.hitTest(700, 100)).toEqual({ kind: 'cell', row: 3, col: 3 });
  });

  it('accounts for scrollLeft when resolving a cell', () => {
    const scrolled = computeGeometry(
      input({ frozenColumnCount: 2, rowCount: 10, scrollLeft: 300 }),
    );
    // localX = 250 -> scroll offset 250 - 200 + 300 = 350 -> col2 [0,400)
    expect(scrolled.hitTest(300, 100)).toEqual({ kind: 'cell', row: 3, col: 2 });
    // the same pointer at scrollLeft 0 lands one column earlier, proving the
    // mapping really did shift: localX 350 -> offset 150 -> still col2, so use
    // x 400 where the two scroll positions disagree.
    const still = computeGeometry(input({ frozenColumnCount: 2, rowCount: 10 }));
    expect(still.hitTest(400, 100)).toEqual({ kind: 'cell', row: 3, col: 2 });
    expect(scrolled.hitTest(400, 100)).toEqual({ kind: 'cell', row: 3, col: 3 });
  });

  it('accounts for scrollTop when resolving a row', () => {
    const scrolled = computeGeometry(input({ rowCount: 1000, scrollTop: 220 }));
    // row = floor((100 - 30 + 220) / 22) = floor(290/22) = 13
    expect(scrolled.hitTest(60, 100)).toEqual({ kind: 'cell', row: 13, col: 0 });
  });

  it('reports outside for the gap right of the last column', () => {
    // localX 450, content ends at 200
    expect(gap.hitTest(500, 100)).toEqual({ kind: 'outside' });
  });

  it('reports outside for a row past rowCount', () => {
    // row = floor((595 - 30) / 22) = 25, but rowCount is 10
    expect(frozen.hitTest(60, 595)).toEqual({ kind: 'outside' });
  });

  it('reports outside for coordinates beyond the viewport', () => {
    expect(frozen.hitTest(900, 100)).toEqual({ kind: 'outside' });
    expect(frozen.hitTest(60, 700)).toEqual({ kind: 'outside' });
    expect(frozen.hitTest(-5, 100)).toEqual({ kind: 'outside' });
    expect(frozen.hitTest(60, -5)).toEqual({ kind: 'outside' });
  });

  it('reports outside for an empty grid body', () => {
    const empty = computeGeometry(input({ rowCount: 0 }));
    expect(empty.hitTest(60, 100)).toEqual({ kind: 'outside' });
    // the headers still exist
    expect(empty.hitTest(100, 10)).toEqual({ kind: 'colHeader', col: 0 });
  });

  it('resolves pixels under the frozen band to the frozen column covering them', () => {
    // frozen col0 is 120px wide. At scrollLeft 88.5, col2 (content offset 80)
    // lands at x = 120 + 80 - 88.5 = 111.5, so it is partly *under* the band.
    const g = computeGeometry(input({ frozenColumnCount: 1, rowCount: 500, scrollLeft: 88.5 }));
    expect(g.colX(2)).toBe(111.5);
    expect(g.colX(2)).toBeLessThan(g.frozenWidth);
    // x 115 is geometrically inside col2, but the frozen column paints on top,
    // so the pointer belongs to col0. The painter must clip to match.
    expect(g.hitTest(50 + 115, 100)).toEqual({ kind: 'cell', row: 3, col: 0 });
  });

  it('is the exact inverse of colX/rowY for every unoccluded visible cell', () => {
    const g = computeGeometry(
      input({ frozenColumnCount: 1, rowCount: 500, scrollTop: 137.25, scrollLeft: 88.5 }),
    );
    let checked = 0;
    for (const { row } of g.visibleRows) {
      const py = 30 + g.rowY(row) + ROW_HEIGHT / 2;
      // A partially scrolled-off row has its centre under the header, where the
      // header legitimately owns the pixels.
      if (py < 30 || py >= 600) continue;

      for (const { col, x, width, frozen } of g.visibleCols) {
        const left = frozen ? x : Math.max(x, g.frozenWidth);
        const right = x + width;
        if (right - left < 1) continue; // entirely beneath the frozen band
        const px = 50 + (left + right) / 2;
        if (px < 50 || px >= 800) continue;
        expect(g.hitTest(px, py), `row ${row} col ${col}`).toEqual({ kind: 'cell', row, col });
        checked += 1;
      }
    }
    // Guard against the loop silently skipping everything.
    expect(checked).toBeGreaterThan(10);
  });
});
