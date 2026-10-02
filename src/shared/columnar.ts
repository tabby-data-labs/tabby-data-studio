/**
 * The columnar transfer codec (PLAN Phase 4, ARCHITECTURE §5.4).
 *
 * Main encodes, the renderer decodes, so this lives in `src/shared` — the two
 * halves have to agree by construction rather than by duplicated constants.
 *
 * Why not send `CellValue[][]`: a million cell objects do not survive a
 * structured clone cheaply, and the grid only ever paints a few thousand of them.
 * Packing a column into one typed array plus a bitmap costs a few bytes per row
 * and lets the renderer decode a cell at the moment it is about to draw it.
 *
 * Two invariants worth stating, because both are silent-failure bugs otherwise:
 *  - `offsets` are **byte** offsets into the UTF-8 blob, never character offsets.
 *    Slicing on a character count would cut a multi-byte code point in half.
 *  - `int8` and `numeric` are packed as **text**. A double cannot hold them, and
 *    rounding a bigint column is the worst kind of bug in a data viewer because
 *    the result still looks plausible.
 */
import type { CellValue, ColumnMeta, EncodedColumn, EncodedRowBlock, RowBlock } from './domain';
import {
  OID,
  encodingKindFor,
  isTemporalOid,
  normalizeValue,
  textFor,
  type NormalizedValue,
} from './pg-types';

/** Bytes kept for a `bytea` preview. Enough to recognise the value, not to hold it. */
const BINARY_PREVIEW_BYTES = 32;
/** Characters kept for a `json` preview. */
const JSON_PREVIEW_CHARS = 200;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const EMPTY_BYTES = new Uint8Array(0);
const NULL_CELL: CellValue = { kind: 'null' };

/** Numeric types that arrive as text but must decode to a number cell. */
const TEXTUAL_NUMBERS: ReadonlySet<number> = new Set([OID.int8, OID.numeric]);
const JSON_OIDS: ReadonlySet<number> = new Set([OID.json, OID.jsonb]);

function setBit(bitmap: Uint8Array, index: number): void {
  bitmap[index >> 3] = (bitmap[index >> 3] ?? 0) | (1 << (index & 7));
}

function getBit(bitmap: Uint8Array, index: number): boolean {
  return ((bitmap[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

function bitmapLength(rowCount: number): number {
  return Math.ceil(rowCount / 8);
}

function encodeFloat64(normalized: readonly NormalizedValue[], rowCount: number): Float64Array {
  const values = new Float64Array(rowCount);
  for (let r = 0; r < rowCount; r += 1) {
    const cell = normalized[r]!;
    // NULL rows are covered by the bitmap; the payload slot stays 0.
    if (cell.kind === 'num') values[r] = cell.value;
  }
  return values;
}

function encodeBits(normalized: readonly NormalizedValue[], rowCount: number): Uint8Array {
  const bits = new Uint8Array(bitmapLength(rowCount));
  for (let r = 0; r < rowCount; r += 1) {
    const cell = normalized[r]!;
    if (cell.kind === 'bool' && cell.value) setBit(bits, r);
  }
  return bits;
}

function encodeUtf8(
  normalized: readonly NormalizedValue[],
  rowCount: number,
): { offsets: Uint32Array; bytes: Uint8Array } {
  const offsets = new Uint32Array(rowCount + 1);
  const parts: Uint8Array[] = new Array(rowCount);
  let total = 0;

  for (let r = 0; r < rowCount; r += 1) {
    offsets[r] = total;
    const cell = normalized[r]!;
    // bytea keeps its raw bytes here; everything else becomes its display text.
    const bytes =
      cell.kind === 'bytes'
        ? cell.value
        : cell.kind === 'null'
          ? EMPTY_BYTES
          : encoder.encode(textFor(cell));
    parts[r] = bytes;
    total += bytes.length;
  }
  offsets[rowCount] = total;

  const blob = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    blob.set(part, position);
    position += part.length;
  }
  return { offsets, bytes: blob };
}

/**
 * Packs one column. The preferred encoding comes from the type OID, but it is
 * only used when every non-NULL value actually fits it: a float8 column that
 * arrives as text degrades to `utf8` rather than losing the value.
 */
function encodeColumn(
  rows: readonly (readonly unknown[])[],
  columnIndex: number,
  meta: ColumnMeta,
  rowCount: number,
): EncodedColumn {
  const normalized: NormalizedValue[] = new Array(rowCount);
  for (let r = 0; r < rowCount; r += 1) {
    const row = rows[r];
    normalized[r] = normalizeValue(meta.typeOid, row === undefined ? undefined : row[columnIndex]);
  }

  const nulls = new Uint8Array(bitmapLength(rowCount));
  for (let r = 0; r < rowCount; r += 1) {
    if (normalized[r]!.kind === 'null') setBit(nulls, r);
  }

  const base = {
    typeOid: meta.typeOid,
    typeName: meta.typeName,
    rowCount,
    nulls,
  };

  const preferred = encodingKindFor(meta.typeOid);
  const fits = (kind: NormalizedValue['kind']): boolean =>
    normalized.every((cell) => cell.kind === kind || cell.kind === 'null');

  if (preferred === 'float64' && fits('num')) {
    return { ...base, encoding: 'float64', values: encodeFloat64(normalized, rowCount) };
  }
  if (preferred === 'bits' && fits('bool')) {
    return { ...base, encoding: 'bits', bits: encodeBits(normalized, rowCount) };
  }

  const { offsets, bytes } = encodeUtf8(normalized, rowCount);
  return { ...base, encoding: 'utf8', offsets, bytes };
}

/**
 * Packs rows into a columnar block.
 *
 * `rows` is positional (`rowMode: 'array'` in the driver), so two columns with
 * the same name — a self-join, or `select 1 as a, 2 as a` — cannot collide the
 * way they would in an object-keyed row.
 */
export function encodeBlock(
  rows: readonly (readonly unknown[])[],
  columns: readonly ColumnMeta[],
  startRow = 0,
): EncodedRowBlock {
  const rowCount = rows.length;
  return {
    startRow,
    rowCount,
    columns: columns.map((meta, index) => encodeColumn(rows, index, meta, rowCount)),
  };
}

function inRange(column: EncodedColumn, rowIndex: number): boolean {
  return Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < column.rowCount;
}

function sliceBytes(column: EncodedColumn, rowIndex: number): Uint8Array {
  const offsets = column.offsets;
  const bytes = column.bytes;
  if (!offsets || !bytes) return EMPTY_BYTES;
  const start = offsets[rowIndex] ?? 0;
  const end = offsets[rowIndex + 1] ?? start;
  return bytes.subarray(start, end);
}

function decodeUtf8Cell(column: EncodedColumn, rowIndex: number): CellValue {
  const raw = sliceBytes(column, rowIndex);
  const oid = column.typeOid;

  if (oid === OID.bytea) {
    return {
      kind: 'binary',
      byteLength: raw.length,
      preview: raw.slice(0, BINARY_PREVIEW_BYTES),
    };
  }

  const text = decoder.decode(raw);

  if (JSON_OIDS.has(oid)) {
    return { kind: 'json', preview: text.slice(0, JSON_PREVIEW_CHARS), byteLength: raw.length };
  }
  if (TEXTUAL_NUMBERS.has(oid)) {
    // `raw` is the truth; `value` is a convenience that has already rounded.
    return { kind: 'number', value: Number(text), raw: text };
  }
  return { kind: 'text', value: text };
}

/**
 * Decodes a single cell.
 *
 * This is the function the renderer calls per *visible* cell during paint. An
 * out-of-range index returns an error cell rather than throwing or returning
 * undefined: a window can be resized or replaced underneath an in-flight frame,
 * and losing the frame is worse than showing one bad cell.
 */
export function decodeCell(column: EncodedColumn, rowIndex: number): CellValue {
  if (!inRange(column, rowIndex)) {
    return {
      kind: 'error',
      message: `row ${rowIndex} is outside this block of ${column.rowCount}`,
    };
  }
  if (getBit(column.nulls, rowIndex)) return NULL_CELL;

  switch (column.encoding) {
    case 'float64': {
      const value = column.values?.[rowIndex] ?? Number.NaN;
      if (isTemporalOid(column.typeOid)) {
        if (!Number.isFinite(value)) {
          // Unreachable through encodeBlock, which downgrades such a column to
          // text; kept so a hand-built or truncated block cannot render "Invalid
          // Date" for the rest of the grid's life.
          return {
            kind: 'text',
            value: Number.isNaN(value) ? 'NaN' : value > 0 ? 'infinity' : '-infinity',
          };
        }
        return {
          kind: 'time',
          epochMs: value,
          tz: column.typeOid === OID.timestamptz ? 'UTC' : '',
        };
      }
      return { kind: 'number', value, raw: String(value) };
    }
    case 'bits':
      return { kind: 'bool', value: getBit(column.bits ?? EMPTY_BYTES, rowIndex) };
    case 'utf8':
      return decodeUtf8Cell(column, rowIndex);
  }
}

/** True when the row is NULL, or when it is not in this block at all. */
export function isNullAt(column: EncodedColumn, rowIndex: number): boolean {
  if (!inRange(column, rowIndex)) return true;
  return getBit(column.nulls, rowIndex);
}

/**
 * Materialises a whole block as `CellValue`s.
 *
 * Convenient and expensive: it allocates one object per cell. The grid should
 * call `decodeCell` per painted cell instead; this exists for tests, for
 * clipboard serialisation of a small selection, and for the smoke harness.
 */
export function decodeBlock(block: EncodedRowBlock): RowBlock {
  return {
    startRow: block.startRow,
    rowCount: block.rowCount,
    columns: block.columns.map((column) => {
      const cells: CellValue[] = new Array(block.rowCount);
      for (let r = 0; r < block.rowCount; r += 1) cells[r] = decodeCell(column, r);
      return cells;
    }),
  };
}

/**
 * Bytes the block owns. This is the figure the result registry charges against
 * its memory cap, so it has to count the buffers and not an object-graph guess.
 */
export function blockByteLength(block: EncodedRowBlock): number {
  let total = 0;
  for (const column of block.columns) {
    total += column.nulls.byteLength;
    total += column.values?.byteLength ?? 0;
    total += column.offsets?.byteLength ?? 0;
    total += column.bytes?.byteLength ?? 0;
    total += column.bits?.byteLength ?? 0;
  }
  return total;
}
