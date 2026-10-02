/**
 * Postgres type handling that must not depend on the machine's timezone, on
 * `pg`'s default parsers, or on a JS double having enough precision
 * (PLAN Phase 4, ARCHITECTURE §5.4).
 *
 * Tier 1, written test-first. The two traps this module exists to close:
 *
 *  - `timestamp without time zone` parsed by `new Date(text)` is read in the
 *    *host* timezone, so the same row renders an hour apart after a flight.
 *  - `int8` and `numeric` exceed 2^53, so they must stay text all the way to the
 *    cell; converting them to a number silently rounds.
 */
import { describe, expect, it } from 'vitest';
import {
  OID,
  encodingKindFor,
  normalizeValue,
  parseDateOnly,
  parseTimestampAsUtc,
  textFor,
  typeNameFor,
  widthHintFor,
} from '../../src/shared/pg-types';

describe('OID table', () => {
  it('matches the OIDs fixed by pg_type.dat', () => {
    expect(OID.bool).toBe(16);
    expect(OID.bytea).toBe(17);
    expect(OID.int8).toBe(20);
    expect(OID.int2).toBe(21);
    expect(OID.int4).toBe(23);
    expect(OID.text).toBe(25);
    expect(OID.json).toBe(114);
    expect(OID.float4).toBe(700);
    expect(OID.float8).toBe(701);
    expect(OID.bpchar).toBe(1042);
    expect(OID.varchar).toBe(1043);
    expect(OID.date).toBe(1082);
    expect(OID.timestamp).toBe(1114);
    expect(OID.timestamptz).toBe(1184);
    expect(OID.interval).toBe(1186);
    expect(OID.numeric).toBe(1700);
    expect(OID.uuid).toBe(2950);
    expect(OID.jsonb).toBe(3802);
  });
});

describe('typeNameFor', () => {
  it('names the types the codec treats specially', () => {
    expect(typeNameFor(OID.int4)).toBe('int4');
    expect(typeNameFor(OID.int8)).toBe('int8');
    expect(typeNameFor(OID.numeric)).toBe('numeric');
    expect(typeNameFor(OID.timestamptz)).toBe('timestamptz');
    expect(typeNameFor(OID.bool)).toBe('bool');
  });

  it('still says something useful for an OID it does not know', () => {
    // A user-defined type or an extension type must not show up as blank in the
    // column header tooltip.
    expect(typeNameFor(999_999)).toContain('999999');
  });
});

describe('encodingKindFor', () => {
  it('packs the exact numeric types into a Float64Array', () => {
    for (const oid of [OID.int2, OID.int4, OID.float4, OID.float8]) {
      expect(encodingKindFor(oid), typeNameFor(oid)).toBe('float64');
    }
  });

  it('keeps int8 and numeric as text, because a double cannot hold them', () => {
    expect(encodingKindFor(OID.int8)).toBe('utf8');
    expect(encodingKindFor(OID.numeric)).toBe('utf8');
  });

  it('bit-packs booleans', () => {
    expect(encodingKindFor(OID.bool)).toBe('bits');
  });

  it('stores temporal instants as epoch milliseconds', () => {
    for (const oid of [OID.timestamp, OID.timestamptz]) {
      expect(encodingKindFor(oid), typeNameFor(oid)).toBe('float64');
    }
  });

  it('keeps a bare date as text, because it has no timezone to anchor an epoch to', () => {
    // Encoding `2026-10-01` as midnight-somewhere would render as 2026-09-30 in
    // any negative-offset zone.
    expect(encodingKindFor(OID.date)).toBe('utf8');
  });

  it('stores everything else, including unknown OIDs, as text', () => {
    for (const oid of [
      OID.text,
      OID.varchar,
      OID.bpchar,
      OID.json,
      OID.jsonb,
      OID.bytea,
      OID.uuid,
      OID.interval,
      999_999,
    ]) {
      expect(encodingKindFor(oid), String(oid)).toBe('utf8');
    }
  });
});

describe('parseTimestampAsUtc', () => {
  it('reads a timestamp-without-timezone as UTC, not as host-local time', () => {
    expect(parseTimestampAsUtc('2026-10-01 12:34:56')).toBe(Date.UTC(2026, 9, 1, 12, 34, 56));
    expect(parseTimestampAsUtc('2026-01-01 00:00:00')).toBe(Date.UTC(2026, 0, 1));
  });

  it('truncates sub-millisecond precision rather than rounding it', () => {
    expect(parseTimestampAsUtc('2026-10-01 12:34:56.123456')).toBe(
      Date.UTC(2026, 9, 1, 12, 34, 56, 123),
    );
    expect(parseTimestampAsUtc('2026-10-01 12:34:56.999999')).toBe(
      Date.UTC(2026, 9, 1, 12, 34, 56, 999),
    );
    expect(parseTimestampAsUtc('2026-10-01 12:34:56.5')).toBe(
      Date.UTC(2026, 9, 1, 12, 34, 56, 500),
    );
  });

  it('accepts the ISO separator as well as a space', () => {
    expect(parseTimestampAsUtc('2026-10-01T12:34:56')).toBe(Date.UTC(2026, 9, 1, 12, 34, 56));
  });

  it('applies an explicit offset when the server sends one', () => {
    expect(parseTimestampAsUtc('2026-10-01 12:34:56+07')).toBe(Date.UTC(2026, 9, 1, 5, 34, 56));
    expect(parseTimestampAsUtc('2026-10-01 12:34:56+07:30')).toBe(Date.UTC(2026, 9, 1, 5, 4, 56));
    expect(parseTimestampAsUtc('2026-10-01 12:34:56-05')).toBe(Date.UTC(2026, 9, 1, 17, 34, 56));
    expect(parseTimestampAsUtc('2026-10-01 12:34:56Z')).toBe(Date.UTC(2026, 9, 1, 12, 34, 56));
  });

  it('represents the two Postgres infinities as infinities, not as null', () => {
    // Turning `infinity` into NULL would silently lose a value the user can see in
    // psql. The codec turns a non-finite number into the type's own text spelling,
    // which is asserted separately below.
    expect(parseTimestampAsUtc('infinity')).toBe(Number.POSITIVE_INFINITY);
    expect(parseTimestampAsUtc('-infinity')).toBe(Number.NEGATIVE_INFINITY);
  });

  it('returns null for NULL, empty and unparseable input — never NaN', () => {
    for (const bad of [null, undefined, '', '   ', 'not a timestamp', '2026-13-45 99:99:99']) {
      expect(parseTimestampAsUtc(bad as string | null), String(bad)).toBeNull();
    }
  });

  it('does not fall into the two-digit-year mapping for years below 100', () => {
    // Date.UTC(1, …) means 1901, which would silently move an ancient timestamp
    // by nineteen centuries.
    const d = new Date(0);
    d.setUTCFullYear(1, 0, 1);
    d.setUTCHours(0, 0, 0, 0);
    expect(parseTimestampAsUtc('0001-01-01 00:00:00')).toBe(d.getTime());
    expect(parseTimestampAsUtc('0001-01-01 00:00:00')).not.toBe(Date.UTC(1, 0, 1));
  });
});

describe('parseDateOnly', () => {
  it('returns the calendar text unchanged, so no timezone can shift it', () => {
    expect(parseDateOnly('2026-10-01')).toBe('2026-10-01');
    // A Date built from this in a negative-offset zone renders as 2026-09-30.
    expect(parseDateOnly('0001-01-01')).toBe('0001-01-01');
    expect(parseDateOnly('9999-12-31')).toBe('9999-12-31');
  });

  it('passes the infinities through as text', () => {
    expect(parseDateOnly('infinity')).toBe('infinity');
    expect(parseDateOnly('-infinity')).toBe('-infinity');
  });

  it('returns null for NULL, empty and unparseable input', () => {
    for (const bad of [null, undefined, '', 'nope', '2026-1-1x']) {
      expect(parseDateOnly(bad as string | null), String(bad)).toBeNull();
    }
  });
});

describe('normalizeValue', () => {
  it('maps SQL NULL and JS undefined to the null case', () => {
    expect(normalizeValue(OID.text, null)).toEqual({ kind: 'null' });
    expect(normalizeValue(OID.text, undefined)).toEqual({ kind: 'null' });
  });

  it('keeps a finite number numeric', () => {
    expect(normalizeValue(OID.int4, 42)).toEqual({ kind: 'num', value: 42 });
    expect(normalizeValue(OID.float8, -1.5)).toEqual({ kind: 'num', value: -1.5 });
  });

  it('turns a JS infinity into text, since Postgres has no such numeric value', () => {
    expect(normalizeValue(OID.float8, Number.POSITIVE_INFINITY)).toEqual({
      kind: 'text',
      value: 'Infinity',
    });
    expect(normalizeValue(OID.float8, Number.NaN)).toEqual({ kind: 'text', value: 'NaN' });
  });

  it('uses each type’s own spelling for the infinities', () => {
    // Postgres prints float8 as `Infinity` and a timestamp as `infinity`. Showing
    // one with the other's spelling would not paste back into SQL.
    expect(normalizeValue(OID.timestamptz, Number.POSITIVE_INFINITY)).toEqual({
      kind: 'text',
      value: 'infinity',
    });
    expect(normalizeValue(OID.timestamp, Number.NEGATIVE_INFINITY)).toEqual({
      kind: 'text',
      value: '-infinity',
    });
    expect(normalizeValue(OID.float8, Number.NEGATIVE_INFINITY)).toEqual({
      kind: 'text',
      value: '-Infinity',
    });
  });

  it('preserves int8 and numeric text verbatim, including digits beyond 2^53', () => {
    expect(normalizeValue(OID.int8, '9007199254740993')).toEqual({
      kind: 'text',
      value: '9007199254740993',
    });
    expect(normalizeValue(OID.numeric, '12345678901234567890.1234567890')).toEqual({
      kind: 'text',
      value: '12345678901234567890.1234567890',
    });
    expect(textFor(normalizeValue(OID.numeric, '1e1000'))).toBe('1e1000');
  });

  it('keeps booleans boolean', () => {
    expect(normalizeValue(OID.bool, true)).toEqual({ kind: 'bool', value: true });
    expect(normalizeValue(OID.bool, false)).toEqual({ kind: 'bool', value: false });
  });

  it('accepts the text forms of a boolean, which a driver in text mode returns', () => {
    expect(normalizeValue(OID.bool, 't')).toEqual({ kind: 'bool', value: true });
    expect(normalizeValue(OID.bool, 'f')).toEqual({ kind: 'bool', value: false });
    expect(normalizeValue(OID.bool, 'true')).toEqual({ kind: 'bool', value: true });
    // Not a boolean spelling: leave it as text rather than guessing false.
    expect(normalizeValue(OID.bool, 'maybe')).toEqual({ kind: 'text', value: 'maybe' });
  });

  it('decodes bytea that arrives as Postgres hex text', () => {
    expect(normalizeValue(OID.bytea, '\\x0001ff')).toEqual({
      kind: 'bytes',
      value: new Uint8Array([0, 1, 255]),
    });
    expect(normalizeValue(OID.bytea, '\\x')).toEqual({ kind: 'bytes', value: new Uint8Array([]) });
    // Odd-length or non-hex text is data, not a failed decode.
    expect(normalizeValue(OID.bytea, '\\xzz')).toEqual({ kind: 'text', value: '\\xzz' });
  });

  it('converts a Date to epoch milliseconds', () => {
    const date = new Date(Date.UTC(2026, 9, 1, 12));
    expect(normalizeValue(OID.timestamptz, date)).toEqual({ kind: 'num', value: date.getTime() });
  });

  it('turns an invalid Date into text rather than NaN', () => {
    expect(normalizeValue(OID.timestamptz, new Date('nonsense'))).toEqual({
      kind: 'text',
      value: 'Invalid Date',
    });
  });

  it('serialises json and jsonb to text', () => {
    expect(normalizeValue(OID.json, { k: 1 })).toEqual({ kind: 'text', value: '{"k":1}' });
    expect(normalizeValue(OID.jsonb, [1, 2])).toEqual({ kind: 'text', value: '[1,2]' });
  });

  it('keeps bytea as bytes', () => {
    const bytes = new Uint8Array([0, 1, 255]);
    const normalized = normalizeValue(OID.bytea, bytes);
    expect(normalized.kind).toBe('bytes');
    expect(textFor(normalized)).toBe('0001ff');
  });

  it('stringifies an array type the way psql renders it, not as JSON', () => {
    expect(textFor(normalizeValue(1007, [1, 2, 3]))).toBe('{1,2,3}');
    expect(textFor(normalizeValue(1009, ['a', 'b']))).toBe('{a,b}');
    expect(textFor(normalizeValue(1007, []))).toBe('{}');
  });

  it('quotes array elements that would otherwise be ambiguous', () => {
    // An unquoted comma or brace would change the array's shape on the way back in.
    expect(textFor(normalizeValue(1009, ['a,b', 'b c', '', 'q"q', 'sl\\ash']))).toBe(
      '{"a,b","b c","","q\\"q","sl\\\\ash"}',
    );
  });

  it('renders NULL inside an array as NULL, not as an empty element', () => {
    expect(textFor(normalizeValue(1007, [1, null, 3]))).toBe('{1,NULL,3}');
  });

  it('renders a nested array', () => {
    expect(
      textFor(
        normalizeValue(1007, [
          [1, 2],
          [3, 4],
        ]),
      ),
    ).toBe('{{1,2},{3,4}}');
  });

  it('renders a JS array as JSON when the column is json, not as an array literal', () => {
    // The same JS value means two different things depending on the column type,
    // and picking wrong would show `[1,2]` in a Postgres array column (which does
    // not paste back into SQL) or `{1,2}` in a json column (which is not valid JSON).
    expect(textFor(normalizeValue(OID.json, [1, 2]))).toBe('[1,2]');
    expect(textFor(normalizeValue(OID.jsonb, [1, 2]))).toBe('[1,2]');
    expect(textFor(normalizeValue(1007, [1, 2]))).toBe('{1,2}');
  });

  it('survives a circular JSON value without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => normalizeValue(OID.json, circular)).not.toThrow();
    expect(textFor(normalizeValue(OID.json, circular))).toContain('[circular]');
  });
});

describe('widthHintFor', () => {
  it('stays inside the grid column clamp for every known type', () => {
    for (const oid of Object.values(OID)) {
      const hint = widthHintFor(oid);
      expect(hint, typeNameFor(oid)).toBeGreaterThanOrEqual(40);
      expect(hint, typeNameFor(oid)).toBeLessThanOrEqual(400);
    }
  });

  it('gives room in proportion to the widest value the type can hold', () => {
    expect(widthHintFor(OID.bool)).toBeLessThan(widthHintFor(OID.int4));
    expect(widthHintFor(OID.int4)).toBeLessThan(widthHintFor(OID.int8));
    expect(widthHintFor(OID.int8)).toBeLessThanOrEqual(widthHintFor(OID.numeric));
    expect(widthHintFor(OID.date)).toBeLessThan(widthHintFor(OID.timestamptz));
    expect(widthHintFor(OID.int4)).toBeLessThan(widthHintFor(OID.text));
    expect(widthHintFor(OID.uuid)).toBeGreaterThan(widthHintFor(OID.int4));
  });

  it('has a sane default for an unknown OID', () => {
    const hint = widthHintFor(999_999);
    expect(hint).toBeGreaterThanOrEqual(40);
    expect(hint).toBeLessThanOrEqual(400);
  });
});
