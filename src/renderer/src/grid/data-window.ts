import type { BlockCache } from './block-cache';
import type { DataSource } from './types';

export interface DataWindowOptions {
  readonly source: DataSource;
  readonly cache: BlockCache;
  /** Blocks to keep warm on each side of the visible range. */
  readonly prefetch?: number;
  /** Called after a block lands, so the grid can invalidate and repaint. */
  readonly onArrive?: () => void;
}

/**
 * Turns "these rows are visible" into block requests.
 *
 * Three properties matter and are each covered by a test:
 *  - **dedupe** — a block already in flight is never requested twice, so a
 *    fast scroll cannot stampede the source;
 *  - **stale abort** — when the visible range moves, flights that no longer
 *    matter are aborted and their late results discarded, so a slow response
 *    can never overwrite newer data;
 *  - **priority** — visible blocks are requested before prefetch blocks.
 */
export class DataWindowController {
  private readonly source: DataSource;
  private readonly cache: BlockCache;
  private readonly blockSize: number;
  private readonly prefetch: number;
  private readonly onArrive: (() => void) | undefined;
  private readonly inflight = new Map<number, AbortController>();

  constructor(options: DataWindowOptions) {
    this.source = options.source;
    this.cache = options.cache;
    // The cache owns block alignment; reading the size from it means the two
    // can never disagree about where a block boundary falls.
    this.blockSize = options.cache.blockSize;
    this.prefetch = Math.max(0, Math.floor(options.prefetch ?? 1));
    this.onArrive = options.onArrive;
  }

  get pending(): number {
    return this.inflight.size;
  }

  /** A block counts as ready only if it covers every row up to the tail clamp. */
  private isReady(index: number): boolean {
    const start = index * this.blockSize;
    const end = Math.min(start + this.blockSize - 1, this.source.rowCount - 1);
    if (end < start) return false;
    return this.cache.has(start) && this.cache.has(end);
  }

  private request(index: number): void {
    if (this.inflight.has(index) || this.isReady(index)) return;

    const startRow = index * this.blockSize;
    const rowCount = Math.min(this.blockSize, this.source.rowCount - startRow);
    if (rowCount <= 0) return;

    const controller = new AbortController();
    this.inflight.set(index, controller);

    this.source.getBlock(startRow, rowCount, controller.signal).then(
      (block) => {
        // Superseded or aborted: drop the result rather than caching stale rows.
        if (this.inflight.get(index) !== controller) return;
        this.inflight.delete(index);
        if (controller.signal.aborted) return;
        this.cache.put(block);
        this.onArrive?.();
      },
      () => {
        if (this.inflight.get(index) !== controller) return;
        this.inflight.delete(index);
      },
    );
  }

  /** Idempotent: calling it every frame with the same range does nothing. */
  update(firstRow: number, lastRow: number): void {
    const rowCount = this.source.rowCount;
    if (rowCount <= 0 || lastRow < firstRow) {
      this.cancelExcept(new Set());
      return;
    }

    const clampedFirst = Math.max(0, Math.floor(firstRow));
    const clampedLast = Math.min(rowCount - 1, Math.floor(lastRow));
    const firstBlock = this.cache.blockIndex(clampedFirst);
    const lastBlock = this.cache.blockIndex(clampedLast);

    const visible: number[] = [];
    for (let index = firstBlock; index <= lastBlock; index += 1) visible.push(index);

    const needed = new Set(visible);
    for (let index = firstBlock - this.prefetch; index <= lastBlock + this.prefetch; index += 1) {
      if (index < 0) continue;
      if (index * this.blockSize >= rowCount) continue;
      needed.add(index);
    }

    this.cancelExcept(needed);

    // Visible first so the rows the user is looking at arrive before prefetch.
    for (const index of visible) this.request(index);
    for (const index of needed) this.request(index);
  }

  private cancelExcept(needed: ReadonlySet<number>): void {
    for (const [index, controller] of this.inflight) {
      if (needed.has(index)) continue;
      this.inflight.delete(index);
      controller.abort();
    }
  }

  abortAll(): void {
    this.cancelExcept(new Set());
  }
}
