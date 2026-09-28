/**
 * The windowed cell store the paint pass reads synchronously.
 *
 * Blocks are aligned to a fixed size and evicted LRU, so a 1M-row result never
 * materialises in renderer memory. ARCHITECTURE §5.4, GRID-SPEC §7 (G7).
 */
import { describe, expect, it } from 'vitest';
import { BlockCache } from '@/grid/block-cache';
import type { CellValue, RowBlock } from '@/grid/types';

const CELL = (n: number): CellValue => ({ kind: 'number', value: n, raw: String(n) });

/** Column-major block: columns[c][r]. */
function block(startRow: number, rowCount: number, colCount = 2, base = 0): RowBlock {
  const columns: CellValue[][] = [];
  for (let c = 0; c < colCount; c += 1) {
    const col: CellValue[] = [];
    for (let r = 0; r < rowCount; r += 1) {
      col.push(CELL(base + (startRow + r) * 100 + c));
    }
    columns.push(col);
  }
  return { startRow, rowCount, columns };
}

describe('storage and lookup', () => {
  it('stores and retrieves a full block', () => {
    const cache = new BlockCache({ blockSize: 100 });
    cache.put(block(0, 100));
    expect(cache.get(0, 0)).toEqual(CELL(0));
    expect(cache.get(99, 1)).toEqual(CELL(99 * 100 + 1));
    expect(cache.has(0)).toBe(true);
    expect(cache.has(99)).toBe(true);
  });

  it('returns undefined for rows outside any stored block', () => {
    const cache = new BlockCache({ blockSize: 100 });
    cache.put(block(0, 100));
    expect(cache.get(100, 0)).toBeUndefined();
    expect(cache.has(100)).toBe(false);
    expect(cache.has(-1)).toBe(false);
  });

  it('stores a partial block without inventing cells', () => {
    const cache = new BlockCache({ blockSize: 100 });
    cache.put(block(50, 20));
    expect(cache.get(50, 0)).toEqual(CELL(5000));
    expect(cache.get(69, 0)).toBeDefined();
    expect(cache.get(49, 0)).toBeUndefined();
    expect(cache.get(70, 0)).toBeUndefined();
  });

  it('returns undefined for a column index beyond the stored width', () => {
    const cache = new BlockCache({ blockSize: 100 });
    cache.put(block(0, 10, 2));
    expect(cache.get(0, 1)).toBeDefined();
    expect(cache.get(0, 2)).toBeUndefined();
    expect(cache.get(0, -1)).toBeUndefined();
  });

  it('overwrites an existing block', () => {
    const cache = new BlockCache({ blockSize: 100 });
    // block(startRow, rowCount, colCount, base) -> CELL(base + (startRow + r) * 100 + c)
    cache.put(block(0, 100, 1, 0));
    cache.put(block(0, 100, 1, 9));
    expect(cache.get(0, 0)).toEqual(CELL(9));
    expect(cache.get(1, 0)).toEqual(CELL(109));
  });
});

describe('block indexing', () => {
  it('maps rows to aligned block indices', () => {
    const cache = new BlockCache({ blockSize: 100 });
    expect(cache.blockIndex(0)).toBe(0);
    expect(cache.blockIndex(99)).toBe(0);
    expect(cache.blockIndex(100)).toBe(1);
    expect(cache.blockIndex(250)).toBe(2);
  });

  it('lists the missing blocks covering an inclusive row range', () => {
    const cache = new BlockCache({ blockSize: 100 });
    expect(cache.missingBlocks(0, 250)).toEqual([0, 1, 2]);
    cache.put(block(100, 100));
    expect(cache.missingBlocks(0, 250)).toEqual([0, 2]);
    cache.put(block(0, 100));
    cache.put(block(200, 100));
    expect(cache.missingBlocks(0, 250)).toEqual([]);
  });

  it('returns a single block index for a one-row range', () => {
    const cache = new BlockCache({ blockSize: 100 });
    expect(cache.missingBlocks(500, 500)).toEqual([5]);
  });

  it('returns nothing for an inverted or empty range', () => {
    const cache = new BlockCache({ blockSize: 100 });
    expect(cache.missingBlocks(10, 5)).toEqual([]);
    expect(cache.missingBlocks(0, -1)).toEqual([]);
  });

  it('clamps negative row indices to zero', () => {
    const cache = new BlockCache({ blockSize: 100 });
    expect(cache.missingBlocks(-50, 50)).toEqual([0]);
  });
});

describe('eviction', () => {
  it('evicts the least recently used block past capacity', () => {
    const cache = new BlockCache({ blockSize: 10, maxBlocks: 2 });
    cache.put(block(0, 10));
    cache.put(block(10, 10));
    // Only a read counts as use: `has()` is a planning query used by the data
    // window, so it must not promote a block that is not being painted.
    expect(cache.get(0, 0)).toBeDefined();
    cache.put(block(20, 10));
    expect(cache.has(0)).toBe(true);
    expect(cache.has(10)).toBe(false);
    expect(cache.has(20)).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('does not promote a block on has(), only on get()', () => {
    const cache = new BlockCache({ blockSize: 10, maxBlocks: 2 });
    cache.put(block(0, 10));
    cache.put(block(10, 10));
    expect(cache.has(0)).toBe(true);
    cache.put(block(20, 10));
    // 'block 0' was queried but never read, so it is still the LRU victim
    expect(cache.has(0)).toBe(false);
    expect(cache.has(10)).toBe(true);
  });

  it('never evicts below capacity', () => {
    const cache = new BlockCache({ blockSize: 10, maxBlocks: 5 });
    for (let i = 0; i < 5; i += 1) cache.put(block(i * 10, 10));
    expect(cache.size).toBe(5);
    expect(cache.has(0)).toBe(true);
  });

  it('clears everything on invalidate', () => {
    const cache = new BlockCache({ blockSize: 10 });
    cache.put(block(0, 10));
    cache.invalidate();
    expect(cache.size).toBe(0);
    expect(cache.has(0)).toBe(false);
  });
});
