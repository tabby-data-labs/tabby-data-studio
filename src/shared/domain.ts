/**
 * Types shared by all three processes. No runtime imports, no Node APIs, no Vue.
 */

// ── Connections ──────────────────────────────────────────────────────────────

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

/**
 * A saved connection as persisted to disk. `password` is `safeStorage`
 * ciphertext, never plaintext, and never crosses IPC to the renderer.
 */
export interface StoredConnection {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly encryptedPassword: string | null;
  readonly sslMode: SslMode;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A connection as the renderer may see it — no secret material at all. */
export type ConnectionSummary = Omit<StoredConnection, 'encryptedPassword'>;

// ── App settings ─────────────────────────────────────────────────────────────

export type ThemeName = 'dark' | 'light';

export interface WindowState {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isMaximized: boolean;
  readonly isFullScreen: boolean;
}

/**
 * Persisted to `userData/settings.json`. `connections[].encryptedPassword` is
 * `safeStorage` ciphertext — never plaintext, and never sent to the renderer.
 */
export interface AppSettings {
  readonly version: number;
  readonly connections: readonly StoredConnection[];
  readonly window: WindowState;
  readonly theme: ThemeName;
}

/** What the renderer may ask main to change. Connections go through their own channels. */
export type SettingsPatch = Partial<Pick<AppSettings, 'theme' | 'window'>>;

// ── Schema ───────────────────────────────────────────────────────────────────

export type SchemaNodeKind =
  'database' | 'schema' | 'table' | 'view' | 'materializedView' | 'index' | 'sequence' | 'function';

export interface SchemaNode {
  readonly kind: SchemaNodeKind;
  readonly name: string;
  readonly schema: string;
  readonly oid: number;
  readonly comment: string | null;
  /** Estimated rows from pg_class.reltuples; -1 when unknown. */
  readonly rowEstimate: number;
  readonly hasChildren: boolean;
}

export interface ColumnInfo {
  readonly name: string;
  readonly typeName: string;
  readonly typeOid: number;
  readonly nullable: boolean;
  readonly defaultExpression: string | null;
  readonly comment: string | null;
  readonly position: number;
}

/**
 * A unique index, as read from `pg_index`/`pg_constraint`.
 *
 * `allColumnsNotNull` is carried separately from `isPrimary` because it is the
 * property that decides whether an index can identify a row: a unique index over
 * a nullable column can match zero rows (NULL is never equal to NULL), so an
 * UPDATE keyed on it could silently do nothing.
 */
export interface UniqueIndexMeta {
  readonly name: string;
  /** In index order, which is the order a row comparison must use. */
  readonly columns: readonly string[];
  readonly isPrimary: boolean;
  readonly allColumnsNotNull: boolean;
}

export interface TableMeta {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
  readonly primaryKey: readonly string[];
  /**
   * Every unique index, including ones unusable as a row identity. Populated by
   * Phase 4 introspection; the v2 `RowIdentityResolver` picks from it.
   */
  readonly uniqueIndexes: readonly UniqueIndexMeta[];
  readonly comment: string | null;
  /** Estimated rows from `pg_class.reltuples`; -1 when never analysed. */
  readonly rowEstimate: number;
}

// ── Grid data contract ───────────────────────────────────────────────────────

export interface ColumnMeta {
  readonly name: string;
  readonly typeName: string;
  readonly typeOid: number;
  readonly nullable: boolean;
  /** Suggested initial column width in CSS pixels. */
  readonly widthHint: number;
}

/**
 * A decoded cell. `number` keeps the original string form because int8 and
 * numeric lose precision when passed through a JS double above 2^53.
 */
export type CellValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number; readonly raw: string }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'time'; readonly epochMs: number; readonly tz: string }
  | { readonly kind: 'binary'; readonly byteLength: number; readonly preview: Uint8Array }
  | { readonly kind: 'json'; readonly preview: string; readonly byteLength: number }
  | { readonly kind: 'error'; readonly message: string };

/** A contiguous slice of rows, column-major: `columns[c][r]`. */
export interface RowBlock {
  readonly startRow: number;
  readonly rowCount: number;
  readonly columns: readonly (readonly CellValue[])[];
}

// ── Columnar wire format (ARCHITECTURE §5.4) ─────────────────────────────────

/**
 * How one column of a block is packed.
 *
 *  - `float64` — exact numeric types and temporal instants, one double per row
 *  - `utf8`    — anything textual or precision-sensitive, as one UTF-8 blob with
 *                a byte-offset table (`int8` and `numeric` land here on purpose:
 *                a double cannot hold them)
 *  - `bits`    — booleans, one bit per row
 */
export type ColumnEncoding = 'float64' | 'utf8' | 'bits';

/**
 * One packed column. Typed arrays rather than `CellValue[]` because a million
 * cell objects do not survive a structured clone cheaply; the renderer decodes a
 * cell only when it is about to paint it.
 */
export interface EncodedColumn {
  readonly encoding: ColumnEncoding;
  readonly typeOid: number;
  readonly typeName: string;
  readonly rowCount: number;
  /** Bit `i` set means row `i` is NULL. Length `ceil(rowCount / 8)`. */
  readonly nulls: Uint8Array;
  /** Present when `encoding === 'float64'`; length `rowCount`. */
  readonly values?: Float64Array;
  /** Present when `encoding === 'utf8'`; byte offset of row `i`, length `rowCount + 1`. */
  readonly offsets?: Uint32Array;
  /** Present when `encoding === 'utf8'`; the concatenated UTF-8 payload. */
  readonly bytes?: Uint8Array;
  /** Present when `encoding === 'bits'`; bit `i` is row `i`'s truth value. */
  readonly bits?: Uint8Array;
}

/** What `result:window` returns. The grid consumes the decoded `RowBlock`. */
export interface EncodedRowBlock {
  readonly startRow: number;
  readonly rowCount: number;
  readonly columns: readonly EncodedColumn[];
}

export interface ResultMeta {
  readonly resultId: string;
  readonly columns: readonly ColumnMeta[];
  /** -1 while unknown. */
  readonly rowCount: number;
  readonly rowCountIsEstimate: boolean;
  readonly elapsedMs: number;
}

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  readonly columnIndex: number;
  readonly direction: SortDirection;
}

// ── v2 editing: DECLARATIONS ONLY ────────────────────────────────────────────
//
// Nothing below this line is implemented anywhere in the codebase, and v1 is
// read-only. The declarations live here rather than in Phase 10 for one reason:
// Phase 4 already reads `pg_constraint` and `pg_index` to fill
// `TableMeta.primaryKey` and `TableMeta.uniqueIndexes`, so the *inputs* to row
// identity exist now, and the shape of the contract is what makes editing
// additive later instead of a rewrite.
//
// The guard rails are not optional. `default_transaction_read_only` stays on for
// every connection, there is no write path, and Phase 4's exit criterion asserts
// that an `INSERT` over a Tabby connection fails with SQLSTATE `25006`. If these
// interfaces have not needed to change by the end of Phase 5, the v1 contract is
// genuinely editing-ready; if they have, fix them then rather than in Phase 10.
//
// See docs/ARCHITECTURE.md §6 for the design this comes from.

/** The columns and values that uniquely pin one row, so an UPDATE can target it. */
export type RowKey = readonly { readonly column: string; readonly value: CellValue }[];

export interface RowIdentityResolver {
  /** Primary key if there is one, else the best unique NOT NULL index, else null. */
  resolve(table: TableMeta): readonly string[] | null;
  /**
   * Null when the table has no usable identity, or when any key column in this
   * row is NULL. A caller must render such a row read-only rather than fall back
   * to a full-row WHERE, which could silently update several rows.
   */
  keyOf(table: TableMeta, block: RowBlock, offset: number): RowKey | null;
}

export interface Change {
  readonly column: string;
  /** Kept for the optimistic-concurrency WHERE clause, not just for undo. */
  readonly before: CellValue;
  readonly after: CellValue;
}

/**
 * Staged edits. Held in the renderer; flushed as parameterised SQL that is built
 * in the MAIN process only, so a compromised renderer cannot author a statement.
 */
export interface ChangeBuffer {
  set(resultId: string, row: RowKey, column: string, next: CellValue): void;
  /** Omitting `column` reverts every pending change on that row. */
  revert(resultId: string, row: RowKey, column?: string): void;
  changesFor(row: RowKey): readonly Change[];
  toSql(): readonly { text: string; values: readonly unknown[] }[];
}
