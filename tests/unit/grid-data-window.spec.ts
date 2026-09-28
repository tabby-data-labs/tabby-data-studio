/**
 * Data windowing: prefetch triggers, in-flight dedupe, stale-request abort.
 *
 * AGENTS.md lists this as Tier 1, so the controller is driven by a recording
 * fake DataSource — a collaborator, never the unit under test.
 */
import { describe, expect, it, vi } from 'vitest';
import { DataWindowController } from '@/grid/data-window';
import { BlockCache } from '@/grid/block-cache';
import type { CellValue, ColumnMeta, DataSource, RowBlock } from '@/grid/types';

const CELL: CellValue = { kind: 'null' };
const COLUMNS: readonly ColumnMeta[] = [
  { name: 'id', typeName: 'int4', typeOid: 23, nullable: false, widthHint: 80 },
];

interface Call {
  readonly startRow: number;
  readonly rowCount: number;
  readonly signal: AbortSignal;
  resolve: (block: RowBlock) => void;
  reject: (error: unknown) => void;
}

/** Resolves only when the test says so, so ordering is fully controlled. */
function fakeSource(rowCount: number, latency: 'manual' | 'immediate' = 'manual') {
  const calls: Call[] = [];
  const source: DataSource = {
    columns: COLUMNS,
    rowCount,
    rowCountIsEstimate: false,
    getBlock(startRow, count, signal) {
      const block: RowBlock = {
        startRow,
        rowCount: count,
        columns: [Array.from({ length: count }, () => CELL)],
      };
      if (latency === 'immediate') return Promise.resolve(block);
      return new Promise<RowBlock>((resolve, reject) => {
        calls.push({ startRow, rowCount: count, signal, resolve, reject });
      });
    },
    sort: vi.fn(async () => {}),
  };
  return { source, calls };
}

function resolveAll(calls: Call[]): void {
  for (const call of [...calls]) {
    call.resolve({
      startRow: call.startRow,
      rowCount: call.rowCount,
      columns: [Array.from({ length: call.rowCount }, () => CELL)],
    });
  }
  calls.length = 0;
}

function controller(rowCount: number, opts: { blockSize?: number; prefetch?: number } = {}) {
  const { source, calls } = fakeSource(rowCount);
  const cache = new BlockCache({ blockSize: opts.blockSize ?? 100 });
  const onArrive = vi.fn();
  // The controller reads its block size from the cache, so the two cannot drift.
  const ctrl = new DataWindowController({
    source,
    cache,
    prefetch: opts.prefetch ?? 1,
    onArrive,
  });
  return { ctrl, calls, cache, onArrive };
}

describe('request planning', () => {
  it('requests only the blocks missing from the cache', () => {
    const { ctrl, calls } = controller(10_000);
    ctrl.update(0, 150);
    expect(calls.map((c) => c.startRow).sort((a, b) => a - b)).toEqual([0, 100, 200]);
  });

  it('prefetches beyond the visible range', () => {
    const { ctrl, calls } = controller(10_000, { prefetch: 2 });
    ctrl.update(0, 50);
    // visible block 0, plus 2 ahead -> blocks 0,1,2
    expect(calls.map((c) => c.startRow)).toEqual([0, 100, 200]);
  });

  it('issues no prefetch when prefetch is zero', () => {
    const { ctrl, calls } = controller(10_000, { prefetch: 0 });
    ctrl.update(0, 50);
    expect(calls.map((c) => c.startRow)).toEqual([0]);
  });

  it('never requests past rowCount', () => {
    const { ctrl, calls } = controller(150, { prefetch: 3 });
    ctrl.update(0, 149);
    expect(calls.map((c) => c.startRow)).toEqual([0, 100]);
  });

  it('clamps the final block request to the remaining rows', () => {
    const { ctrl, calls } = controller(150);
    ctrl.update(100, 149);
    const tail = calls.find((c) => c.startRow === 100);
    expect(tail?.rowCount).toBe(50);
  });

  it('requests nothing for an empty result', () => {
    const { ctrl, calls } = controller(0);
    ctrl.update(0, -1);
    expect(calls).toEqual([]);
  });

  it('requests nothing for an inverted range', () => {
    const { ctrl, calls } = controller(1000);
    ctrl.update(500, 100);
    expect(calls).toEqual([]);
  });

  it('skips blocks already cached', () => {
    const { ctrl, calls, cache } = controller(10_000);
    cache.put({ startRow: 100, rowCount: 100, columns: [[CELL]] });
    ctrl.update(0, 250);
    // visible blocks 0..2 plus one prefetch block (3); block 1 is cached
    expect(calls.map((c) => c.startRow).sort((a, b) => a - b)).toEqual([0, 200, 300]);
  });
});

describe('in-flight dedupe', () => {
  it('does not re-request a block that is already pending', () => {
    const { ctrl, calls } = controller(10_000);
    ctrl.update(0, 50);
    const first = calls.length;
    ctrl.update(0, 50);
    ctrl.update(0, 60);
    expect(calls).toHaveLength(first);
  });

  it('re-requests a block once its flight failed', async () => {
    const { ctrl, calls } = controller(10_000);
    ctrl.update(0, 50);
    const pending = calls[0];
    expect(pending).toBeDefined();
    pending!.reject(new Error('network'));
    calls.length = 0;
    await Promise.resolve();
    await Promise.resolve();
    ctrl.update(0, 50);
    expect(calls.map((c) => c.startRow)).toContain(0);
  });
});

describe('stale request handling', () => {
  it('aborts flights that fell out of the needed range', () => {
    const { ctrl, calls } = controller(1_000_000, { prefetch: 0 });
    ctrl.update(0, 50);
    const [first] = calls;
    expect(first?.signal.aborted).toBe(false);

    // jump far away: the original block is no longer needed
    ctrl.update(500_000, 500_050);
    expect(first?.signal.aborted).toBe(true);
  });

  it('keeps flights that are still needed', () => {
    const { ctrl, calls } = controller(1_000_000, { prefetch: 0 });
    ctrl.update(0, 50);
    const [first] = calls;
    ctrl.update(0, 80);
    expect(first?.signal.aborted).toBe(false);
  });

  it('does not cache the result of an aborted request', async () => {
    const { ctrl, calls, cache } = controller(1_000_000, { prefetch: 0 });
    ctrl.update(0, 50);
    const [first] = calls;
    ctrl.update(500_000, 500_050);
    expect(first?.signal.aborted).toBe(true);
    // resolve late, after abort
    first!.resolve({
      startRow: 0,
      rowCount: 100,
      columns: [Array.from({ length: 100 }, () => CELL)],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.has(0)).toBe(false);
  });

  it('aborts everything on abortAll()', () => {
    const { ctrl, calls } = controller(1_000_000, { prefetch: 2 });
    ctrl.update(0, 250);
    expect(calls.length).toBeGreaterThan(0);
    ctrl.abortAll();
    expect(calls.every((c) => c.signal.aborted)).toBe(true);
    expect(ctrl.pending).toBe(0);
  });
});

describe('arrival', () => {
  it('caches a resolved block and notifies the listener', async () => {
    const { source, calls } = fakeSource(10_000);
    const cache = new BlockCache({ blockSize: 100 });
    const onArrive = vi.fn();
    const ctrl = new DataWindowController({ source, cache, prefetch: 0, onArrive });

    ctrl.update(0, 50);
    resolveAll(calls);
    await vi.waitFor(() => expect(onArrive).toHaveBeenCalled());
    expect(cache.has(0)).toBe(true);
    expect(ctrl.pending).toBe(0);
  });

  it('requests visible blocks before prefetch blocks', () => {
    const { ctrl, calls } = controller(10_000, { prefetch: 2 });
    ctrl.update(0, 50);
    expect(calls[0]?.startRow).toBe(0);
  });

  it('prefetches behind the visible range when scrolled forward', () => {
    const { ctrl, calls } = controller(10_000, { prefetch: 1 });
    ctrl.update(300, 350);
    expect(calls.map((c) => c.startRow).sort((a, b) => a - b)).toEqual([200, 300, 400]);
  });
});
