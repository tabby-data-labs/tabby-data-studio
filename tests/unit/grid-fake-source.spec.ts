/**
 * The synthetic source that lets Phases 1–2 finish the grid before any database
 * code exists (GRID-SPEC G7, PLAN Phase 1).
 *
 * The load-bearing property is determinism under *out-of-order* access: the
 * grid jumps straight to row 800k, so a value must be a pure function of
 * (seed, row, column) — never of a sequential PRNG stream.
 */
import { describe, expect, it } from 'vitest';
import { FakeDataSource } from '@/grid/fake-source';
import type { CellValue } from '@/grid/types';

const COLS = 30;
const ROWS = 1_000_000;

describe('shape', () => {
  it('exposes the configured row and column counts', () => {
    const source = new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 1 });
    expect(source.rowCount).toBe(ROWS);
    expect(source.columns).toHaveLength(COLS);
    expect(source.rowCountIsEstimate).toBe(false);
  });

  it('returns a column-major block of the requested size', async () => {
    const source = new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 1 });
    const block = await source.getBlock(0, 50, new AbortController().signal);
    expect(block.startRow).toBe(0);
    expect(block.rowCount).toBe(50);
    expect(block.columns).toHaveLength(COLS);
    expect(block.columns[0]).toHaveLength(50);
  });

  it('clamps a block that runs past the end', async () => {
    const source = new FakeDataSource({ rowCount: 120, columnCount: COLS, seed: 1 });
    const block = await source.getBlock(100, 100, new AbortController().signal);
    expect(block.rowCount).toBe(20);
    expect(block.columns[0]).toHaveLength(20);
  });

  it('produces every CellValue kind it claims to', async () => {
    const source = new FakeDataSource({ rowCount: 500, columnCount: COLS, seed: 7 });
    const block = await source.getBlock(0, 500, new AbortController().signal);
    const kinds = new Set<string>();
    for (const column of block.columns) {
      for (const cell of column) kinds.add(cell.kind);
    }
    for (const expected of ['null', 'bool', 'number', 'text', 'time', 'json', 'binary']) {
      expect(kinds.has(expected), `expected a ${expected} cell`).toBe(true);
    }
  });

  it('keeps the string form for exact numeric columns', async () => {
    const source = new FakeDataSource({ rowCount: 10, columnCount: COLS, seed: 1 });
    const block = await source.getBlock(0, 10, new AbortController().signal);
    const numeric = block.columns
      .flatMap((c) => c)
      .filter((c): c is Extract<CellValue, { kind: 'number' }> => c.kind === 'number');
    expect(numeric.length).toBeGreaterThan(0);
    for (const cell of numeric) {
      expect(typeof cell.raw).toBe('string');
      expect(cell.raw).not.toBe('');
    }
  });

  it('includes NULL cells so null rendering is exercised', async () => {
    const source = new FakeDataSource({ rowCount: 2000, columnCount: COLS, seed: 3 });
    const block = await source.getBlock(0, 2000, new AbortController().signal);
    const nulls = block.columns.flatMap((c) => c).filter((c) => c.kind === 'null');
    expect(nulls.length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('returns identical cells for the same window on repeat calls', async () => {
    const source = new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 42 });
    const signal = new AbortController().signal;
    const a = await source.getBlock(1234, 20, signal);
    const b = await source.getBlock(1234, 20, signal);
    expect(a).toEqual(b);
  });

  it('agrees across two independent instances with the same seed', async () => {
    const signal = new AbortController().signal;
    const a = await new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 42 }).getBlock(
      900_000,
      10,
      signal,
    );
    const b = await new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 42 }).getBlock(
      900_000,
      10,
      signal,
    );
    expect(a).toEqual(b);
  });

  it('is independent of access order', async () => {
    const signal = new AbortController().signal;
    const forward = new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 5 });
    const jumping = new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 5 });

    // Read the tail first on one instance, the head first on the other.
    const tailFirst = await jumping.getBlock(999_900, 100, signal);
    await forward.getBlock(0, 100, signal);
    const tailSecond = await forward.getBlock(999_900, 100, signal);

    expect(tailFirst).toEqual(tailSecond);
  });

  it('overlapping windows agree on the shared rows', async () => {
    const source = new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 9 });
    const signal = new AbortController().signal;
    const a = await source.getBlock(100, 50, signal);
    const b = await source.getBlock(120, 50, signal);
    // rows 120..149 appear in both: a at offset 20, b at offset 0
    for (let c = 0; c < COLS; c += 1) {
      expect(a.columns[c]?.slice(20)).toEqual(b.columns[c]?.slice(0, 30));
    }
  });

  it('differs under a different seed', async () => {
    const signal = new AbortController().signal;
    const a = await new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 1 }).getBlock(
      0,
      200,
      signal,
    );
    const b = await new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 2 }).getBlock(
      0,
      200,
      signal,
    );
    expect(a).not.toEqual(b);
  });

  it('reaches the last row of a 1M-row source without degrading', async () => {
    const source = new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 1 });
    const block = await source.getBlock(ROWS - 5, 5, new AbortController().signal);
    expect(block.rowCount).toBe(5);
    expect(block.columns[0]?.[0]).toBeDefined();
  });
});

describe('cancellation', () => {
  it('rejects when the signal is already aborted', async () => {
    const source = new FakeDataSource({ rowCount: ROWS, columnCount: COLS, seed: 1 });
    const ac = new AbortController();
    ac.abort();
    await expect(source.getBlock(0, 10, ac.signal)).rejects.toThrow();
  });

  it('rejects when the signal aborts mid-flight', async () => {
    const source = new FakeDataSource({
      rowCount: ROWS,
      columnCount: COLS,
      seed: 1,
      latencyMs: 20,
    });
    const ac = new AbortController();
    const pending = source.getBlock(0, 10, ac.signal);
    ac.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('sort()', () => {
  it('reorders rows deterministically for a numeric column', async () => {
    const signal = new AbortController().signal;
    const source = new FakeDataSource({ rowCount: 5000, columnCount: COLS, seed: 11 });
    await source.sort(1, 'asc');
    const asc = await source.getBlock(0, 20, signal);
    const again = await source.getBlock(0, 20, signal);
    expect(asc).toEqual(again);

    const natural = new FakeDataSource({ rowCount: 5000, columnCount: COLS, seed: 11 });
    const before = await natural.getBlock(0, 20, signal);
    expect(asc).not.toEqual(before);
  });

  it('produces ascending order on the sorted column', async () => {
    const source = new FakeDataSource({ rowCount: 2000, columnCount: COLS, seed: 13 });
    await source.sort(1, 'asc');
    const block = await source.getBlock(0, 2000, new AbortController().signal);
    const column = block.columns[1] ?? [];
    // Column 1 is documented non-null and numeric, so assert that instead of
    // filtering — a filter would let this test pass vacuously.
    expect(column).toHaveLength(2000);
    let previous = -Infinity;
    for (const cell of column) {
      expect(cell.kind).toBe('number');
      if (cell.kind !== 'number') continue;
      expect(cell.value).toBeGreaterThanOrEqual(previous);
      previous = cell.value;
    }
    expect(previous).toBeGreaterThan(-Infinity);
  });

  it('reverses for descending order', async () => {
    const signal = new AbortController().signal;
    // Column 0 is the unique sequential id, so the extremes are unambiguous
    // even where hash-derived columns contain ties.
    const asc = new FakeDataSource({ rowCount: 500, columnCount: COLS, seed: 17 });
    const desc = new FakeDataSource({ rowCount: 500, columnCount: COLS, seed: 17 });
    await asc.sort(0, 'asc');
    await desc.sort(0, 'desc');
    const a = await asc.getBlock(0, 500, signal);
    const d = await desc.getBlock(0, 500, signal);
    expect(a.columns[0]?.[0]).toEqual(d.columns[0]?.[499]);
    expect(a.columns[0]?.[499]).toEqual(d.columns[0]?.[0]);
  });

  it('restores natural order when direction is null', async () => {
    const signal = new AbortController().signal;
    const source = new FakeDataSource({ rowCount: 500, columnCount: COLS, seed: 19 });
    const natural = await source.getBlock(0, 50, signal);
    await source.sort(1, 'asc');
    await source.sort(1, null);
    expect(await source.getBlock(0, 50, signal)).toEqual(natural);
  });

  it('ignores a column index out of range', async () => {
    const signal = new AbortController().signal;
    const source = new FakeDataSource({ rowCount: 100, columnCount: COLS, seed: 23 });
    const natural = await source.getBlock(0, 10, signal);
    await source.sort(999, 'asc');
    expect(await source.getBlock(0, 10, signal)).toEqual(natural);
  });
});
