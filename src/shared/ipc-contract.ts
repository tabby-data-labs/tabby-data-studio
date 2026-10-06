/**
 * The single source of truth for every IPC channel and its payload shape.
 * Both main and preload import from here; neither may invent channels.
 *
 * Every invoke-style call returns Result<T> — never a thrown error.
 */

import type { Result } from './errors';
import type {
  ColumnMeta,
  ConnectionSummary,
  EncodedRowBlock,
  ResultMeta,
  SchemaNode,
  SettingsPatch,
  SortSpec,
  StoredConnection,
  TableDetail,
  ThemeName,
  WindowState,
} from './domain';

export const IpcChannel = {
  // settings & window (Phase 3)
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  windowState: 'window:state',

  // connections
  connList: 'conn:list',
  connSave: 'conn:save',
  connDelete: 'conn:delete',
  connTest: 'conn:test',
  connOpen: 'conn:open',
  connClose: 'conn:close',

  // schema
  schemaChildren: 'schema:children',
  schemaTable: 'schema:table',
  schemaRefresh: 'schema:refresh',

  // queries — run returns a handle immediately; rows are pulled by window
  queryRun: 'query:run',
  queryCancel: 'query:cancel',

  // results
  resultMeta: 'result:meta',
  resultWindow: 'result:window',
  resultSort: 'result:sort',
  resultDispose: 'result:dispose',

  // main → renderer events
  evQueryProgress: 'event:query-progress',
  evConnectionLost: 'event:connection-lost',
  evResultEvicted: 'event:result-evicted',
} as const;

export type IpcChannelValue = (typeof IpcChannel)[keyof typeof IpcChannel];

// ── Requests ─────────────────────────────────────────────────────────────────

export interface ConnSaveRequest {
  readonly connection: Omit<StoredConnection, 'encryptedPassword'>;
  /** Plaintext only in this direction; main encrypts it and never returns it. */
  readonly password?: string;
}

export interface SchemaChildrenRequest {
  readonly connectionId: string;
  readonly parentSchema: string | null;
}

export interface SchemaTableRequest {
  readonly connectionId: string;
  readonly schema: string;
  readonly table: string;
}

export interface QueryRunRequest {
  readonly connectionId: string;
  readonly sql: string;
  /** Rows fetched eagerly before the first window request. */
  readonly initialRows?: number;
  /**
   * Set only when `sql` is a plain scan of one table. It lets main page with a
   * keyset seek or `OFFSET` and hold **no transaction open**, instead of pinning a
   * cursor for as long as the tab is open.
   *
   * Names only: main resolves the key columns from the catalog itself, because
   * which columns identify a row is a correctness decision, not a renderer choice.
   */
  readonly browse?: BrowseTarget;
}

export interface BrowseTarget {
  readonly schema: string;
  readonly table: string;
}

export interface ResultWindowRequest {
  readonly resultId: string;
  readonly startRow: number;
  readonly rowCount: number;
}

export interface ResultSortRequest {
  readonly resultId: string;
  readonly sort: SortSpec | null;
}

// ── Responses ────────────────────────────────────────────────────────────────

/**
 * What the renderer may see of the persisted settings. Secret material is
 * absent by construction: connections arrive as summaries, never as
 * `StoredConnection`, so there is no ciphertext to accidentally surface.
 */
export interface SettingsSnapshot {
  readonly connections: readonly ConnectionSummary[];
  readonly window: WindowState;
  readonly theme: ThemeName;
  /** Non-null when the on-disk file was corrupt and had to be reset. */
  readonly loadWarning: string | null;
}

export interface QueryRunResponse {
  readonly resultId: string;
  readonly meta: ResultMeta;
}

export interface QueryProgressEvent {
  readonly resultId: string;
  readonly phase: 'planning' | 'running' | 'streaming' | 'done' | 'failed';
  readonly rowsReceived: number;
}

export interface ConnectionLostEvent {
  readonly connectionId: string;
}

/** Why a result disappeared, so the UI can say the right thing about it. */
export type ResultEvictionReason = 'capacity' | 'expired';

export interface ResultEvictedEvent {
  readonly resultId: string;
  readonly reason: ResultEvictionReason;
}

/**
 * Every main → renderer payload, keyed by channel.
 *
 * This map exists because the two ends were previously typed independently: main
 * emitted `{ connectionId }` while the preload declared the listener argument as a
 * bare `string`, and nothing — not the compiler, not the tests — could see the
 * mismatch, because the emitter was `(channel: string, payload: unknown)`. Both
 * sides now derive from this one declaration.
 */
export interface MainEventMap {
  [IpcChannel.evQueryProgress]: QueryProgressEvent;
  [IpcChannel.evConnectionLost]: ConnectionLostEvent;
  [IpcChannel.evResultEvicted]: ResultEvictedEvent;
}

export type MainEventChannel = keyof MainEventMap;

/** The emitter main hands to its services. Payload type is checked per channel. */
export type MainEventEmitter = <C extends MainEventChannel>(
  channel: C,
  payload: MainEventMap[C],
) => void;

// ── The bridge shape ─────────────────────────────────────────────────────────

/**
 * The complete bridge surface. The preload implements it and the renderer codes
 * against it, so a channel added in one place without the other fails typecheck.
 */
export interface DatabaseApi {
  // settings & window (Phase 3)
  getSettings(): Promise<Result<SettingsSnapshot>>;
  patchSettings(patch: SettingsPatch): Promise<Result<SettingsSnapshot>>;
  getWindowState(): Promise<Result<WindowState>>;

  listConnections(): Promise<Result<readonly ConnectionSummary[]>>;
  saveConnection(req: ConnSaveRequest): Promise<Result<ConnectionSummary>>;
  deleteConnection(connectionId: string): Promise<Result<void>>;
  testConnection(connectionId: string): Promise<Result<{ readonly serverVersion: string }>>;
  openConnection(connectionId: string): Promise<Result<void>>;
  closeConnection(connectionId: string): Promise<Result<void>>;

  schemaChildren(req: SchemaChildrenRequest): Promise<Result<readonly SchemaNode[]>>;
  /**
   * Columns, indexes, constraints, comments and generated DDL for one relation —
   * the whole detail pane in one call, as ARCHITECTURE §3 specifies.
   *
   * `TableDetail.meta` is the same `TableMeta` the paging path uses. The wider
   * fields cost three extra catalog reads, which is why main caches this
   * separately from `tableOf` and never pays for it when merely browsing.
   */
  schemaTable(req: SchemaTableRequest): Promise<Result<TableDetail>>;
  /** Drops the cached catalog for one connection. Returns the number of entries freed. */
  refreshSchema(connectionId: string): Promise<Result<number>>;

  queryRun(req: QueryRunRequest): Promise<Result<QueryRunResponse>>;
  queryCancel(resultId: string): Promise<Result<void>>;
  /**
   * Current metadata for a result. How the renderer learns that the exact row
   * count has replaced the `reltuples` estimate, since the count runs in the
   * background after the first rows arrive.
   */
  resultMeta(resultId: string): Promise<Result<ResultMeta>>;
  /**
   * Columnar and packed (ARCHITECTURE §5.4): a block of a million rows arrives as
   * typed arrays, and the renderer decodes a cell only when it paints it.
   */
  resultWindow(req: ResultWindowRequest): Promise<Result<EncodedRowBlock>>;
  resultSort(req: ResultSortRequest): Promise<Result<ResultMeta>>;
  resultDispose(resultId: string): Promise<Result<void>>;
}

export type { ColumnMeta };
