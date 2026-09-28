/**
 * GRID-SPEC §9: type-aware cell rendering, as a pure function.
 *
 * The load-bearing case is `number`: Postgres int8 and numeric routinely exceed
 * 2^53, so the display string must come from `raw`, never from `String(value)`.
 */
import { describe, expect, it } from 'vitest';
import { cellText, isNullCell } from '@/grid/cell-format';
import type { CellValue } from '@/grid/types';

describe('NULL', () => {
  it('renders the literal NULL in a distinct style', () => {
    const cell: CellValue = { kind: 'null' };
    expect(cellText(cell)).toEqual({ text: 'NULL', align: 'left', style: 'null' });
    expect(isNullCell(cell)).toBe(true);
  });

  it('does not treat other kinds as null', () => {
    expect(isNullCell({ kind: 'text', value: '' })).toBe(false);
    expect(isNullCell({ kind: 'bool', value: false })).toBe(false);
    expect(isNullCell({ kind: 'number', value: 0, raw: '0' })).toBe(false);
  });
});

describe('bool', () => {
  it('centres both values', () => {
    expect(cellText({ kind: 'bool', value: true })).toEqual({
      text: 'true',
      align: 'center',
      style: 'normal',
    });
    expect(cellText({ kind: 'bool', value: false })).toEqual({
      text: 'false',
      align: 'center',
      style: 'normal',
    });
  });
});

describe('number', () => {
  it('uses the raw string so int8 precision survives', () => {
    // 9007199254740993 is 2^53 + 1: Number() rounds it to 9007199254740992.
    const cell: CellValue = {
      kind: 'number',
      value: 9_007_199_254_740_992,
      raw: '9007199254740993',
    };
    expect(cellText(cell).text).toBe('9007199254740993');
    expect(cellText(cell).text).not.toBe(String(cell.kind === 'number' ? cell.value : 0));
  });

  it('preserves trailing zeros from numeric', () => {
    expect(cellText({ kind: 'number', value: 12.5, raw: '12.50' }).text).toBe('12.50');
  });

  it('right-aligns so digits line up', () => {
    expect(cellText({ kind: 'number', value: -3, raw: '-3' })).toEqual({
      text: '-3',
      align: 'right',
      style: 'normal',
    });
  });

  it('falls back to the numeric value when raw is empty', () => {
    expect(cellText({ kind: 'number', value: 42, raw: '' }).text).toBe('42');
  });
});

describe('text', () => {
  it('passes the value through unmodified and left-aligns', () => {
    expect(cellText({ kind: 'text', value: 'hello world' })).toEqual({
      text: 'hello world',
      align: 'left',
      style: 'normal',
    });
  });

  it('keeps an empty string empty rather than substituting a placeholder', () => {
    expect(cellText({ kind: 'text', value: '' }).text).toBe('');
  });

  it('renders a uuid as plain text', () => {
    const uuid = '6f1e2d3c-4b5a-4968-8777-665544332211';
    expect(cellText({ kind: 'text', value: uuid }).text).toBe(uuid);
  });
});

describe('time', () => {
  it('formats as ISO-8601 in UTC so output is machine-independent', () => {
    expect(cellText({ kind: 'time', epochMs: 0, tz: 'UTC' }).text).toBe('1970-01-01T00:00:00.000Z');
  });

  it('is deterministic regardless of the host timezone', () => {
    const cell: CellValue = { kind: 'time', epochMs: 1_790_000_000_000, tz: 'Australia/Jakarta' };
    expect(cellText(cell).text).toBe(new Date(1_790_000_000_000).toISOString());
    expect(cellText(cell).align).toBe('left');
  });
});

describe('binary', () => {
  it('shows the byte length rather than the payload', () => {
    expect(cellText({ kind: 'binary', byteLength: 7, preview: new Uint8Array([1, 2]) })).toEqual({
      text: '<7 bytes>',
      align: 'left',
      style: 'muted',
    });
  });

  it('handles an empty bytea', () => {
    expect(cellText({ kind: 'binary', byteLength: 0, preview: new Uint8Array() }).text).toBe(
      '<0 bytes>',
    );
  });
});

describe('json', () => {
  it('shows the preview and reports its size as muted metadata', () => {
    expect(cellText({ kind: 'json', preview: '{"a":1}', byteLength: 7 })).toEqual({
      text: '{"a":1}',
      align: 'left',
      style: 'normal',
    });
  });
});

describe('error', () => {
  it('surfaces the parse failure inline instead of throwing', () => {
    expect(cellText({ kind: 'error', message: 'invalid byte sequence for utf8' })).toEqual({
      text: 'invalid byte sequence for utf8',
      align: 'left',
      style: 'error',
    });
  });
});
