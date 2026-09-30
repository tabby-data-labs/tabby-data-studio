/**
 * GRID-SPEC §8: clipboard serialisation.
 *
 * AGENTS.md names this Tier 1, so the expectations here are derived from
 * RFC 4180 and from what Excel and Google Sheets actually accept on paste —
 * not from the implementation. Escaping bugs are silent: the paste looks fine
 * until a value happens to contain a tab or a quote.
 */
import { describe, expect, it } from 'vitest';
import { serialise, serialiseChunks, type ClipboardFormat } from '@/grid/clipboard';
import type { CellValue, ColumnMeta } from '@/grid/types';

const COLS: readonly ColumnMeta[] = [
  { name: 'id', typeName: 'int8', typeOid: 20, nullable: false, widthHint: 80 },
  { name: 'name', typeName: 'text', typeOid: 25, nullable: true, widthHint: 120 },
  { name: 'ok', typeName: 'bool', typeOid: 16, nullable: false, widthHint: 60 },
];

const T = (value: string): CellValue => ({ kind: 'text', value });
const N = (raw: string, value = Number(raw)): CellValue => ({ kind: 'number', value, raw });
const BOOL = (value: boolean): CellValue => ({ kind: 'bool', value });
const NULL: CellValue = { kind: 'null' };

function rows(
  ...data: (readonly (CellValue | undefined)[])[]
): readonly (readonly (CellValue | undefined)[])[] {
  return data;
}

describe('TSV — the Excel paste format', () => {
  it('separates cells with tabs and rows with CRLF', () => {
    const out = serialise({
      format: 'tsv',
      columns: COLS,
      rows: rows([N('1'), T('alice'), BOOL(true)], [N('2'), T('bob'), BOOL(false)]),
    });
    expect(out).toBe('1\talice\ttrue\r\n2\tbob\tfalse');
  });

  it('emits no header by default, matching what Excel expects on paste', () => {
    const out = serialise({ format: 'tsv', columns: COLS, rows: rows([N('1')]) });
    expect(out).toBe('1');
  });

  it('includes the header row when asked', () => {
    const out = serialise({
      format: 'tsv',
      columns: COLS,
      rows: rows([N('1'), T('alice'), BOOL(true)]),
      includeHeader: true,
    });
    expect(out).toBe('id\tname\tok\r\n1\talice\ttrue');
  });

  it('quotes a field containing a tab and doubles internal quotes', () => {
    const out = serialise({ format: 'tsv', columns: COLS, rows: rows([T('a\tb')]) });
    expect(out).toBe('"a\tb"');
  });

  it('quotes a field containing a newline so the row count survives', () => {
    const out = serialise({ format: 'tsv', columns: COLS, rows: rows([T('line1\nline2')]) });
    expect(out).toBe('"line1\nline2"');
    // Still one logical row: parsing it back must not see two.
    expect(out.split('\r\n')).toHaveLength(1);
  });

  it('quotes a field that already contains quotes, doubling them', () => {
    const out = serialise({ format: 'tsv', columns: COLS, rows: rows([T('say "hi"')]) });
    expect(out).toBe('"say ""hi"""');
  });

  it('leaves an unremarkable field unquoted', () => {
    expect(serialise({ format: 'tsv', columns: COLS, rows: rows([T('plain')]) })).toBe('plain');
  });

  it('renders NULL as empty by default and as a literal when configured', () => {
    const plain = serialise({ format: 'tsv', columns: COLS, rows: rows([N('1'), NULL]) });
    expect(plain).toBe('1\t');

    const explicit = serialise({
      format: 'tsv',
      columns: COLS,
      rows: rows([N('1'), NULL]),
      nullText: 'NULL',
    });
    expect(explicit).toBe('1\tNULL');
  });

  it('preserves int8 precision by serialising the raw string', () => {
    const out = serialise({
      format: 'tsv',
      columns: COLS,
      rows: rows([N('9007199254740993', 9_007_199_254_740_992)]),
    });
    expect(out).toBe('9007199254740993');
  });

  it('handles a ragged row without inventing cells', () => {
    const out = serialise({ format: 'tsv', columns: COLS, rows: rows([N('1'), T('a')], [N('2')]) });
    expect(out).toBe('1\ta\r\n2');
  });

  it('returns an empty string for no rows', () => {
    expect(serialise({ format: 'tsv', columns: COLS, rows: [] })).toBe('');
  });

  it('treats an unloaded cell as NULL', () => {
    const out = serialise({
      format: 'tsv',
      columns: COLS,
      rows: rows([N('1'), undefined]),
      nullText: 'NULL',
    });
    expect(out).toBe('1\tNULL');
  });

  it('renders every CellValue kind without throwing', () => {
    const every: CellValue[] = [
      NULL,
      BOOL(true),
      N('12.50'),
      T('text'),
      { kind: 'time', epochMs: 0, tz: 'UTC' },
      { kind: 'binary', byteLength: 2, preview: new Uint8Array([0xde, 0xad]) },
      { kind: 'json', preview: '{"a":1}', byteLength: 7 },
      { kind: 'error', message: 'bad encoding' },
    ];
    const out = serialise({ format: 'tsv', columns: COLS, rows: rows(every) });
    expect(out.split('\t')).toHaveLength(every.length);
  });
});

describe('CSV — RFC 4180', () => {
  it('uses a comma delimiter', () => {
    const out = serialise({ format: 'csv', columns: COLS, rows: rows([N('1'), T('alice')]) });
    expect(out).toBe('1,alice');
  });

  it('quotes a field containing the delimiter', () => {
    expect(serialise({ format: 'csv', columns: COLS, rows: rows([T('a,b')]) })).toBe('"a,b"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(serialise({ format: 'csv', columns: COLS, rows: rows([T('a"b')]) })).toBe('"a""b"');
  });

  it('quotes fields containing CR or LF', () => {
    expect(serialise({ format: 'csv', columns: COLS, rows: rows([T('a\nb')]) })).toBe('"a\nb"');
    expect(serialise({ format: 'csv', columns: COLS, rows: rows([T('a\rb')]) })).toBe('"a\rb"');
  });

  it('accepts a custom delimiter', () => {
    const out = serialise({
      format: 'csv',
      columns: COLS,
      rows: rows([N('1'), T('a;b')]),
      delimiter: ';',
    });
    expect(out).toBe('1;"a;b"');
  });

  it('accepts a custom line ending', () => {
    const out = serialise({
      format: 'csv',
      columns: COLS,
      rows: rows([N('1')], [N('2')]),
      lineEnding: '\n',
    });
    expect(out).toBe('1\n2');
  });
});

describe('JSON', () => {
  it('emits an array of objects keyed by column name', () => {
    const out = serialise({
      format: 'json',
      columns: COLS,
      rows: rows([N('1'), T('alice'), BOOL(true)]),
    });
    expect(JSON.parse(out)).toEqual([{ id: 1, name: 'alice', ok: true }]);
  });

  it('maps NULL to JSON null', () => {
    const out = serialise({ format: 'json', columns: COLS, rows: rows([N('1'), NULL]) });
    expect(JSON.parse(out)).toEqual([{ id: 1, name: null }]);
  });

  it('keeps a number a number when it round-trips exactly', () => {
    const out = serialise({ format: 'json', columns: COLS, rows: rows([N('42')]) });
    expect(out).toContain('"id":42');
  });

  it('falls back to a string for int8 values a double cannot represent', () => {
    const out = serialise({
      format: 'json',
      columns: COLS,
      rows: rows([N('9007199254740993', 9_007_199_254_740_992)]),
    });
    expect(JSON.parse(out)).toEqual([{ id: '9007199254740993' }]);
  });

  it('preserves numeric trailing zeros as a string', () => {
    const out = serialise({ format: 'json', columns: COLS, rows: rows([N('12.50')]) });
    expect(JSON.parse(out)).toEqual([{ id: '12.50' }]);
  });

  it('always produces parseable JSON', () => {
    const out = serialise({
      format: 'json',
      columns: COLS,
      rows: rows([T('quote"and\\slash'), NULL, BOOL(false)]),
    });
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('emits an empty array for no rows', () => {
    expect(serialise({ format: 'json', columns: COLS, rows: [] })).toBe('[]');
  });

  it('renders timestamps as ISO strings', () => {
    const out = serialise({
      format: 'json',
      columns: COLS,
      rows: rows([{ kind: 'time', epochMs: 0, tz: 'UTC' }]),
    });
    expect(JSON.parse(out)).toEqual([{ id: '1970-01-01T00:00:00.000Z' }]);
  });
});

describe('SQL INSERT', () => {
  it('quotes identifiers and renders bare literals', () => {
    const out = serialise({
      format: 'sql',
      columns: COLS,
      rows: rows([N('1'), T('alice'), BOOL(true)]),
      table: 'public.people',
    });
    expect(out).toBe(
      'INSERT INTO "public"."people" ("id", "name", "ok") VALUES\n' + "(1, 'alice', TRUE);",
    );
  });

  it('renders NULL as a bare keyword, not a quoted string', () => {
    const out = serialise({
      format: 'sql',
      columns: COLS,
      rows: rows([N('1'), NULL]),
      table: 't',
    });
    expect(out).toContain('(1, NULL)');
    expect(out).not.toContain("'NULL'");
  });

  it('escapes single quotes by doubling them', () => {
    const out = serialise({
      format: 'sql',
      columns: COLS,
      rows: rows([T("O'Brien")]),
      table: 't',
    });
    expect(out).toContain("'O''Brien'");
  });

  it('renders booleans as TRUE and FALSE', () => {
    const out = serialise({
      format: 'sql',
      columns: COLS,
      rows: rows([BOOL(true)], [BOOL(false)]),
      table: 't',
    });
    expect(out).toContain('(TRUE)');
    expect(out).toContain('(FALSE)');
  });

  it('renders bytea as a hex literal', () => {
    const out = serialise({
      format: 'sql',
      columns: COLS,
      rows: rows([{ kind: 'binary', byteLength: 2, preview: new Uint8Array([0xde, 0xad]) }]),
      table: 't',
    });
    expect(out).toContain(String.raw`'\xdead'`);
  });

  it('emits one multi-row VALUES list, not one statement per row', () => {
    const out = serialise({
      format: 'sql',
      columns: COLS,
      rows: rows([N('1')], [N('2')], [N('3')]),
      table: 't',
    });
    expect(out.match(/INSERT INTO/g)).toHaveLength(1);
    expect(out).toBe('INSERT INTO "t" ("id") VALUES\n(1),\n(2),\n(3);');
  });

  it('doubles a quote embedded in an identifier', () => {
    const weird: readonly ColumnMeta[] = [
      { name: 'we"ird', typeName: 'text', typeOid: 25, nullable: false, widthHint: 80 },
    ];
    const out = serialise({ format: 'sql', columns: weird, rows: rows([T('x')]), table: 't' });
    expect(out).toContain('"we""ird"');
  });

  it('produces no statement for zero rows', () => {
    expect(serialise({ format: 'sql', columns: COLS, rows: [], table: 't' })).toBe('');
  });
});

describe('Markdown', () => {
  it('emits a header, a separator and one row per record', () => {
    const out = serialise({
      format: 'markdown',
      columns: COLS,
      rows: rows([N('1'), T('alice'), BOOL(true)]),
    });
    expect(out).toBe('| id | name | ok |\n| --- | --- | --- |\n| 1 | alice | true |');
  });

  it('escapes a pipe so it cannot break the table', () => {
    const out = serialise({ format: 'markdown', columns: COLS, rows: rows([T('a|b')]) });
    expect(out).toContain(String.raw`a\|b`);
  });

  it('replaces newlines so a cell stays on one line', () => {
    const out = serialise({ format: 'markdown', columns: COLS, rows: rows([T('a\nb')]) });
    expect(out.split('\n')).toHaveLength(3); // header + separator + one row
  });

  it('renders NULL as an empty cell', () => {
    const out = serialise({ format: 'markdown', columns: COLS, rows: rows([NULL]) });
    expect(out.endsWith('|  |')).toBe(true);
  });
});

describe('chunking', () => {
  const many = Array.from({ length: 250 }, (_unused, i) => [N(String(i))] as readonly CellValue[]);

  it('concatenating every chunk reproduces the single-pass output exactly', () => {
    for (const format of ['tsv', 'csv', 'markdown'] as const) {
      const whole = serialise({ format, columns: COLS, rows: many });
      const joined = [...serialiseChunks({ format, columns: COLS, rows: many }, 40)].join('');
      expect(joined, format).toBe(whole);
    }
  });

  it('splits into the expected number of chunks', () => {
    const chunks = [...serialiseChunks({ format: 'tsv', columns: COLS, rows: many }, 100)];
    expect(chunks).toHaveLength(3);
  });

  it('emits the header only in the first chunk', () => {
    const chunks = [
      ...serialiseChunks({ format: 'tsv', columns: COLS, rows: many, includeHeader: true }, 100),
    ];
    expect(chunks[0]).toContain('id\r\n');
    expect(chunks[1]).not.toContain('id');
  });

  it('yields a single chunk smaller than the chunk size', () => {
    const chunks = [...serialiseChunks({ format: 'tsv', columns: COLS, rows: many }, 10_000)];
    expect(chunks).toHaveLength(1);
  });

  it('yields nothing for no rows', () => {
    expect([...serialiseChunks({ format: 'tsv', columns: COLS, rows: [] }, 100)]).toEqual([]);
  });

  it('clamps a non-positive chunk size to one row', () => {
    const chunks = [...serialiseChunks({ format: 'tsv', columns: COLS, rows: many }, 0)];
    expect(chunks).toHaveLength(250);
  });

  it('is lazy, so a huge range can be streamed without building one giant string', () => {
    const generator = serialiseChunks({ format: 'tsv', columns: COLS, rows: many }, 50);
    const first = generator.next();
    expect(first.done).toBe(false);
    // Only the first chunk's rows have been serialised so far. A non-final chunk
    // carries a trailing separator, so filter it out before counting.
    const lines = String(first.value)
      .split('\r\n')
      .filter((line) => line !== '');
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('0');
    expect(lines[49]).toBe('49');
  });

  it('chunks SQL as separate complete statements', () => {
    const chunks = [
      ...serialiseChunks({ format: 'sql', columns: COLS, rows: many, table: 't' }, 100),
    ];
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^INSERT INTO/);
      expect(chunk.trimEnd().endsWith(';')).toBe(true);
    }
  });
});

describe('column offset', () => {
  it('uses the right column names when the block starts mid-table', () => {
    const out = serialise({
      format: 'json',
      columns: COLS,
      rows: rows([T('alice'), BOOL(true)]),
      firstCol: 1,
    });
    expect(JSON.parse(out)).toEqual([{ name: 'alice', ok: true }]);
  });

  it('slices the SQL column list to match', () => {
    const out = serialise({
      format: 'sql',
      columns: COLS,
      rows: rows([T('alice')]),
      firstCol: 1,
      table: 't',
    });
    expect(out).toBe('INSERT INTO "t" ("name") VALUES\n(\'alice\');');
  });
});

describe('format listing', () => {
  it('exposes every supported format', () => {
    const all: ClipboardFormat[] = ['tsv', 'csv', 'json', 'sql', 'markdown'];
    for (const format of all) {
      expect(typeof serialise({ format, columns: COLS, rows: rows([N('1')]), table: 't' })).toBe(
        'string',
      );
    }
  });
});
