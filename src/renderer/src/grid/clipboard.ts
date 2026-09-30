import { cellText } from './cell-format';
import type { CellValue, ColumnMeta } from './types';

export type ClipboardFormat = 'tsv' | 'csv' | 'json' | 'sql' | 'markdown';

export interface SerialiseInput {
  readonly format: ClipboardFormat;
  /** Row-major cells of the selected block; `undefined` means not yet loaded. */
  readonly rows: readonly (readonly (CellValue | undefined)[])[];
  /** Full column list of the source, used for headers, JSON keys and SQL columns. */
  readonly columns: readonly ColumnMeta[];
  /** Index of the block's first column, so names line up with a partial selection. */
  readonly firstCol?: number;
  readonly includeHeader?: boolean;
  /** Overrides the per-format NULL representation. */
  readonly nullText?: string;
  readonly delimiter?: string;
  readonly lineEnding?: string;
  /** SQL target table; dotted names are quoted per part (`public.people`). */
  readonly table?: string;
}

const DEFAULT_TABLE = 'result';

function lineEndingFor(input: SerialiseInput): string {
  if (input.lineEnding !== undefined) return input.lineEnding;
  return input.format === 'markdown' || input.format === 'sql' ? '\n' : '\r\n';
}

function delimiterFor(input: SerialiseInput): string {
  if (input.delimiter !== undefined) return input.delimiter;
  return input.format === 'csv' ? ',' : '\t';
}

function nullTextFor(input: SerialiseInput): string {
  if (input.nullText !== undefined) return input.nullText;
  // SQL needs the bare keyword, which sqlValue handles separately; every
  // delimited format defaults to an empty field, which is what Excel expects.
  return '';
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Column names for the block, trimmed to the widest row so a ragged or partial
 * selection never emits more headers than it has values.
 */
function blockColumns(input: SerialiseInput): readonly ColumnMeta[] {
  const from = Math.max(0, Math.floor(input.firstCol ?? 0));
  const sliced = input.columns.slice(from);
  let widest = 0;
  for (const row of input.rows) widest = Math.max(widest, row.length);
  if (widest === 0) return sliced;
  return sliced.slice(0, widest);
}

function columnName(columns: readonly ColumnMeta[], index: number): string {
  return columns[index]?.name ?? `column_${index}`;
}

/** Names of an already-sliced column list, for header rows. */
function headerNames(columns: readonly ColumnMeta[]): string[] {
  return columns.map((column) => column.name);
}

// ── Delimited (TSV / CSV) ────────────────────────────────────────────────────

/**
 * RFC 4180 quoting, applied to any delimiter: quote when the field contains the
 * delimiter, a quote, CR or LF, and double embedded quotes.
 */
export function escapeDelimited(text: string, delimiter: string): string {
  if (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function plainCell(cell: CellValue | undefined, nullText: string): string {
  if (cell === undefined || cell.kind === 'null') return nullText;
  return cellText(cell).text;
}

function delimitedRow(input: SerialiseInput, row: readonly (CellValue | undefined)[]): string {
  const delimiter = delimiterFor(input);
  const nullText = nullTextFor(input);
  const cells: string[] = [];
  for (const cell of row) cells.push(escapeDelimited(plainCell(cell, nullText), delimiter));
  return cells.join(delimiter);
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function markdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function markdownRow(input: SerialiseInput, row: readonly (CellValue | undefined)[]): string {
  const nullText = nullTextFor(input);
  const cells: string[] = [];
  for (const cell of row) cells.push(markdownCell(plainCell(cell, nullText)));
  return `| ${cells.join(' | ')} |`;
}

// ── JSON ─────────────────────────────────────────────────────────────────────

/**
 * Numbers stay JSON numbers only when `raw` round-trips through a double
 * exactly. Otherwise the raw string is emitted, because silently rounding an
 * int8 or dropping the trailing zeros of a numeric would be a lie about the
 * data the server sent.
 */
function jsonValue(cell: CellValue | undefined): unknown {
  if (cell === undefined || cell.kind === 'null') return null;
  switch (cell.kind) {
    case 'bool':
      return cell.value;
    case 'number': {
      if (cell.raw === '') return cell.value;
      const parsed = Number(cell.raw);
      return Number.isFinite(parsed) && String(parsed) === cell.raw ? parsed : cell.raw;
    }
    case 'text':
      return cell.value;
    case 'time':
      return new Date(cell.epochMs).toISOString();
    case 'json':
      return cell.preview;
    case 'binary':
      return toHex(cell.preview);
    case 'error':
      return null;
  }
}

function jsonRows(input: SerialiseInput): Record<string, unknown>[] {
  const columns = blockColumns(input);
  const out: Record<string, unknown>[] = [];
  for (const row of input.rows) {
    const record: Record<string, unknown> = {};
    for (let index = 0; index < row.length; index += 1) {
      record[columnName(columns, index)] = jsonValue(row[index]);
    }
    out.push(record);
  }
  return out;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteTable(table: string): string {
  return table
    .split('.')
    .map((part) => quoteIdent(part))
    .join('.');
}

function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function sqlValue(cell: CellValue | undefined): string {
  if (cell === undefined || cell.kind === 'null') return 'NULL';
  switch (cell.kind) {
    case 'bool':
      return cell.value ? 'TRUE' : 'FALSE';
    case 'number':
      return cell.raw !== '' ? cell.raw : String(cell.value);
    case 'text':
      return quoteLiteral(cell.value);
    case 'time':
      return quoteLiteral(new Date(cell.epochMs).toISOString());
    case 'json':
      return quoteLiteral(cell.preview);
    case 'binary':
      return quoteLiteral(`\\x${toHex(cell.preview)}`);
    case 'error':
      return 'NULL';
  }
}

function sqlStatement(
  input: SerialiseInput,
  rows: readonly (readonly (CellValue | undefined)[])[],
): string {
  if (rows.length === 0) return '';
  const columns = blockColumns({ ...input, rows });
  const names = headerNames(columns).map((name) => quoteIdent(name));
  const values = rows.map((row) => {
    const cells: string[] = [];
    for (const cell of row) cells.push(sqlValue(cell));
    return `(${cells.join(', ')})`;
  });
  const table = quoteTable(input.table ?? DEFAULT_TABLE);
  return `INSERT INTO ${table} (${names.join(', ')}) VALUES\n${values.join(',\n')};`;
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** Header lines for the format, empty when the format has none or none was asked for. */
function headerLines(input: SerialiseInput): string[] {
  const columns = blockColumns(input);
  switch (input.format) {
    case 'markdown': {
      const names = headerNames(columns).map((name) => markdownCell(name));
      // A markdown table is not a table without its separator row.
      return [`| ${names.join(' | ')} |`, `| ${names.map(() => '---').join(' | ')} |`];
    }
    case 'tsv':
    case 'csv': {
      if (!input.includeHeader) return [];
      const delimiter = delimiterFor(input);
      const names = headerNames(columns).map((name) => escapeDelimited(name, delimiter));
      return [names.join(delimiter)];
    }
    default:
      return [];
  }
}

function rowLines(
  input: SerialiseInput,
  rows: readonly (readonly (CellValue | undefined)[])[],
): string[] {
  if (input.format === 'markdown') return rows.map((row) => markdownRow(input, row));
  return rows.map((row) => delimitedRow(input, row));
}

/**
 * Serialise a selected block to one string.
 *
 * For very large selections prefer {@link serialiseChunks}, which streams the
 * same output without building one giant string in memory.
 */
export function serialise(input: SerialiseInput): string {
  if (input.format === 'json') return JSON.stringify(jsonRows(input));
  if (input.format === 'sql') return sqlStatement(input, input.rows);

  const lineEnding = lineEndingFor(input);
  const lines = [...headerLines(input), ...rowLines(input, input.rows)];
  return lines.join(lineEnding);
}

/**
 * Lazily yields the same text {@link serialise} would produce, in row chunks.
 *
 * `concat(chunks) === serialise(input)` holds for the delimited formats: every
 * chunk but the last carries a trailing line ending. JSON cannot be split into
 * concatenatable pieces, so it yields a single document. SQL yields one complete
 * statement per chunk, because a fragment of a VALUES list is not valid SQL —
 * which also makes it the right shape for streaming an export to disk.
 *
 * Laziness is the point: it lets the caller cap, chunk and show progress on a
 * 100k-cell copy instead of freezing the renderer on one huge string.
 */
export function* serialiseChunks(
  input: SerialiseInput,
  chunkRows: number,
): Generator<string, void, void> {
  const total = input.rows.length;
  if (total === 0) return;

  if (input.format === 'json') {
    yield serialise(input);
    return;
  }
  if (input.format === 'sql') {
    const size = Math.max(1, Math.floor(chunkRows));
    for (let start = 0; start < total; start += size) {
      yield sqlStatement(input, input.rows.slice(start, start + size));
    }
    return;
  }

  const size = Math.max(1, Math.floor(chunkRows));
  const lineEnding = lineEndingFor(input);
  let header = headerLines(input);

  for (let start = 0; start < total; start += size) {
    const slice = input.rows.slice(start, start + size);
    const lines = [...header, ...rowLines(input, slice)];
    header = [];
    const isLast = start + size >= total;
    yield lines.join(lineEnding) + (isLast ? '' : lineEnding);
  }
}
