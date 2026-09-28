import type { CellValue, ColumnMeta, DataSource, RowBlock } from './types';

/**
 * Column contract relied on by the specs:
 *   col 0 — `id`,       int8,     sequential and unique, never null
 *   col 1 — `hash_num`, int4,     hash-derived, never null (sortable, non-monotonic)
 *   col 2+ — rotating types, including nullable ones so NULL rendering is exercised
 */
const ROTATION = [
  { name: 'flag', typeName: 'bool', typeOid: 16, kind: 'bool', nullable: false, widthHint: 70 },
  { name: 'label', typeName: 'text', typeOid: 25, kind: 'text', nullable: false, widthHint: 170 },
  {
    name: 'created_at',
    typeName: 'timestamptz',
    typeOid: 1184,
    kind: 'time',
    nullable: false,
    widthHint: 200,
  },
  {
    name: 'payload',
    typeName: 'jsonb',
    typeOid: 3807,
    kind: 'json',
    nullable: false,
    widthHint: 210,
  },
  { name: 'blob', typeName: 'bytea', typeOid: 17, kind: 'binary', nullable: false, widthHint: 120 },
  { name: 'note', typeName: 'text', typeOid: 25, kind: 'text', nullable: true, widthHint: 180 },
  {
    name: 'amount',
    typeName: 'numeric',
    typeOid: 1700,
    kind: 'number',
    nullable: false,
    widthHint: 130,
  },
  {
    name: 'score',
    typeName: 'float8',
    typeOid: 701,
    kind: 'number',
    nullable: true,
    widthHint: 100,
  },
] as const;

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
] as const;

/** Base epoch: 2020-01-01. Offsets stay inside a plausible timestamp range. */
const BASE_EPOCH_MS = 1_577_836_800_000;

function hash32(seed: number, row: number, col: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (row >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (row & 0xffff), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (col + 1), 0x27d4eb2f) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    // Declared after onAbort but only read when it fires, so there is no TDZ
    // hazard; a `let` here would trip prefer-const.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface FakeDataSourceOptions {
  readonly rowCount?: number;
  readonly columnCount?: number;
  readonly seed?: number;
  /** Artificial latency, so cancellation paths can be exercised. */
  readonly latencyMs?: number;
}

/**
 * Deterministic synthetic source for Phases 1–2.
 *
 * The load-bearing property: a cell is a **pure function of (seed, row, column)**,
 * never of a sequential PRNG stream. The grid jumps straight to row 800k, so any
 * order dependence would produce different data depending on scroll history —
 * the kind of bug that is invisible in a demo and maddening in production.
 */
export class FakeDataSource implements DataSource {
  readonly rowCount: number;
  readonly rowCountIsEstimate = false;
  readonly columns: readonly ColumnMeta[];

  private readonly seed: number;
  private readonly latencyMs: number;
  /** Maps output row -> source row. Null means natural order. */
  private order: Int32Array | null = null;

  constructor(options: FakeDataSourceOptions = {}) {
    this.rowCount = Math.max(0, Math.floor(options.rowCount ?? 1_000_000));
    this.seed = Math.floor(options.seed ?? 1) >>> 0;
    this.latencyMs = Math.max(0, options.latencyMs ?? 0);

    const columnCount = Math.max(1, Math.floor(options.columnCount ?? 30));
    const columns: ColumnMeta[] = [];
    for (let col = 0; col < columnCount; col += 1) {
      if (col === 0) {
        columns.push({ name: 'id', typeName: 'int8', typeOid: 20, nullable: false, widthHint: 90 });
      } else if (col === 1) {
        columns.push({
          name: 'hash_num',
          typeName: 'int4',
          typeOid: 23,
          nullable: false,
          widthHint: 110,
        });
      } else {
        const spec = ROTATION[(col - 2) % ROTATION.length]!;
        columns.push({
          name: `${spec.name}_${col}`,
          typeName: spec.typeName,
          typeOid: spec.typeOid,
          nullable: spec.nullable,
          widthHint: spec.widthHint,
        });
      }
    }
    this.columns = columns;
  }

  private sourceRowOf(outputRow: number): number {
    return this.order ? (this.order[outputRow] ?? outputRow) : outputRow;
  }

  private isNumericColumn(col: number): boolean {
    if (col <= 1) return true;
    return ROTATION[(col - 2) % ROTATION.length]!.kind === 'number';
  }

  private cellAt(sourceRow: number, col: number): CellValue {
    if (col === 0) {
      const value = sourceRow + 1;
      return { kind: 'number', value, raw: String(value) };
    }

    const h = hash32(this.seed, sourceRow, col);

    if (col === 1) {
      const value = h % 1_000_000;
      return { kind: 'number', value, raw: String(value) };
    }

    const spec = ROTATION[(col - 2) % ROTATION.length]!;
    // Roughly one row in seven is NULL in nullable columns.
    if (spec.nullable && h % 7 === 0) return { kind: 'null' };

    switch (spec.kind) {
      case 'bool':
        return { kind: 'bool', value: (h & 1) === 1 };
      case 'text':
        return { kind: 'text', value: `${WORDS[h % WORDS.length]}-${(h >>> 4) % 9973}` };
      case 'time':
        return { kind: 'time', epochMs: BASE_EPOCH_MS + (h % 200_000_000) * 1000, tz: 'UTC' };
      case 'json': {
        const preview = `{"id":${h % 9973},"tag":"${WORDS[(h >>> 3) % WORDS.length]}"}`;
        return { kind: 'json', preview, byteLength: preview.length };
      }
      case 'binary': {
        const byteLength = (h % 64) + 1;
        const preview = new Uint8Array([h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff, h >>> 24]);
        return { kind: 'binary', byteLength, preview };
      }
      case 'number': {
        // numeric keeps its string form: a double cannot represent it exactly.
        const raw = `${h % 100_000}.${(h >>> 17) % 100}`.padEnd(3, '0');
        return { kind: 'number', value: Number(raw), raw };
      }
      default:
        return { kind: 'error', message: `unsupported fake kind` };
    }
  }

  /** Nulls sort first ascending, matching Postgres `NULLS LAST` inversion on desc. */
  private numericKey(sourceRow: number, col: number): number {
    const cell = this.cellAt(sourceRow, col);
    return cell.kind === 'number' ? cell.value : cell.kind === 'null' ? -Infinity : 0;
  }

  private stringKey(sourceRow: number, col: number): string {
    const cell = this.cellAt(sourceRow, col);
    switch (cell.kind) {
      case 'null':
        return '';
      case 'text':
        return cell.value;
      case 'bool':
        return cell.value ? 'true' : 'false';
      case 'time':
        return new Date(cell.epochMs).toISOString();
      case 'json':
        return cell.preview;
      case 'binary':
        return `<${cell.byteLength} bytes>`;
      case 'number':
        return cell.raw;
      default:
        return '';
    }
  }

  private buildOrder(col: number, direction: 'asc' | 'desc'): Int32Array {
    const n = this.rowCount;
    const indices = new Array<number>(n);
    for (let i = 0; i < n; i += 1) indices[i] = i;

    if (this.isNumericColumn(col)) {
      const keys = new Float64Array(n);
      for (let i = 0; i < n; i += 1) keys[i] = this.numericKey(i, col);
      // Array.prototype.sort is stable (ES2019), so ties keep natural order.
      indices.sort((a, b) => (keys[a] ?? 0) - (keys[b] ?? 0));
    } else {
      const keys = new Array<string>(n);
      for (let i = 0; i < n; i += 1) keys[i] = this.stringKey(i, col);
      indices.sort((a, b) => {
        const ka = keys[a] ?? '';
        const kb = keys[b] ?? '';
        if (ka < kb) return -1;
        if (ka > kb) return 1;
        return a - b;
      });
    }

    if (direction === 'desc') indices.reverse();

    const order = new Int32Array(n);
    for (let i = 0; i < n; i += 1) order[i] = indices[i] ?? i;
    return order;
  }

  async sort(columnIndex: number, direction: 'asc' | 'desc' | null): Promise<void> {
    if (direction === null || columnIndex < 0 || columnIndex >= this.columns.length) {
      this.order = null;
      return;
    }
    this.order = this.buildOrder(columnIndex, direction);
  }

  async getBlock(startRow: number, rowCount: number, signal: AbortSignal): Promise<RowBlock> {
    if (signal.aborted) throw new Error('aborted');

    const from = Math.max(0, Math.floor(startRow));
    const count = Math.max(0, Math.min(Math.floor(rowCount), this.rowCount - from));
    if (count === 0) return { startRow: from, rowCount: 0, columns: [] };

    if (this.latencyMs > 0) await sleep(this.latencyMs, signal);
    if (signal.aborted) throw new Error('aborted');

    const columnCount = this.columns.length;
    const columns: CellValue[][] = [];
    for (let col = 0; col < columnCount; col += 1) {
      const values: CellValue[] = new Array(count);
      for (let r = 0; r < count; r += 1) {
        values[r] = this.cellAt(this.sourceRowOf(from + r), col);
      }
      columns.push(values);
    }

    return { startRow: from, rowCount: count, columns };
  }
}
