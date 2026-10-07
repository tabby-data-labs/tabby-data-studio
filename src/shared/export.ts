/**
 * Result export: the options and their defaults (PLAN Phase 8).
 *
 * Types only, plus defaults — no I/O and no serialisation. Those live in
 * `src/main/export/`, because PLAN's requirement is that rows are written to disk
 * **from main, never through the renderer**: a million rows round-tripped over the
 * bridge is a million rows of renderer heap, which is exactly what the phase's exit
 * criterion forbids.
 *
 * The renderer needs these types to build the dialog, which is why the file is in
 * `shared` rather than in main.
 */

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql';

/**
 * Node's `Buffer` encodings, and only those.
 *
 * `latin1` is lossy for anything above U+00FF — a byte it cannot represent becomes
 * `?`. It is offered because legacy spreadsheet workflows ask for it, and the
 * dialog says so rather than letting the user discover it in the file.
 */
export type ExportEncoding = 'utf8' | 'utf16le' | 'latin1';

export type ExportLineEnding = 'lf' | 'crlf';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'tsv', 'json', 'sql'];
export const EXPORT_ENCODINGS: readonly ExportEncoding[] = ['utf8', 'utf16le', 'latin1'];
export const EXPORT_LINE_ENDINGS: readonly ExportLineEnding[] = ['lf', 'crlf'];

export interface ExportOptions {
  readonly format: ExportFormat;
  /**
   * Column separator, for csv only. One character; `tsv` is a tab by definition and
   * the other two formats have no delimiter.
   */
  readonly delimiter: string;
  /**
   * csv and tsv only.
   *
   * JSON always keys its objects by column name, and SQL always lists its columns —
   * for both, "no header" would produce a file nothing can read, so the flag is
   * ignored rather than honoured.
   */
  readonly includeHeader: boolean;
  /**
   * What a SQL NULL becomes in csv/tsv. `\N` is what `psql`'s `\copy` writes and
   * reads back; the empty string is what a spreadsheet expects.
   *
   * With the empty string, NULL and `''` produce identical bytes. That is inherent
   * to a delimited format and not something quoting can fix — RFC 4180 has no
   * out-of-band NULL — so it is documented here rather than papered over.
   */
  readonly nullText: string;
  readonly encoding: ExportEncoding;
  readonly lineEnding: ExportLineEnding;
  /**
   * Write a byte-order mark. On by default for csv, because Excel infers the
   * encoding of a BOM-less file from the locale and will mangle a non-ASCII export;
   * meaningless for latin1, which has no BOM, and ignored there.
   */
  readonly writeBom: boolean;
  /**
   * Rows per `INSERT` statement, for sql only. Batched rather than one statement
   * per row: a million single-row inserts is a million parse-and-plan cycles for
   * whoever runs the file.
   */
  readonly rowsPerInsert: number;
}

/** Rows fetched from the export cursor per write cycle. */
export const EXPORT_BATCH_ROWS = 5_000;

/**
 * Per-format defaults, so "Export as TSV" does the obvious thing without the user
 * setting four fields.
 *
 * csv defaults to CRLF because RFC 4180 §2.1 defines a record as ending in CRLF,
 * and PLAN asks for RFC 4180-correct output. The others default to LF: a JSON or
 * SQL file with CRLF is legal but noisy in a diff, and nothing reads them line-wise
 * the way a spreadsheet reads CSV.
 */
export function defaultExportOptions(format: ExportFormat): ExportOptions {
  const shared = {
    includeHeader: true,
    nullText: '',
    encoding: 'utf8' as const,
    writeBom: true,
    rowsPerInsert: 100,
  };
  switch (format) {
    case 'csv':
      return { ...shared, format, delimiter: ',', lineEnding: 'crlf' };
    case 'tsv':
      return {
        ...shared,
        format,
        delimiter: '\t',
        lineEnding: 'crlf',
        nullText: '\\N',
        writeBom: false,
      };
    case 'json':
      return { ...shared, format, delimiter: ',', lineEnding: 'lf', writeBom: false };
    case 'sql':
      return {
        ...shared,
        format,
        delimiter: ',',
        lineEnding: 'lf',
        writeBom: false,
        includeHeader: false,
      };
  }
}

export function defaultFileExtension(format: ExportFormat): string {
  return format;
}

/** The dialog's file-type filter label. */
export function formatLabel(format: ExportFormat): string {
  switch (format) {
    case 'csv':
      return 'Comma-separated values';
    case 'tsv':
      return 'Tab-separated values';
    case 'json':
      return 'JSON array of objects';
    case 'sql':
      return 'SQL INSERT statements';
  }
}
