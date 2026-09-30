// @vitest-environment happy-dom
/**
 * GRID-SPEC §10: the ARIA proxy grid.
 *
 * A canvas exposes nothing to assistive tech, so this subtree is the only thing
 * a screen reader can see. The `aria-rowindex` arithmetic is the part that
 * silently breaks: get it wrong and VoiceOver confidently announces the wrong
 * row of a 10M-row result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AriaProxy, type AriaUpdate } from '@/grid/aria';
import type { ColumnMeta } from '@/grid/types';

const COLUMNS: readonly ColumnMeta[] = [
  { name: 'id', typeName: 'int8', typeOid: 20, nullable: false, widthHint: 80 },
  { name: 'name', typeName: 'text', typeOid: 25, nullable: true, widthHint: 120 },
];

let container: HTMLElement;
let proxy: AriaProxy;

function update(overrides: Partial<AriaUpdate> = {}): AriaUpdate {
  const state: AriaUpdate = {
    rowCount: 1_000_000,
    colCount: COLUMNS.length,
    columns: COLUMNS,
    visibleRows: [0, 1, 2],
    active: { row: 0, col: 0 },
    isSelected: () => false,
    cellText: (row, col) => `r${row}c${col}`,
    ...overrides,
  };
  proxy.update(state);
  return state;
}

function dataRows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="row"][data-kind="data"]'));
}

function headers(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="columnheader"]'));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  proxy = new AriaProxy({ container, label: 'Query result', announceThrottleMs: 150 });
});

afterEach(() => {
  proxy.destroy();
  container.remove();
  vi.useRealTimers();
});

describe('grid attributes', () => {
  it('exposes a labelled grid role', () => {
    update();
    const grid = container.querySelector('[role="grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.getAttribute('aria-label')).toBe('Query result');
  });

  it('reports true totals, not the mirrored window', () => {
    update({ rowCount: 1_000_000 });
    const grid = container.querySelector('[role="grid"]');
    // +1 because the header row occupies aria-rowindex 1
    expect(grid?.getAttribute('aria-rowcount')).toBe('1000001');
    expect(grid?.getAttribute('aria-colcount')).toBe('2');
  });

  it('updates the totals when the result changes', () => {
    update({ rowCount: 10 });
    expect(container.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')).toBe('11');
    update({ rowCount: 500 });
    expect(container.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')).toBe('501');
  });

  it('is visually hidden but never aria-hidden', () => {
    update();
    const grid = container.querySelector<HTMLElement>('[role="grid"]');
    expect(grid?.getAttribute('aria-hidden')).toBeNull();
    expect(grid?.style.position).toBe('absolute');
    expect(grid?.style.width).toBe('1px');
  });

  it('handles an empty result', () => {
    update({ rowCount: 0, visibleRows: [], active: { row: 0, col: 0 } });
    expect(container.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')).toBe('1');
  });
});

describe('header row', () => {
  it('is the first row and carries one columnheader per column', () => {
    update();
    const header = container.querySelector<HTMLElement>('[role="row"][aria-rowindex="1"]');
    expect(header).not.toBeNull();
    expect(headers()).toHaveLength(2);
    expect(header?.contains(headers()[0]!)).toBe(true);
  });

  it('gives each header a 1-based aria-colindex and a readable name', () => {
    update();
    expect(headers()[0]?.getAttribute('aria-colindex')).toBe('1');
    expect(headers()[1]?.getAttribute('aria-colindex')).toBe('2');
    expect(headers()[0]?.textContent).toBe('id (int8)');
  });

  it('is not rebuilt when the column set is unchanged', () => {
    update();
    const before = headers()[0];
    update({ visibleRows: [5, 6, 7], active: { row: 5, col: 0 } });
    // Same element identity means no accessibility-tree churn.
    expect(headers()[0]).toBe(before);
  });

  it('is rebuilt when columns change', () => {
    update();
    const before = headers()[0];
    update({
      columns: [{ name: 'other', typeName: 'text', typeOid: 25, nullable: false, widthHint: 80 }],
      colCount: 1,
    });
    expect(headers()[0]).not.toBe(before);
    expect(headers()[0]?.textContent).toBe('other (text)');
  });
});

describe('data row indexing', () => {
  it('offsets data rows by two: one for 1-based, one for the header', () => {
    update({ visibleRows: [0, 1, 2], active: { row: 0, col: 0 } });
    expect(dataRows().map((row) => row.getAttribute('aria-rowindex'))).toEqual(['2', '3', '4']);
  });

  it('reports absolute indices after scrolling deep into the result', () => {
    update({ visibleRows: [812_343, 812_344], active: { row: 812_343, col: 0 } });
    expect(dataRows().map((row) => row.getAttribute('aria-rowindex'))).toEqual([
      '812345',
      '812346',
    ]);
  });

  it('mirrors only the visible window, not the whole result', () => {
    update({ visibleRows: [10, 11, 12, 13], active: { row: 10, col: 0 } });
    expect(dataRows()).toHaveLength(4);
  });

  it('renders one gridcell per column with a 1-based colindex', () => {
    update({ visibleRows: [0], active: { row: 0, col: 0 } });
    const cells = Array.from(dataRows()[0]!.querySelectorAll('[role="gridcell"]'));
    expect(cells).toHaveLength(2);
    expect(cells[0]?.getAttribute('aria-colindex')).toBe('1');
    expect(cells[1]?.getAttribute('aria-colindex')).toBe('2');
    expect(cells[0]?.textContent).toBe('r0c0');
  });

  it('appends the active row when it has scrolled out of the window', () => {
    update({ visibleRows: [50, 51, 52], active: { row: 3, col: 1 } });
    const indices = dataRows().map((row) => row.getAttribute('aria-rowindex'));
    // rows 50,51,52 -> 52,53,54, plus the active row 3 -> 5
    expect(indices).toEqual(['52', '53', '54', '5']);
  });

  it('does not duplicate the active row when it is already visible', () => {
    update({ visibleRows: [50, 51, 52], active: { row: 51, col: 0 } });
    expect(dataRows()).toHaveLength(3);
  });

  it('shrinks the mirror when the window gets smaller', () => {
    update({ visibleRows: [0, 1, 2, 3, 4], active: { row: 0, col: 0 } });
    expect(dataRows()).toHaveLength(5);
    update({ visibleRows: [0], active: { row: 0, col: 0 } });
    expect(dataRows()).toHaveLength(1);
  });

  it('marks selected cells', () => {
    update({
      visibleRows: [0],
      active: { row: 0, col: 0 },
      isSelected: (row, col) => row === 0 && col === 1,
    });
    const cells = Array.from(dataRows()[0]!.querySelectorAll('[role="gridcell"]'));
    expect(cells[0]?.getAttribute('aria-selected')).toBeNull();
    expect(cells[1]?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('live region', () => {
  it('exists, is polite and atomic', () => {
    const live = container.querySelector('[role="status"]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.getAttribute('aria-atomic')).toBe('true');
  });

  it('announces immediately when idle', () => {
    proxy.announce('Row 1, column id, 42');
    expect(proxy.live.textContent).toBe('Row 1, column id, 42');
  });

  it('does not repeat an identical announcement', () => {
    proxy.announce('same');
    proxy.live.textContent = '';
    proxy.announce('same');
    expect(proxy.live.textContent).toBe('');
  });

  it('throttles a burst of announcements down to the last one', () => {
    vi.useFakeTimers();
    const fresh = new AriaProxy({ container, label: 'x', announceThrottleMs: 150 });

    fresh.announce('first');
    expect(fresh.live.textContent).toBe('first');

    // Key repeat: many announcements inside the throttle window.
    for (let i = 0; i < 20; i += 1) fresh.announce(`row ${i}`);
    // Nothing has been written yet beyond the first.
    expect(fresh.live.textContent).toBe('first');

    vi.advanceTimersByTime(200);
    expect(fresh.live.textContent).toBe('row 19');
    fresh.destroy();
  });

  it('announces again immediately once the throttle window has passed', () => {
    vi.useFakeTimers();
    const fresh = new AriaProxy({ container, label: 'x', announceThrottleMs: 100 });
    fresh.announce('a');
    vi.advanceTimersByTime(150);
    fresh.announce('b');
    expect(fresh.live.textContent).toBe('b');
    fresh.destroy();
  });
});

describe('focus wiring and teardown', () => {
  it('links a focus element to the proxy with aria-describedby', () => {
    const target = document.createElement('div');
    proxy.describeFocusElement(target);
    expect(target.getAttribute('aria-describedby')).toBe(proxy.grid.id);
    expect(proxy.grid.id).not.toBe('');
  });

  it('gives each instance a distinct id', () => {
    const other = new AriaProxy({ container, label: 'second' });
    expect(other.grid.id).not.toBe(proxy.grid.id);
    other.destroy();
  });

  it('removes both subtrees on destroy', () => {
    proxy.destroy();
    expect(container.querySelector('[role="grid"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('is safe to destroy twice', () => {
    proxy.destroy();
    expect(() => proxy.destroy()).not.toThrow();
  });
});
