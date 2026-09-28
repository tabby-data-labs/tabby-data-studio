import type { CellValue, RowBlock } from './types';

export interface BlockCacheOptions {
  /** Rows per aligned block. Matches the fetch granularity of the data window. */
  readonly blockSize?: number;
  /** LRU capacity in blocks, bounding renderer memory for huge results. */
  readonly maxBlocks?: number;
}

interface Entry {
  readonly startRow: number;
  readonly rowCount: number;
  readonly columns: readonly (readonly CellValue[])[];
}

/**
 * Synchronous cell store backing the paint pass.
 *
 * The paint loop cannot await, so it reads whatever is present and draws a
 * placeholder for the rest; DataWindowController fills the gaps. Blocks are
 * aligned to `blockSize` and evicted LRU, which is what keeps a 10M-row result
 * from materialising in renderer memory.
 */
export class BlockCache {
  private readonly blocks = new Map<number, Entry>();
  private readonly _blockSize: number;
  private readonly maxBlocks: number;

  constructor(options: BlockCacheOptions = {}) {
    this._blockSize = Math.max(1, Math.floor(options.blockSize ?? 200));
    this.maxBlocks = Math.max(1, Math.floor(options.maxBlocks ?? 256));
  }

  get size(): number {
    return this.blocks.size;
  }

  /** Exposed so the data window cannot drift onto a different block size. */
  get blockSize(): number {
    return this._blockSize;
  }

  blockIndex(row: number): number {
    return Math.floor(Math.max(0, row) / this._blockSize);
  }

  /**
   * Presence check that deliberately does NOT promote the block in LRU order.
   * The data window calls this while planning fetches; letting a planning query
   * count as "use" would evict blocks that are actually being painted.
   */
  has(row: number): boolean {
    if (row < 0) return false;
    const index = this.blockIndex(row);
    const entry = this.blocks.get(index);
    if (!entry) return false;
    return row >= entry.startRow && row < entry.startRow + entry.rowCount;
  }

  get(row: number, col: number): CellValue | undefined {
    if (row < 0 || col < 0) return undefined;
    const index = this.blockIndex(row);
    const entry = this.blocks.get(index);
    if (!entry) return undefined;

    const offset = row - entry.startRow;
    if (offset < 0 || offset >= entry.rowCount) return undefined;

    // Refresh recency on read: painting is the dominant access pattern.
    this.blocks.delete(index);
    this.blocks.set(index, entry);

    return entry.columns[col]?.[offset];
  }

  put(block: RowBlock): void {
    const index = this.blockIndex(block.startRow);
    this.blocks.delete(index);
    this.blocks.set(index, {
      startRow: block.startRow,
      rowCount: block.rowCount,
      columns: block.columns,
    });

    while (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next();
      if (oldest.done) break;
      this.blocks.delete(oldest.value);
    }
  }

  /**
   * Distinct aligned block indices covering [firstRow, lastRow] that are not
   * fully cached. Ordered ascending; empty for an inverted or empty range.
   */
  missingBlocks(firstRow: number, lastRow: number): number[] {
    const from = Math.max(0, Math.floor(firstRow));
    const to = Math.floor(lastRow);
    if (to < from) return [];

    const missing: number[] = [];
    for (let index = this.blockIndex(from); index <= this.blockIndex(to); index += 1) {
      const entry = this.blocks.get(index);
      const start = index * this.blockSize;
      const end = start + this.blockSize - 1;
      const covered =
        entry !== undefined &&
        entry.startRow <= Math.max(start, from) &&
        entry.startRow + entry.rowCount - 1 >= Math.min(end, to);
      if (!covered) missing.push(index);
    }
    return missing;
  }

  invalidate(): void {
    this.blocks.clear();
  }
}
