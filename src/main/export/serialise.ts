/**
 * Turning result rows into file text (PLAN Phase 8).
 *
 * Pure: no `fs`, no cursor, no IPC. `export-service.ts` owns the streaming and
 * calls `begin()` once, `row()` per row and `end()` once, so this module never
 * holds more than one row of state — which is what keeps a million-row export
 * inside a constant memory budget.
 *
 * Values arrive as `pg` handed them back and go through `normalizeValue`, the same
 * function the grid and the clipboard use. That is deliberate and load-bearing:
 * `int8` and `numeric` exceed 2^53, so a second conversion path here would be a
 * second chance to round them, and a rounded export still looks correct.
 *
 * **This is not the grid's clipboard serialiser, and the overlap is only the
 * quoting rule.** `grid/clipboard.ts` serialises already-decoded display strings
 * for a bounded selection the user made; this serialises raw server values for an
 * unbounded result, with a configurable NULL spelling, a BOM and four output
 * shapes. Sharing code would mean either the grid importing from main, which the
 * ESLint boundary forbids, or moving the serialiser into `shared` and editing grid
 * files — which would break the "the grid did not change" property that Phases 5,
 * 6 and 7 all prove with an empty `git diff`. Roughly twenty lines of RFC 4180
 * quoting is duplicated on purpose.
 */
import type { ColumnMeta } from '../../shared/domain';
import type { ExportEncoding, ExportFormat, ExportOptions } from '../../shared/export';
import { quoteIdent } from '../../shared/ident';
import { OID, normalizeValue, textFor } from '../../shared/pg-types';
import { quoteLiteral } from '../db/ddl';

/**
 * The target for a `sql` export when the result is not a plain table scan.
 *
 * Already quoted, and quoted by the caller for a real table: the serialiser never
 * parses an identifier, because parsing `"my"."table"` back into parts is exactly
 * the kind of string handling that gets quoting wrong.
 */
export const DEFAULT_INSERT_TARGET = '"public"."exported"';

export interface ExportSerialiser {
  /** Text before the first row: a BOM, a header, an opening bracket. May be ''. */
  begin(): string;
  /** Text for one row, including any separator it needs. */
  row(values: readonly unknown[]): string;
  /** Text after the last row. May be ''. */
  end(): string;
}

/**
 * The byte-order mark, as a character the encoder will turn into bytes.
 *
 * `latin1` gets none: U+FEFF is not representable there, and writing it would put
 * a literal `?` at the head of every file.
 */
export function byteOrderMark(encoding: ExportEncoding, writeBom: boolean): string {
  if (!writeBom || encoding === 'latin1') return '';
  return '\uFEFF';
}

/**
 * One RFC 4180 field.
 *
 * Quotes are added only when required — a delimiter, a double quote, CR or LF —
 * and an embedded quote is doubled. Minimal quoting is what RFC 4180 permits and
 * what `psql`'s `\copy` does; quoting everything would be legal but would inflate
 * every file by two bytes per field and make a diff unreadable.
 *
 * Leading and trailing spaces are *not* quoted. A reader that trims unquoted
 * fields is not RFC-compliant, and guessing which reader will open the file is
 * worse than following the standard.
 */
export function csvField(text: string, delimiter: string): string {
  if (text === '') return '';
  const needsQuotes =
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    (delimiter !== '' && text.includes(delimiter));
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

function lineEndingOf(options: ExportOptions): string {
  return options.lineEnding === 'crlf' ? '\r\n' : '\n';
}

/**
 * `tsv` is a tab by definition, so its delimiter is not taken from the options:
 * letting a caller produce a comma-delimited `.tsv` would be a file that lies
 * about itself.
 */
function delimiterOf(format: ExportFormat, options: ExportOptions): string {
  return format === 'tsv' ? '\t' : options.delimiter;
}

/**
 * The display text for one cell in a delimited file.
 *
 * `bytea` becomes `\x…`, the spelling `COPY` reads back, rather than the bare hex
 * the grid shows. NULL becomes the configured text, which with the default empty
 * string is indistinguishable from `''` — a limit of delimited formats, not of this
 * code, and documented on `ExportOptions.nullText`.
 */
function cellText(oid: number, value: unknown, nullText: string): string {
  const normalized = normalizeValue(oid, value);
  if (normalized.kind === 'null') return nullText;
  if (normalized.kind === 'bytes') return `\\x${textFor(normalized)}`;
  return textFor(normalized);
}

export function createSerialiser(
  format: ExportFormat,
  columns: readonly ColumnMeta[],
  options: ExportOptions,
  insertTarget: string = DEFAULT_INSERT_TARGET,
): ExportSerialiser {
  switch (format) {
    case 'csv':
    case 'tsv':
      return delimited(format, columns, options);
    case 'json':
      return json(columns, options);
    case 'sql':
      // Column identifiers are quoted up front, so an unquotable name fails before
      // a single byte reaches the file rather than halfway through it.
      return sql(columns, options, insertTarget);
  }
}

// ── csv and tsv ──────────────────────────────────────────────────────────────

function delimited(
  format: ExportFormat,
  columns: readonly ColumnMeta[],
  options: ExportOptions,
): ExportSerialiser {
  const delimiter = delimiterOf(format, options);
  const eol = lineEndingOf(options);
  const bom = byteOrderMark(options.encoding, options.writeBom);
  const oids = columns.map((column) => column.typeOid);
  const header = columns.map((column) => csvField(column.name, delimiter)).join(delimiter);

  return {
    begin: () => bom + (options.includeHeader ? `${header}${eol}` : ''),
    row: (values) => {
      const cells: string[] = [];
      // Driven by the column count, not by `values.length`: a short row is padded
      // with NULL and a long one is trimmed, so the file can never be ragged. Both
      // are unreachable for a real result — `pg` always returns one value per
      // field — and existing so a malformed row cannot produce a torn record.
      for (let index = 0; index < oids.length; index += 1) {
        const oid = oids[index] ?? OID.text;
        cells.push(csvField(cellText(oid, values[index], options.nullText), delimiter));
      }
      return `${cells.join(delimiter)}${eol}`;
    },
    end: () => '',
  };
}

// ── json ─────────────────────────────────────────────────────────────────────

/**
 * One JSON value for a cell.
 *
 * `int8` and `numeric` leave as **strings**, because `normalizeValue` keeps them as
 * the server's text precisely so a double never touches them, and a JSON number
 * cannot hold them. A reader that wants a number can parse the string; a reader
 * that gets a rounded number has no way to know.
 *
 * `json` and `jsonb` are re-parsed and nested. The driver keeps them as text on the
 * way in so nothing is lost, but an export of a JSON column that arrives as an
 * escaped string inside a string is not what anyone means by "export as JSON". A
 * value that will not parse falls back to the string, so a corrupt column costs one
 * cell rather than the file.
 */
function jsonValueOf(oid: number, value: unknown): unknown {
  const normalized = normalizeValue(oid, value);
  switch (normalized.kind) {
    case 'null':
      return null;
    case 'bool':
    case 'num':
      return normalized.value;
    case 'bytes':
      return `\\x${textFor(normalized)}`;
    case 'text':
      if (oid !== OID.json && oid !== OID.jsonb) return normalized.value;
      try {
        return JSON.parse(normalized.value) as unknown;
      } catch {
        return normalized.value;
      }
  }
}

function json(columns: readonly ColumnMeta[], options: ExportOptions): ExportSerialiser {
  const bom = byteOrderMark(options.encoding, options.writeBom);
  const oids = columns.map((column) => column.typeOid);
  const keys = columns.map((column) => JSON.stringify(column.name));
  // The opening bracket is emitted by the first row rather than by `begin()`,
  // because `begin()` cannot know whether any row will follow — and an empty
  // result must be `[]`, not `[\n]`.
  let first = true;

  return {
    begin: () => bom,
    row: (values) => {
      const pairs: string[] = [];
      for (let index = 0; index < oids.length; index += 1) {
        const key = keys[index];
        if (key === undefined) continue;
        pairs.push(`${key}:${JSON.stringify(jsonValueOf(oids[index] ?? OID.text, values[index]))}`);
      }
      const prefix = first ? '[\n' : ',\n';
      first = false;
      return `${prefix}{${pairs.join(',')}}`;
    },
    end: () => (first ? '[]' : '\n]'),
  };
}

// ── sql ──────────────────────────────────────────────────────────────────────

function sqlValueOf(oid: number, value: unknown): string {
  const normalized = normalizeValue(oid, value);
  switch (normalized.kind) {
    case 'null':
      return 'NULL';
    // Numbers and booleans stay bare so they keep their type; everything else is
    // a quoted literal. A quoted numeric is still assigned to a numeric column
    // without complaint, and quoting is what keeps `int8` digits from ever being
    // read as a double.
    case 'num':
      return String(normalized.value);
    case 'bool':
      return normalized.value ? 'true' : 'false';
    case 'bytes':
      return quoteLiteral(`\\x${textFor(normalized)}`);
    case 'text':
      return quoteLiteral(normalized.value);
  }
}

function sql(
  columns: readonly ColumnMeta[],
  options: ExportOptions,
  insertTarget: string,
): ExportSerialiser {
  const oids = columns.map((column) => column.typeOid);
  const names = columns.map((column) => quoteIdent(column.name, 'export.column'));
  const eol = lineEndingOf(options);
  const batchSize = Math.max(1, Math.trunc(options.rowsPerInsert) || 1);
  // Repeated per statement rather than written once, so every statement in the
  // file can be run on its own — which is what makes a partial import possible.
  const statement = `insert into ${insertTarget} (${names.join(', ')}) values`;
  let inBatch = 0;

  return {
    // No BOM: psql does not reliably skip one, and a mark before `insert` is a
    // syntax error rather than a cosmetic blemish.
    begin: () => '',
    row: (values) => {
      const cells: string[] = [];
      for (let index = 0; index < oids.length; index += 1) {
        cells.push(sqlValueOf(oids[index] ?? OID.text, values[index]));
      }
      const tuple = `(${cells.join(', ')})`;
      const opened = inBatch === 0 ? `${statement}${eol}` : `,${eol}`;
      inBatch += 1;
      if (inBatch >= batchSize) {
        inBatch = 0;
        return `${opened}${tuple};${eol}`;
      }
      return `${opened}${tuple}`;
    },
    // An unterminated batch only exists when the row count was not a multiple of
    // the batch size; a zero-row export returns '' and writes no statement at all,
    // because `values` with no rows is a syntax error.
    end: () => (inBatch === 0 ? '' : `;${eol}`),
  };
}
