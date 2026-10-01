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

export interface TableMeta {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
  readonly primaryKey: readonly string[];
  readonly comment: string | null;
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
