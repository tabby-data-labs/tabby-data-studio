/**
 * Column view state: widths, visibility, frozen count, auto-fit and resize
 * handle hit-testing. Pure apart from the measurement collaborator.
 */
import { describe, expect, it } from 'vitest';
import { ColumnController } from '@/grid/columns';
import { computeGeometry } from '@/grid/layout';
import type { ColumnMeta } from '@/grid/types';

const COLUMNS: readonly ColumnMeta[] = [
  { name: 'id', typeName: 'int8', typeOid: 20, nullable: false, widthHint: 90 },
  { name: 'label', typeName: 'text', typeOid: 25, nullable: true, widthHint: 20 },
  { name: 'note', typeName: 'text', typeOid: 25, nullable: true, widthHint: 4000 },
  { name: 'payload', typeName: 'jsonb', typeOid: 3807, nullable: false, widthHint: 0 },
];

function make(overrides: Partial<ConstructorParameters<typeof ColumnController>[0]> = {}) {
  return new ColumnController({ columns: COLUMNS, ...overrides });
}

/** Uniform 6px glyph, matching the monospace fast path. */
const measureCtx = {
  font: '12px mono',
  measureText: (text: string) => ({ width: text.length * 6 }),
};
const measure = (_ctx: typeof measureCtx, text: string): number => text.length * 6;

describe('initial widths', () => {
  it('takes each width from the column hint', () => {
    const columns = make();
    expect(columns.width(0)).toBe(90);
    expect(columns.specs()[0]).toEqual({ width: 90, visible: true });
  });

  it('clamps a hint below the minimum up to it', () => {
    expect(make().width(1)).toBe(40);
  });

  it('clamps an absurd hint down to the maximum', () => {
    expect(make().width(2)).toBe(800);
  });

  it('substitutes a default for a zero or negative hint', () => {
    expect(make().width(3)).toBe(120);
  });

  it('honours custom bounds', () => {
    const columns = make({ minWidth: 60, maxWidth: 300 });
    expect(columns.width(1)).toBe(60);
    expect(columns.width(2)).toBe(300);
  });
});

describe('mutating widths', () => {
  it('clamps setWidth into range', () => {
    const columns = make();
    columns.setWidth(0, 5);
    expect(columns.width(0)).toBe(40);
    columns.setWidth(0, 100_000);
    expect(columns.width(0)).toBe(800);
    columns.setWidth(0, 150);
    expect(columns.width(0)).toBe(150);
  });

  it('applies resizeBy relative to the current width', () => {
    const columns = make();
    columns.resizeBy(0, 30);
    expect(columns.width(0)).toBe(120);
    columns.resizeBy(0, -1000);
    expect(columns.width(0)).toBe(40);
  });

  it('ignores an out-of-range column index instead of throwing', () => {
    const columns = make();
    expect(() => columns.setWidth(99, 100)).not.toThrow();
    expect(() => columns.setWidth(-1, 100)).not.toThrow();
    expect(columns.count).toBe(4);
  });

  it('tolerates a non-finite width', () => {
    const columns = make();
    columns.setWidth(0, Number.NaN);
    expect(columns.width(0)).toBe(40);
    columns.setWidth(0, Number.POSITIVE_INFINITY);
    expect(columns.width(0)).toBe(800);
  });
});

describe('visibility and frozen count', () => {
  it('starts fully visible with nothing frozen', () => {
    const columns = make();
    expect(columns.visibleCount).toBe(4);
    expect(columns.frozenColumnCount).toBe(0);
  });

  it('clamps the frozen count to the number of visible columns', () => {
    const columns = make();
    columns.setFrozenColumnCount(99);
    expect(columns.frozenColumnCount).toBe(4);
    columns.setFrozenColumnCount(-3);
    expect(columns.frozenColumnCount).toBe(0);
  });

  it('drops the frozen count when a frozen column is hidden', () => {
    const columns = make();
    columns.setFrozenColumnCount(3);
    columns.setVisible(0, false);
    expect(columns.visibleCount).toBe(3);
    expect(columns.frozenColumnCount).toBe(3);
    columns.setVisible(1, false);
    expect(columns.frozenColumnCount).toBe(2);
  });

  it('reports hidden columns in specs so layout gives them zero width', () => {
    const columns = make();
    columns.setVisible(1, false);
    // width is still the clamped hint (20 -> minWidth 40); layout is what turns
    // `visible: false` into zero on-screen width.
    expect(columns.specs()[1]).toEqual({ width: 40, visible: false });
    expect(columns.isVisible(1)).toBe(false);
    expect(columns.isVisible(0)).toBe(true);
  });

  it('reports an out-of-range index as not visible', () => {
    expect(make().isVisible(99)).toBe(false);
  });
});

describe('autoFit', () => {
  it('sizes to the widest sample plus padding and caret room', () => {
    const columns = make();
    columns.autoFit(0, ['a', 'bbbbbbbbbb', 'ccc'], measureCtx, measure, 'id', 8);
    // widest sample is 10 chars = 60px; + 8*2 padding + 12 caret
    expect(columns.width(0)).toBe(60 + 16 + 12);
  });

  it('never shrinks below the header width', () => {
    const columns = make();
    columns.autoFit(0, ['a'], measureCtx, measure, 'a-very-long-column-name', 8);
    expect(columns.width(0)).toBe(23 * 6 + 16 + 12);
  });

  it('handles no samples at all', () => {
    const columns = make();
    columns.autoFit(0, [], measureCtx, measure, 'id', 8);
    expect(columns.width(0)).toBe(2 * 6 + 16 + 12);
  });

  it('clamps the fitted width to the maximum', () => {
    const columns = make();
    columns.autoFit(0, ['x'.repeat(500)], measureCtx, measure, 'id', 8);
    expect(columns.width(0)).toBe(800);
  });

  it('ignores an out-of-range column', () => {
    const columns = make();
    expect(() => columns.autoFit(42, ['a'], measureCtx, measure, 'x', 8)).not.toThrow();
  });
});

describe('resize handle hit-testing', () => {
  const geometry = () =>
    computeGeometry({
      columns: make().specs(),
      rowCount: 100,
      rowHeight: 22,
      headerHeight: 34,
      rowHeaderWidth: 56,
      frozenColumnCount: 0,
      scrollTop: 0,
      scrollLeft: 0,
      viewportWidth: 900,
      viewportHeight: 600,
    });

  it('hits a handle within tolerance of a column border', () => {
    const g = geometry();
    const firstBorder = g.originX + 90;
    expect(make().hitResizeHandle(firstBorder + 2, 10, g, 34)?.col).toBe(0);
    expect(make().hitResizeHandle(firstBorder - 4, 10, g, 34)?.col).toBe(0);
  });

  it('misses when far from any border', () => {
    const g = geometry();
    expect(make().hitResizeHandle(g.originX + 45, 10, g, 34)).toBeNull();
  });

  it('misses below the header, where borders belong to cells', () => {
    const g = geometry();
    const firstBorder = g.originX + 90;
    expect(make().hitResizeHandle(firstBorder, 100, g, 34)).toBeNull();
  });

  it('accounts for the row-header origin', () => {
    const g = geometry();
    // 90px from the body origin, not from the host edge
    expect(make().hitResizeHandle(90, 10, g, 34)).toBeNull();
    expect(make().hitResizeHandle(g.originX + 90, 10, g, 34)?.col).toBe(0);
  });
});
