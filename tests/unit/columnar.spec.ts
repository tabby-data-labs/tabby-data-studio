/**
 * The columnar transfer codec (PLAN Phase 4, ARCHITECTURE §5.4).
 *
 * Tier 1: `src/shared/**` is explicitly test-first under AGENTS.md, and this is
 * a pure function of its inputs. It lives in `src/shared` because main encodes
 * and the renderer decodes — the two halves must agree by construction, not by
 * duplicated constants.
 *
 * Expectations come from the contract in the design doc and from the failure
 * modes that matter: precision loss on `int8`/`numeric`, timezone drift on
 * temporal types, byte-vs-character offsets in the UTF-8 blob, and NULL handling
 * at a bitmap boundary.
 */
import { describe, expect, it } from 'vitest';
import type { ColumnMeta, EncodedColumn } from '../../src/shared/domain';
import {
  blockByteLength,
  decodeBlock,
  decodeCell,
  encodeBlock,
  isNullAt,
} from '../../src/shared/columnar';
import { OID } from '../../src/shared/pg-types';

function meta(typeOid: number, typeName: string, name = 'c'): ColumnMeta {
  return { name, typeName, typeOid, nullable: true, widthHint: 120 };
}

/** Rows are positional (`rowMode: 'array'`), so duplicate column names cannot collide. */
function encode(
  rows: readonly (readonly unknown[])[],
  columns: readonly ColumnMeta[],
  startRow = 0,
) {
  return encodeBlock(rows, columns, startRow);
}

describe('utf8 encoding', () => {
  it('round-trips text', () => {
    const block = encode([['alpha'], ['beta'], ['']], [meta(OID.text, 'text')]);
    const column = block.columns[0]!;
    expect(column.encoding).toBe('utf8');
    expect(decodeCell(column, 0)).toEqual({ kind: 'text', value: 'alpha' });
    expect(decodeCell(column, 1)).toEqual({ kind: 'text', value: 'beta' });
    // An empty string is a value, not a NULL — conflating them is a data bug.
    expect(decodeCell(column, 2)).toEqual({ kind: 'text', value: '' });
    expect(isNullAt(column, 2)).toBe(false);
  });

  it('stores byte offsets, not character offsets', () => {
    const block = encode([['日本語'], ['ab']], [meta(OID.text, 'text')]);
    const column = block.columns[0]!;
    // '日本語' is 9 UTF-8 bytes and 3 characters; a character-offset table would
    // slice the blob in the middle of a code point.
    expect(column.offsets).toEqual(new Uint32Array([0, 9, 11]));
    expect(column.bytes?.length).toBe(11);
    expect(decodeCell(column, 0)).toEqual({ kind: 'text', value: '日本語' });
    expect(decodeCell(column, 1)).toEqual({ kind: 'text', value: 'ab' });
  });

  it('round-trips emoji outside the BMP', () => {
    const block = encode([['a😀b']], [meta(OID.text, 'text')]);
    expect(decodeCell(block.columns[0]!, 0)).toEqual({ kind: 'text', value: 'a😀b' });
  });

  it('has an offsets table one longer than the row count', () => {
    const block = encode([['a'], ['b'], ['c']], [meta(OID.text, 'text')]);
    expect(block.columns[0]!.offsets?.length).toBe(4);
  });
});

describe('precision', () => {
  it('keeps int8 text exact past 2^53', () => {
    const block = encode(
      [['9007199254740993'], ['-9223372036854775808']],
      [meta(OID.int8, 'int8')],
    );
    const column = block.columns[0]!;
    expect(column.encoding).toBe('utf8');
    const cell = decodeCell(column, 0);
    expect(cell).toEqual({
      kind: 'number',
      value: Number('9007199254740993'),
      raw: '9007199254740993',
    });
    // The point of carrying `raw`: the double has already rounded, so anything
    // displayed or copied must come from the text.
    if (cell.kind === 'number') {
      expect(String(cell.value)).not.toBe(cell.raw);
    }
    expect(decodeCell(column, 1)).toMatchObject({ raw: '-9223372036854775808' });
  });

  it('keeps numeric text exact, including 30 significant digits', () => {
    const raw = '12345678901234567890.1234567890';
    const block = encode([[raw]], [meta(OID.numeric, 'numeric')]);
    expect(decodeCell(block.columns[0]!, 0)).toMatchObject({ kind: 'number', raw });
  });

  it('round-trips int4 through a Float64Array without loss', () => {
    const block = encode([[42], [-2147483648], [2147483647]], [meta(OID.int4, 'int4')]);
    const column = block.columns[0]!;
    expect(column.encoding).toBe('float64');
    expect(decodeCell(column, 0)).toEqual({ kind: 'number', value: 42, raw: '42' });
    expect(decodeCell(column, 1)).toMatchObject({ value: -2147483648 });
    expect(decodeCell(column, 2)).toMatchObject({ value: 2147483647 });
  });
});

describe('booleans and the null bitmap', () => {
  it('bit-packs booleans', () => {
    const rows = Array.from({ length: 9 }, (_, i) => [i % 2 === 0]);
    const block = encode(rows, [meta(OID.bool, 'bool')]);
    const column = block.columns[0]!;
    expect(column.encoding).toBe('bits');
    expect(column.bits?.length).toBe(2); // ceil(9/8)
    expect(decodeCell(column, 0)).toEqual({ kind: 'bool', value: true });
    expect(decodeCell(column, 1)).toEqual({ kind: 'bool', value: false });
    expect(decodeCell(column, 8)).toEqual({ kind: 'bool', value: true });
  });

  it('sizes the null bitmap to ceil(rowCount/8) and leaves the padding bits clear', () => {
    const block = encode(
      [['a'], [null], ['c'], [null], [null], [null], [null], [null], ['i']],
      [meta(OID.text, 'text')],
    );
    const column = block.columns[0]!;
    expect(column.nulls.length).toBe(2);
    // Rows 9..15 do not exist; a set padding bit would read as a phantom NULL and
    // could leak into a copy-all or a select-all.
    expect(column.nulls[1]! & 0b1111_1110).toBe(0);
    expect(isNullAt(column, 1)).toBe(true);
    expect(isNullAt(column, 0)).toBe(false);
    expect(decodeCell(column, 1)).toEqual({ kind: 'null' });
  });

  it('marks NULL in every encoding', () => {
    const columns = [
      meta(OID.int4, 'int4', 'n'),
      meta(OID.bool, 'bool', 'b'),
      meta(OID.text, 'text', 't'),
    ];
    const block = encode([[null, null, null]], columns);
    for (const column of block.columns) {
      expect(decodeCell(column, 0), column.typeName).toEqual({ kind: 'null' });
      expect(isNullAt(column, 0)).toBe(true);
    }
  });
});

describe('temporal types', () => {
  it('decodes timestamptz to an instant in UTC', () => {
    const epochMs = Date.UTC(2026, 9, 1, 5, 34, 56);
    const block = encode([[epochMs]], [meta(OID.timestamptz, 'timestamptz')]);
    const column = block.columns[0]!;
    expect(column.encoding).toBe('float64');
    expect(decodeCell(column, 0)).toEqual({ kind: 'time', epochMs, tz: 'UTC' });
  });

  it('decodes timestamp-without-timezone with an empty zone, since it has none', () => {
    const epochMs = Date.UTC(2026, 9, 1, 12, 34, 56);
    const block = encode([[epochMs]], [meta(OID.timestamp, 'timestamp')]);
    expect(decodeCell(block.columns[0]!, 0)).toEqual({ kind: 'time', epochMs, tz: '' });
  });

  it('renders the Postgres infinities as text rather than as an invalid instant', () => {
    const block = encode(
      [[Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]],
      [meta(OID.timestamptz, 'timestamptz')],
    );
    const column = block.columns[0]!;
    expect(decodeCell(column, 0)).toEqual({ kind: 'text', value: 'infinity' });
    expect(decodeCell(column, 1)).toEqual({ kind: 'text', value: '-infinity' });
  });

  it('keeps a bare date as text so no timezone can shift it', () => {
    const block = encode([['2026-10-01']], [meta(OID.date, 'date')]);
    expect(block.columns[0]!.encoding).toBe('utf8');
    expect(decodeCell(block.columns[0]!, 0)).toEqual({ kind: 'text', value: '2026-10-01' });
  });
});

describe('binary and json', () => {
  it('decodes bytea to a binary cell with a bounded preview', () => {
    const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
    const block = encode([[bytes]], [meta(OID.bytea, 'bytea')]);
    const cell = decodeCell(block.columns[0]!, 0);
    expect(cell.kind).toBe('binary');
    if (cell.kind !== 'binary') return;
    expect(cell.byteLength).toBe(100);
    expect(cell.preview.length).toBeLessThanOrEqual(32);
    expect(cell.preview[0]).toBe(0);
  });

  it('round-trips an empty bytea', () => {
    const block = encode([[new Uint8Array(0)]], [meta(OID.bytea, 'bytea')]);
    const cell = decodeCell(block.columns[0]!, 0);
    expect(cell).toMatchObject({ kind: 'binary', byteLength: 0 });
  });

  it('decodes json to a json cell carrying the full byte length', () => {
    const block = encode([['{"k":1}']], [meta(OID.jsonb, 'jsonb')]);
    const cell = decodeCell(block.columns[0]!, 0);
    expect(cell).toEqual({ kind: 'json', preview: '{"k":1}', byteLength: 7 });
  });

  it('truncates a long json preview but reports the true size', () => {
    const text = JSON.stringify({ padding: 'x'.repeat(5_000) });
    const block = encode([[text]], [meta(OID.json, 'json')]);
    const cell = decodeCell(block.columns[0]!, 0);
    if (cell.kind !== 'json') throw new Error('expected a json cell');
    expect(cell.preview.length).toBeLessThan(text.length);
    expect(cell.byteLength).toBe(new TextEncoder().encode(text).length);
  });
});

describe('encoding selection', () => {
  it('downgrades a numeric column to text when a value is not representable', () => {
    // pg hands float8 back as a number, but a custom parser or a text-mode driver
    // could hand back a string. Losing the value would be worse than losing the
    // packed encoding.
    const block = encode([['1.5'], ['2.5']], [meta(OID.float8, 'float8')]);
    const column = block.columns[0]!;
    expect(column.encoding).toBe('utf8');
    expect(decodeCell(column, 0)).toEqual({ kind: 'text', value: '1.5' });
  });

  it('treats a missing row entry as NULL rather than throwing', () => {
    const block = encode([[1], []], [meta(OID.int4, 'int4'), meta(OID.text, 'text', 'd')]);
    expect(decodeCell(block.columns[1]!, 0)).toEqual({ kind: 'null' });
  });

  it('ignores extra row entries beyond the declared columns', () => {
    const block = encode([[1, 'surplus']], [meta(OID.int4, 'int4')]);
    expect(block.columns).toHaveLength(1);
    expect(decodeCell(block.columns[0]!, 0)).toMatchObject({ value: 1 });
  });
});

describe('degenerate and hostile inputs', () => {
  it('encodes zero rows', () => {
    const block = encode([], [meta(OID.text, 'text')]);
    expect(block.rowCount).toBe(0);
    expect(block.columns[0]!.offsets).toEqual(new Uint32Array([0]));
    expect(block.columns[0]!.nulls.length).toBe(0);
    expect(decodeBlock(block).columns[0]).toEqual([]);
  });

  it('encodes zero columns', () => {
    const block = encode([[], []], []);
    expect(block.rowCount).toBe(2);
    expect(block.columns).toEqual([]);
  });

  it('returns an error cell for an out-of-range index instead of undefined', () => {
    const block = encode([['a']], [meta(OID.text, 'text')]);
    const column = block.columns[0]!;
    for (const index of [-1, 1, 99, 1.5, Number.NaN]) {
      const cell = decodeCell(column, index);
      expect(cell.kind, String(index)).toBe('error');
    }
  });

  it('carries startRow through untouched', () => {
    expect(encode([['a']], [meta(OID.text, 'text')], 799_999).startRow).toBe(799_999);
  });
});

describe('byte accounting', () => {
  it('sums exactly the buffers the block owns', () => {
    const block = encode(
      [
        ['a', 1, true],
        ['bb', 2, false],
      ],
      [meta(OID.text, 'text', 't'), meta(OID.int4, 'int4', 'n'), meta(OID.bool, 'bool', 'b')],
    );
    let expected = 0;
    for (const column of block.columns) {
      expected += column.nulls.byteLength;
      expected += column.values?.byteLength ?? 0;
      expected += column.offsets?.byteLength ?? 0;
      expected += column.bytes?.byteLength ?? 0;
      expected += column.bits?.byteLength ?? 0;
    }
    expect(blockByteLength(block)).toBe(expected);
  });

  it('reports zero for an empty block', () => {
    expect(blockByteLength(encode([], []))).toBe(0);
  });

  it('is the value the registry uses for its memory cap, so it must be an integer', () => {
    const block = encode([['abc']], [meta(OID.text, 'text')]);
    expect(Number.isInteger(blockByteLength(block))).toBe(true);
  });
});

describe('transferability', () => {
  it('survives a structured clone, which is how it crosses the IPC bridge', () => {
    const block = encode(
      [['text', 42, true, '9007199254740993', new Uint8Array([1, 2, 3])]],
      [
        meta(OID.text, 'text', 'a'),
        meta(OID.int4, 'int4', 'b'),
        meta(OID.bool, 'bool', 'c'),
        meta(OID.int8, 'int8', 'd'),
        meta(OID.bytea, 'bytea', 'e'),
      ],
    );

    const cloned = structuredClone(block);
    expect(cloned.rowCount).toBe(block.rowCount);
    for (let c = 0; c < cloned.columns.length; c += 1) {
      expect(decodeCell(cloned.columns[c]!, 0)).toEqual(decodeCell(block.columns[c]!, 0));
    }
  });

  it('holds no functions or class instances that a clone would drop', () => {
    const block = encode([['a']], [meta(OID.text, 'text')]);
    const column: EncodedColumn = block.columns[0]!;
    expect(Object.getPrototypeOf(column)).toBe(Object.prototype);
    for (const value of Object.values(column)) {
      expect(typeof value === 'function').toBe(false);
    }
  });

  it('is deterministic, so two encodes of the same rows are byte-identical', () => {
    const rows: (readonly unknown[])[] = [
      ['a', 1],
      ['bb', 2],
    ];
    const columns = [meta(OID.text, 'text', 't'), meta(OID.int4, 'int4', 'n')];
    const first = encode(rows, columns);
    const second = encode(rows, columns);
    for (let c = 0; c < first.columns.length; c += 1) {
      expect(first.columns[c]!.bytes ?? null).toEqual(second.columns[c]!.bytes ?? null);
      expect(first.columns[c]!.values ?? null).toEqual(second.columns[c]!.values ?? null);
      expect(first.columns[c]!.nulls).toEqual(second.columns[c]!.nulls);
    }
  });
});

describe('decodeBlock', () => {
  it('produces the same cells as decoding one at a time', () => {
    const columns = [
      meta(OID.text, 'text', 't'),
      meta(OID.int4, 'int4', 'n'),
      meta(OID.bool, 'bool', 'b'),
    ];
    const rows: (readonly unknown[])[] = [
      ['a', 1, true],
      [null, null, null],
      ['c', 3, false],
    ];
    const block = encode(rows, columns);
    const decoded = decodeBlock(block);

    expect(decoded.startRow).toBe(block.startRow);
    expect(decoded.rowCount).toBe(3);
    expect(decoded.columns).toHaveLength(3);
    for (let c = 0; c < columns.length; c += 1) {
      for (let r = 0; r < 3; r += 1) {
        expect(decoded.columns[c]![r]).toEqual(decodeCell(block.columns[c]!, r));
      }
    }
  });

  it('materialises every cell, which is why the renderer must not use it for a full result', () => {
    const block = encode(
      Array.from({ length: 1_000 }, (_, i) => [`row-${i}`]),
      [meta(OID.text, 'text')],
    );
    expect(decodeBlock(block).columns[0]).toHaveLength(1_000);
  });
});
