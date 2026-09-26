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
  RowBlock,
  ResultMeta,
  SchemaNode,
  SortSpec,
  StoredConnection,
  TableMeta,
} from './domain';

export const IpcChannel = {
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

export interface ConnTestRequest {
  readonly connectionId: string;
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

export interface QueryRunResponse {
  readonly resultId: string;
  readonly meta: ResultMeta;
}

export interface QueryProgressEvent {
  readonly resultId: string;
  readonly phase: 'planning' | 'running' | 'streaming' | 'done' | 'failed';
  readonly rowsReceived: number;
}

// ── The bridge shape ─────────────────────────────────────────────────────────

/**
 * Grows in Phase 3. Declared here so the renderer can code against it and the
 * preload implementation is checked against the same interface.
 */
export interface DatabaseApi {
  listConnections(): Promise<Result<readonly ConnectionSummary[]>>;
  saveConnection(req: ConnSaveRequest): Promise<Result<ConnectionSummary>>;
  deleteConnection(connectionId: string): Promise<Result<void>>;
  testConnection(req: ConnTestRequest): Promise<Result<{ readonly serverVersion: string }>>;
  openConnection(connectionId: string): Promise<Result<void>>;
  closeConnection(connectionId: string): Promise<Result<void>>;

  schemaChildren(req: SchemaChildrenRequest): Promise<Result<readonly SchemaNode[]>>;
  schemaTable(req: SchemaTableRequest): Promise<Result<TableMeta>>;

  queryRun(req: QueryRunRequest): Promise<Result<QueryRunResponse>>;
  queryCancel(resultId: string): Promise<Result<void>>;
  resultWindow(req: ResultWindowRequest): Promise<Result<RowBlock>>;
  resultSort(req: ResultSortRequest): Promise<Result<ResultMeta>>;
  resultDispose(resultId: string): Promise<Result<void>>;
}

export type { ColumnMeta };
