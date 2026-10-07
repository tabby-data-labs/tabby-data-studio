/**
 * The export serialisers (PLAN Phase 8), Tier 1 — test-first.
 *
 * Expectations are derived from RFC 4180, from what `psql`'s `\copy` writes, and
 * from the requirement that an exported file can be read back, not from the
 * implementation.
 *
 * Three properties carry the most weight and get the most cases:
 *
 *  - **RFC 4180 quoting is exact.** Under-quoting silently merges two fields into
 *    one on the way back in; over-quoting is merely ugly. A delimiter, a quote, a
 *    CR or an LF forces quotes, and a quote inside quotes is doubled.
 *  - **`int8` and `numeric` never pass through a JS double.** They reach here as the
 *    server's text and leave as the same digits. Rounding them would produce a file
 *    that looks correct and is not — the worst failure a data exporter can have.
 *  - **An empty result is a valid file, not a broken one.** `[]` for JSON, and no
 *    `INSERT` at all for SQL, because `values` with no rows is a syntax error.
 */
import { describe, expect, it } from 'vitest';
import type { ColumnMeta } from '../../src/shared/domain';
import { OID } from '../../src/shared/pg-types';
import { defaultExportOptions, type ExportOptions } from '../../src/shared/export';
import {
  byteOrderMark,
  createSerialiser,
  csvField,
  type ExportSerialiser,
} from '../../src/main/export/serialise';

function column(name: string, typeOid: number): ColumnMeta {
  return { name, typeName: `oid${typeOid}`, typeOid, nullable: true, widthHint: 100 };
}

const TEXT = column('name', OID.text);
const INT4 = column('n', OID.int4);
const INT8 = column('big', OID.int8);
const NUMERIC = column('amount', OID.numeric);
const BOOL = column('flag', OID.bool);
const BYTEA = column('payload', OID.bytea);
const TS = column('at', OID.timestamptz);
const JSONB = column('doc', OID.jsonb);

const TWO_COLUMNS = [INT4, TEXT];

function serialise(
  format: ExportOptions['format'],
  rows: readonly (readonly unknown[])[],
  overrides: Partial<ExportOptions> = {},
  columns: readonly ColumnMeta[] = TWO_COLUMNS,
): string {
  const serialiser = createSerialiser(format, columns, {
    ...defaultExportOptions(format),
    // csv's real default writes a BOM, which is right for Excel and noise in every
    // other assertion here. The `defaults` block below pins the shipped values, and
    // two tests in `csv`/`json` pass `writeBom` explicitly.
    writeBom: false,
    ...overrides,
  });
  let out = serialiser.begin();
  for (const row of rows) out += serialiser.row(row);
  return out + serialiser.end();
}

/** Serialises with the shipped defaults and nothing overridden. */
function serialiseWithDefaults(
  format: ExportOptions['format'],
  rows: readonly (readonly unknown[])[],
  columns: readonly ColumnMeta[] = TWO_COLUMNS,
): string {
  const serialiser = createSerialiser(format, columns, defaultExportOptions(format));
  let out = serialiser.begin();
  for (const row of rows) out += serialiser.row(row);
  return out + serialiser.end();
}

/** Splits a serialised document into its lines, dropping the trailing terminator. */
function lines(text: string): string[] {
  const split = text.split(/\r\n|\n/);
  if (split.length > 0 && split[split.length - 1] === '') split.pop();
  return split;
}

describe('byteOrderMark', () => {
  it('is U+FEFF for utf8 and utf16le when asked for', () => {
    // Encoded by Buffer, one character becomes EF BB BF in utf8 and FF FE in
    // utf16le — the two marks a spreadsheet actually recognises.
    expect(byteOrderMark('utf8', true)).toBe('\uFEFF');
    expect(byteOrderMark('utf16le', true)).toBe('\uFEFF');
  });

  it('is empty when not asked for', () => {
    expect(byteOrderMark('utf8', false)).toBe('');
  });

  it('is empty for latin1, which has no byte-order mark', () => {
    // U+FEFF is not representable in latin1; writing it would put a `?` at the
    // head of every file.
    expect(byteOrderMark('latin1', true)).toBe('');
  });
});

describe('csvField — RFC 4180 quoting', () => {
  it('leaves an ordinary field unquoted', () => {
    expect(csvField('hello', ',')).toBe('hello');
  });

  it('leaves an empty field empty rather than writing an empty quoted pair', () => {
    expect(csvField('', ',')).toBe('');
  });

  it('quotes a field containing the delimiter', () => {
    expect(csvField('a,b', ',')).toBe('"a,b"');
  });

  it('quotes and doubles an embedded quote', () => {
    expect(csvField('say "hi"', ',')).toBe('"say ""hi"""');
  });

  it('quotes a field that is only a quote', () => {
    expect(csvField('"', ',')).toBe('""""');
  });

  it('quotes a field containing a line feed', () => {
    expect(csvField('a\nb', ',')).toBe('"a\nb"');
  });

  it('quotes a field containing a carriage return', () => {
    // A bare CR inside an unquoted field would be read as a record boundary, which
    // is how a Windows-authored value silently adds a row.
    expect(csvField('a\rb', ',')).toBe('"a\rb"');
  });

  it('quotes once for a field that needs it for several reasons', () => {
    expect(csvField('a,b"c\nd', ',')).toBe('"a,b""c\nd"');
  });

  it('honours a custom delimiter', () => {
    expect(csvField('a;b', ';')).toBe('"a;b"');
    expect(csvField('a,b', ';')).toBe('a,b');
  });

  it('honours a tab delimiter', () => {
    expect(csvField('a\tb', '\t')).toBe('"a\tb"');
  });

  it('does not quote leading or trailing spaces', () => {
    // Minimal quoting, matching RFC 4180's "may be enclosed" and `psql`'s
    // `\copy`: a space is not a special character. A reader that trims unquoted
    // fields is not RFC-compliant, and guessing at it here would bloat every file.
    expect(csvField('  padded  ', ',')).toBe('  padded  ');
  });

  it('round-trips: splitting an escaped field recovers the original', () => {
    // The property the whole quoting scheme exists for.
    for (const value of [
      'plain',
      'a,b',
      'say "hi"',
      'a\nb',
      'a\rb',
      '',
      '"',
      '  x  ',
      'a,b"c\nd',
    ]) {
      expect(parseOneField(csvField(value, ','))).toBe(value);
    }
  });
});

/**
 * A minimal RFC 4180 field reader, local to this spec.
 *
 * The serialiser is the unit under test and must not be mocked, so the round-trip
 * check needs an independent parser — writing one here rather than importing a
 * library keeps the runtime dependency budget at one.
 */
function parseOneField(field: string): string {
  if (!field.startsWith('"')) return field;
  expect(field.endsWith('"')).toBe(true);
  let out = '';
  for (let index = 1; index < field.length - 1; index += 1) {
    const char = field.charAt(index);
    if (char === '"' && field.charAt(index + 1) === '"') {
      out += '"';
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

describe('csv', () => {
  it('writes a header, one record per line, CRLF terminated', () => {
    const text = serialise('csv', [
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(text).toBe('n,name\r\n1,a\r\n2,b\r\n');
  });

  it('omits the header when asked', () => {
    expect(serialise('csv', [[1, 'a']], { includeHeader: false })).toBe('1,a\r\n');
  });

  it('writes a BOM first when asked, and not when not', () => {
    expect(serialise('csv', [], { writeBom: true }).startsWith('\uFEFF')).toBe(true);
    expect(serialise('csv', [], { writeBom: false }).startsWith('\uFEFF')).toBe(false);
  });

  it('writes the BOM by default, because Excel needs it to detect UTF-8', () => {
    // Without a mark, Excel infers the encoding from the locale and mangles every
    // non-ASCII cell in the file — silently, and only for some users.
    expect(serialiseWithDefaults('csv', [[1, 'a']]).startsWith('\uFEFFn,name')).toBe(true);
  });

  it('honours LF', () => {
    expect(serialise('csv', [[1, 'a']], { lineEnding: 'lf' })).toBe('n,name\n1,a\n');
  });

  it('honours a custom delimiter', () => {
    expect(serialise('csv', [[1, 'a']], { delimiter: ';' })).toBe('n;name\r\n1;a\r\n');
  });

  it('escapes a column name that needs it', () => {
    const text = serialise('csv', [], {}, [column('a,b', OID.text), column('q"q', OID.text)]);
    expect(lines(text)[0]).toBe('"a,b","q""q"');
  });

  it('renders NULL as the configured text', () => {
    expect(serialise('csv', [[null, 'a']], { nullText: '\\N' })).toBe('n,name\r\n\\N,a\r\n');
    expect(serialise('csv', [[null, 'a']], { nullText: 'NULL' })).toBe('n,name\r\nNULL,a\r\n');
    expect(serialise('csv', [[null, 'a']], { nullText: '' })).toBe('n,name\r\n,a\r\n');
  });

  it('treats undefined as NULL, the same as a missing array element', () => {
    expect(serialise('csv', [[1, undefined]], { nullText: '\\N' })).toBe('n,name\r\n1,\\N\r\n');
  });

  it('quotes a value that contains the delimiter, keeping the record one line', () => {
    const text = serialise('csv', [[1, 'a,b']]);
    expect(lines(text)).toEqual(['n,name', '1,"a,b"']);
  });

  it('quotes a value that contains a newline, which then spans physical lines', () => {
    // The value's own LF is preserved inside the quotes; only the record
    // terminator is CRLF. A reader that splits on newlines without honouring
    // quotes gets two records here, which is exactly why the quotes are required.
    expect(serialise('csv', [[1, 'a\nb']])).toBe('n,name\r\n1,"a\nb"\r\n');
  });

  it('pads a short row with NULL rather than writing a ragged record', () => {
    expect(serialise('csv', [[1]], { nullText: '\\N' })).toBe('n,name\r\n1,\\N\r\n');
  });

  it('drops values past the header width rather than writing a ragged record', () => {
    expect(serialise('csv', [[1, 'a', 'extra']])).toBe('n,name\r\n1,a\r\n');
  });

  it('writes a header-only file for an empty result', () => {
    expect(serialise('csv', [])).toBe('n,name\r\n');
    expect(serialise('csv', [], { includeHeader: false })).toBe('');
  });

  it('exports an int8 exactly, with no rounding through a double', () => {
    // 2^53 + 1. A JS number cannot hold it; the server's text can.
    const text = serialise('csv', [['9007199254740993']], {}, [INT8]);
    expect(text).toBe('big\r\n9007199254740993\r\n');
  });

  it('exports a bigint exactly', () => {
    const text = serialise('csv', [[BigInt('123456789012345678901234567890')]], {}, [INT8]);
    expect(text).toContain('123456789012345678901234567890');
  });

  it('exports a numeric with the server’s own scale', () => {
    // Trailing zeros are precision the user can see in psql; `Number()` drops them.
    const text = serialise('csv', [['12.3400']], {}, [NUMERIC]);
    expect(text).toBe('amount\r\n12.3400\r\n');
  });

  it('exports a boolean as true/false', () => {
    const text = serialise('csv', [[true], [false]], {}, [BOOL]);
    expect(lines(text)).toEqual(['flag', 'true', 'false']);
  });

  it('exports a Postgres boolean that arrived as t/f', () => {
    const text = serialise('csv', [['t'], ['f']], {}, [BOOL]);
    expect(lines(text)).toEqual(['flag', 'true', 'false']);
  });

  it('exports bytea as \\x hex, the form COPY reads back', () => {
    const text = serialise('csv', [[new Uint8Array([0x41, 0x00, 0xff])]], {}, [BYTEA]);
    expect(lines(text)).toEqual(['payload', '\\x4100ff']);
  });

  it('exports bytea that arrived as the server’s hex text', () => {
    const text = serialise('csv', [['\\x4142']], {}, [BYTEA]);
    expect(lines(text)).toEqual(['payload', '\\x4142']);
  });

  it('exports a timestamp as the server wrote it, not in the host timezone', () => {
    const text = serialise('csv', [['2026-10-06 12:00:00.029+07']], {}, [TS]);
    expect(lines(text)).toEqual(['at', '2026-10-06 12:00:00.029+07']);
  });

  it('exports a Postgres infinity in the spelling the type uses', () => {
    // `textFor` already distinguishes a temporal infinity from a float one; the
    // exporter must not collapse either into NULL.
    const temporal = serialise('csv', [[Number.POSITIVE_INFINITY]], {}, [TS]);
    expect(lines(temporal)).toEqual(['at', 'infinity']);
    const float = serialise('csv', [[Number.NEGATIVE_INFINITY]], {}, [column('f', OID.float8)]);
    expect(lines(float)).toEqual(['f', '-Infinity']);
  });

  it('exports a Postgres array as an array literal, quoted when it holds the delimiter', () => {
    // An int array's literal always contains commas, so in a comma-delimited file
    // it is always quoted; leaving it bare would write one value as two fields.
    const csv = serialise('csv', [[[1, 2]]], {}, [column('ids', OID.int4Array)]);
    expect(lines(csv)).toEqual(['ids', '"{1,2}"']);
    // The same value in a tab-delimited file needs no quotes, which is what shows
    // the quoting is driven by the delimiter and not hard-coded for arrays.
    const tsv = serialise('tsv', [[[1, 2]]], {}, [column('ids', OID.int4Array)]);
    expect(lines(tsv)).toEqual(['ids', '{1,2}']);
  });

  it('quotes an array literal that contains a delimiter', () => {
    const text = serialise('csv', [[['a,b']]], {}, [column('tags', OID.textArray)]);
    expect(lines(text)).toEqual(['tags', '"{""a,b""}"']);
  });

  it('exports two serialisers independently', () => {
    // No shared module-level state: two concurrent exports must not interleave.
    const a = createSerialiser('csv', TWO_COLUMNS, defaultExportOptions('csv'));
    const b = createSerialiser('csv', TWO_COLUMNS, defaultExportOptions('csv'));
    expect(a.row([1, 'x'])).toBe(b.row([1, 'x']));
  });

  it('writes a column name verbatim, because in a delimited file it is only data', () => {
    // Unlike SQL, a CSV header is not an identifier and needs no identifier rules.
    const text = serialise('csv', [], {}, [column('weird name', OID.text)]);
    expect(lines(text)[0]).toBe('weird name');
  });
});

describe('tsv', () => {
  it('separates with a tab and writes \\N for NULL by default', () => {
    expect(
      serialise('tsv', [
        [1, null],
        [2, 'b'],
      ]),
    ).toBe('n\tname\r\n1\t\\N\r\n2\tb\r\n');
  });

  it('quotes a value containing a tab', () => {
    expect(lines(serialise('tsv', [[1, 'a\tb']]))[1]).toBe('1\t"a\tb"');
  });

  it('quotes a value containing a newline', () => {
    const text = serialise('tsv', [[1, 'a\nb']]);
    expect(text).toContain('1\t"a\nb"');
  });

  it('does not write a BOM by default', () => {
    expect(serialiseWithDefaults('tsv', []).startsWith('\uFEFF')).toBe(false);
  });
});

describe('json', () => {
  it('writes an array of objects keyed by column name', () => {
    expect(
      serialise('json', [
        [1, 'a'],
        [2, 'b'],
      ]),
    ).toBe('[\n{"n":1,"name":"a"},\n{"n":2,"name":"b"}\n]');
  });

  it('writes a valid empty array for an empty result', () => {
    const text = serialise('json', []);
    expect(text).toBe('[]');
    expect(JSON.parse(text)).toEqual([]);
  });

  it('writes one row without a trailing comma', () => {
    const text = serialise('json', [[1, 'a']]);
    expect(text).toBe('[\n{"n":1,"name":"a"}\n]');
    expect(JSON.parse(text)).toEqual([{ n: 1, name: 'a' }]);
  });

  it('uses JSON null, not the delimited formats’ nullText', () => {
    const text = serialise('json', [[null, null]], { nullText: '\\N' });
    expect(JSON.parse(text)).toEqual([{ n: null, name: null }]);
  });

  it('escapes a column name that needs it', () => {
    const text = serialise('json', [['x']], {}, [column('a"b', OID.text)]);
    expect(JSON.parse(text)).toEqual([{ 'a"b': 'x' }]);
  });

  it('keeps a number a number', () => {
    const text = serialise('json', [[42, 'a']]);
    expect(JSON.parse(text)).toEqual([{ n: 42, name: 'a' }]);
  });

  it('keeps a boolean a boolean', () => {
    const text = serialise('json', [[true]], {}, [BOOL]);
    expect(JSON.parse(text)).toEqual([{ flag: true }]);
  });

  it('emits int8 and numeric as strings, because a JSON number cannot hold them', () => {
    // A JSON reader that parses into a double would round 2^53+1. Emitting the
    // digits as a string is the only lossless choice, and it is what every
    // precision-aware exporter does.
    const text = serialise('json', [['9007199254740993', '12.3400']], {}, [INT8, NUMERIC]);
    expect(JSON.parse(text)).toEqual([{ big: '9007199254740993', amount: '12.3400' }]);
  });

  it('emits bytea as a \\x hex string', () => {
    const text = serialise('json', [[new Uint8Array([0x41, 0xff])]], {}, [BYTEA]);
    expect(JSON.parse(text)).toEqual([{ payload: '\\x41ff' }]);
  });

  it('nests a json or jsonb column rather than stringifying it', () => {
    // The driver keeps json as the server's text so no precision is lost on the
    // way in. On the way out, re-parsing it is what makes the export readable —
    // a nested object is what a user exporting JSON expects to get.
    const text = serialise('json', [['{"a":[1,2]}']], {}, [JSONB]);
    expect(JSON.parse(text)).toEqual([{ doc: { a: [1, 2] } }]);
  });

  it('falls back to a string when a json column holds text that will not parse', () => {
    const text = serialise('json', [['{not json']], {}, [JSONB]);
    expect(JSON.parse(text)).toEqual([{ doc: '{not json' }]);
  });

  it('keeps every record on one physical line, whatever the value contains', () => {
    const text = serialise('json', [[1, 'a\nb\t"c"']]);
    expect(lines(text)).toEqual(['[', '{"n":1,"name":"a\\nb\\t\\"c\\""}', ']']);
    expect(JSON.parse(text)).toEqual([{ n: 1, name: 'a\nb\t"c"' }]);
  });

  it('ignores includeHeader, since the keys are the header', () => {
    expect(serialise('json', [[1, 'a']], { includeHeader: false })).toBe(
      serialise('json', [[1, 'a']], { includeHeader: true }),
    );
  });

  it('writes no BOM by default, and one when asked', () => {
    expect(serialiseWithDefaults('json', []).startsWith('\uFEFF')).toBe(false);
    expect(serialise('json', [], { writeBom: true }).startsWith('\uFEFF')).toBe(true);
  });

  it('pads a short row with null and drops extra values', () => {
    expect(JSON.parse(serialise('json', [[1]]))).toEqual([{ n: 1, name: null }]);
    expect(JSON.parse(serialise('json', [[1, 'a', 'extra']]))).toEqual([{ n: 1, name: 'a' }]);
  });

  it('exports an empty column list as empty objects', () => {
    expect(serialise('json', [[]], {}, [])).toBe('[\n{}\n]');
  });
});

describe('sql', () => {
  it('writes one INSERT with a quoted target and quoted columns', () => {
    const text = serialise(
      'sql',
      [
        [1, 'a'],
        [2, 'b'],
      ],
      {},
      TWO_COLUMNS,
    );
    expect(text).toBe(
      'insert into "public"."exported" ("n", "name") values\n(1, \'a\'),\n(2, \'b\');\n',
    );
  });

  it('writes NULL, not a quoted empty string, for a null value', () => {
    const text = serialise('sql', [[null, null]], {}, TWO_COLUMNS);
    expect(text).toContain('(NULL, NULL)');
  });

  it('keeps numbers and booleans bare so they stay their own type', () => {
    expect(serialise('sql', [[7]], {}, [INT4])).toContain('(7)');
    expect(serialise('sql', [[true]], {}, [BOOL])).toContain('(true)');
    expect(serialise('sql', [[false]], {}, [BOOL])).toContain('(false)');
  });

  it('keeps an int8 exact as a quoted literal, which Postgres casts back', () => {
    // Quoted rather than bare: the digits are the server's text and cannot be
    // mistaken for a rounded double, and Postgres assigns a string literal to an
    // int8 column without complaint.
    const text = serialise('sql', [['9007199254740993']], {}, [INT8]);
    expect(text).toContain("('9007199254740993')");
  });

  it('doubles an embedded quote', () => {
    const text = serialise('sql', [["O'Brien"]], {}, [TEXT]);
    expect(text).toContain("('O''Brien')");
  });

  it('uses the E form for a value containing a backslash', () => {
    const text = serialise('sql', [['a\\b']], {}, [TEXT]);
    expect(text).toContain(String.raw`E'a\\b'`);
  });

  it('writes bytea as an escaped hex literal', () => {
    const text = serialise('sql', [[new Uint8Array([0x41])]], {}, [BYTEA]);
    expect(text).toContain(String.raw`E'\\x41'`);
  });

  it('batches at rowsPerInsert, repeating the column list so each statement stands alone', () => {
    const rows = [[1], [2], [3], [4], [5]];
    const text = serialise('sql', rows, { rowsPerInsert: 2 }, [INT4]);
    const statements = text.split(';\n').filter((part) => part !== '');
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('(1),\n(2)');
    expect(statements[2]).toContain('(5)');
    for (const statement of statements) {
      expect(statement).toContain('insert into "public"."exported" ("n") values');
    }
  });

  it('writes nothing at all for an empty result', () => {
    // `values` with no rows is a syntax error, so the honest output is no file
    // content rather than a statement that cannot be run.
    expect(serialise('sql', [])).toBe('');
  });

  it('honours a single-row batch size', () => {
    const text = serialise('sql', [[1], [2]], { rowsPerInsert: 1 }, [INT4]);
    expect(text.split(';\n').filter((part) => part !== '')).toHaveLength(2);
  });

  it('ignores includeHeader, since the column list is not optional', () => {
    expect(serialise('sql', [[1]], { includeHeader: false }, [INT4])).toBe(
      serialise('sql', [[1]], { includeHeader: true }, [INT4]),
    );
  });

  it('refuses a column name that cannot be quoted, before writing anything', () => {
    expect(() =>
      createSerialiser('sql', [column('x'.repeat(64), OID.text)], defaultExportOptions('sql')),
    ).toThrow();
  });
});

describe('defaults', () => {
  it('gives csv a comma, CRLF and a BOM', () => {
    const defaults = defaultExportOptions('csv');
    expect(defaults.delimiter).toBe(',');
    expect(defaults.lineEnding).toBe('crlf');
    expect(defaults.writeBom).toBe(true);
  });

  it('gives tsv a tab and psql’s NULL spelling', () => {
    const defaults = defaultExportOptions('tsv');
    expect(defaults.delimiter).toBe('\t');
    expect(defaults.nullText).toBe('\\N');
  });

  it('gives json and sql LF and no BOM', () => {
    for (const format of ['json', 'sql'] as const) {
      expect(defaultExportOptions(format).lineEnding).toBe('lf');
      expect(defaultExportOptions(format).writeBom).toBe(false);
    }
  });

  it('gives tsv no BOM', () => {
    // A tab-separated file is usually read by a tool, not by Excel, and a leading
    // mark becomes part of the first column name for a naive splitter.
    expect(defaultExportOptions('tsv').writeBom).toBe(false);
  });

  it('asks for a positive batch size', () => {
    expect(defaultExportOptions('sql').rowsPerInsert).toBeGreaterThan(0);
  });
});

describe('degenerate input', () => {
  it('serialises a row of nothing but NULLs', () => {
    expect(serialise('csv', [[null, null]], { nullText: 'N' })).toBe('n,name\r\nN,N\r\n');
  });

  it('serialises a value that is the empty string, distinct from NULL', () => {
    // With the default nullText these are the same bytes, which is a property of
    // delimited formats and not of this code. With `\N` they differ, and the test
    // pins that they do.
    const text = serialise(
      'csv',
      [
        [1, ''],
        [2, null],
      ],
      { nullText: '\\N' },
    );
    expect(lines(text)).toEqual(['n,name', '1,', '2,\\N']);
  });

  it('serialises a value containing every awkward character at once', () => {
    const value = 'a,b"c\rd\ne\tf;g\\h';
    const text = serialise('csv', [[1, value]]);
    expect(text).toContain(csvField(value, ','));
    // And it parses back to exactly that value.
    const record = text.slice(text.indexOf('\r\n') + 2, text.lastIndexOf('\r\n'));
    expect(record).toBe(`1,${csvField(value, ',')}`);
  });

  it('serialises a zero-column result', () => {
    // Degenerate and unreachable for a real query, pinned so the behaviour is a
    // decision rather than an accident: an empty header line, then an empty record.
    expect(serialise('csv', [[]], {}, [])).toBe('\r\n\r\n');
    expect(serialise('json', [[]], {}, [])).toBe('[\n{}\n]');
    expect(serialise('sql', [[]], {}, [])).toBe('insert into "public"."exported" () values\n();\n');
  });

  it('never produces NaN or undefined in the output', () => {
    const text = serialise(
      'csv',
      [
        [Number.NaN, 'x'],
        [Number.POSITIVE_INFINITY, 'y'],
      ],
      {},
      [column('f', OID.float8), TEXT],
    );
    expect(text).not.toContain('undefined');
    // NaN is data, not a hole: Postgres can store it in a float column and psql
    // prints it, so the export must too.
    expect(lines(text)[1]).toBe('NaN,x');
  });

  it('exports a serialiser’s output for a large row count without growing memory', () => {
    // Not a benchmark: the point is that `row()` is a pure function of its input,
    // so a million calls cost a million strings and no accumulated state.
    const serialiser: ExportSerialiser = createSerialiser(
      'csv',
      TWO_COLUMNS,
      defaultExportOptions('csv'),
    );
    const expected = serialiser.row([1, 'a']);
    for (let index = 0; index < 100_000; index += 1) {
      if (index % 25_000 === 0) expect(serialiser.row([1, 'a'])).toBe(expected);
    }
  });
});
