/**
 * The single source of truth for every IPC channel and its payload shape.
 * Both main and preload import from here; neither may invent channels.
 *
 * Every invoke-style call returns Result<T> — never a thrown error.
 */

import type { Result } from './errors';
import type { ExportFormat, ExportOptions } from './export';
import type { HistoryEntry, HistoryStatus, ParsedHistory } from './history';
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

  // query history (Phase 7)
  historyList: 'history:list',
  historyAdd: 'history:add',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',

  // results
  resultMeta: 'result:meta',
  resultWindow: 'result:window',
  resultSort: 'result:sort',
  resultDispose: 'result:dispose',

  // export (Phase 8)
  exportStart: 'export:start',
  exportCancel: 'export:cancel',

  // main → renderer events
  evQueryProgress: 'event:query-progress',
  evConnectionLost: 'event:connection-lost',
  evResultEvicted: 'event:result-evicted',
  evExportProgress: 'event:export-progress',
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

/**
 * One run, recorded by the renderer because only the renderer knows what the user
 * typed — main sees a normalised single statement, and would otherwise file the
 * `explain (format text) …` wrapper it adds itself as a query the user wrote.
 *
 * `id` and `ranAt` are absent on purpose: main generates both, so there is one
 * clock and one id space.
 */
export interface HistoryAddRequest {
  readonly sql: string;
  readonly connectionId: string;
  readonly connectionLabel: string;
  readonly status: HistoryStatus;
  readonly elapsedMs: number;
  readonly rowCount: number;
}

// ── Responses ────────────────────────────────────────────────────────────────

/**
 * The parsed log, plus anything the store wants the user to know about it.
 *
 * `warning` is how a failed write becomes visible: `add` deliberately does not
 * fail the query it describes, so this is the only channel that can carry it.
 */
export interface HistoryListResponse extends ParsedHistory {
  readonly warning: string | null;
}

/**
 * A request to export one live result (PLAN Phase 8).
 *
 * **There is no path field, and that is the security design.** The destination is
 * chosen by `dialog.showSaveDialog` in the main process, so the only way a file
 * gets written is through a picker the user just confirmed. Accepting a path from
 * the renderer would let a compromised one write anywhere the user's account can,
 * which is a strictly worse posture than the one `safeStorage` gives passwords.
 *
 * The `sql` export target is derived in main too, from the result's own browse
 * target when it has one — see `ExportStartResponse.insertTarget`.
 */
export interface ExportStartRequest {
  readonly resultId: string;
  readonly options: ExportOptions;
}

export interface ExportStartResponse {
  readonly exportId: string;
  /** The path the user picked in the save dialog. */
  readonly path: string;
  readonly fileName: string;
  readonly format: ExportFormat;
  /**
   * The quoted `INSERT` target main derived, or null when the result is not a
   * plain table scan and the default placeholder was used. Echoed so the dialog
   * can show what a `.sql` file will say before the user runs it.
   */
  readonly insertTarget: string | null;
}

/**
 * Export progress and terminal states.
 *
 * `rowsWritten` and `bytesWritten` are what main has flushed, not what the server
 * has produced, so the number on screen is never ahead of the file.
 */
export interface ExportProgressEvent {
  readonly exportId: string;
  readonly path: string;
  readonly phase: 'streaming' | 'done' | 'cancelled' | 'failed';
  readonly rowsWritten: number;
  readonly bytesWritten: number;
  readonly elapsedMs: number;
  /** Non-null for `failed`, and the reason a cancel or a failure left a partial file. */
  readonly message: string | null;
}

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
  [IpcChannel.evExportProgress]: ExportProgressEvent;
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
   * Query history (PLAN Phase 7). Newest first, across the live JSONL file and
   * every rotation still on disk, capped at `limit`.
   *
   * `historyClear` returns the number of records removed rather than `void`, so
   * the UI can say what it just did — the privacy note makes this a destructive
   * action, and a destructive action that reports nothing reads like a no-op.
   */
  historyList(limit?: number): Promise<Result<HistoryListResponse>>;
  historyAdd(req: HistoryAddRequest): Promise<Result<HistoryEntry>>;
  historyDelete(historyId: string): Promise<Result<void>>;
  historyClear(): Promise<Result<number>>;

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

  /**
   * Starts an export of one live result (PLAN Phase 8).
   *
   * Main opens the save dialog itself and streams straight to disk, so **rows
   * never cross the bridge** — that is what keeps a million-row export inside the
   * renderer's memory budget instead of blowing it. Resolves once the user has
   * answered the dialog and the stream has started, not when it finishes; progress
   * and the terminal state arrive on `onExportProgress`.
   *
   * `null` means the user dismissed the save dialog, which is not an error.
   */
  exportStart(req: ExportStartRequest): Promise<Result<ExportStartResponse | null>>;
  /**
   * Stops an export at its next batch boundary and signals the backend, so a fetch
   * that is itself slow does not have to finish first.
   */
  exportCancel(exportId: string): Promise<Result<void>>;
}

export type { ColumnMeta };
