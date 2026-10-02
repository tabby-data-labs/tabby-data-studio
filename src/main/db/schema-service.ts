/**
 * Catalog reads with a per-connection cache (PLAN Phase 4).
 *
 * Invalidation is **explicit only**: `refresh()` on a user action, `dropConnection()`
 * when a connection closes. Time-based expiry would make the schema tree change
 * under the user mid-scroll, and a database viewer that disagrees with `\d` is
 * worse than one that needs a refresh button.
 *
 * Cache keys are joined with a NUL, which cannot appear in a Postgres identifier,
 * so two different (schema, table) pairs can never share a key.
 */
import { err, ok, type Result } from '../../shared/errors';
import type { SchemaNode, TableMeta } from '../../shared/domain';
import { logError } from '../log';
import type { ConnectionManager } from './connection-manager';
import { toTabbyError } from './pg-error';
import {
  COLUMNS_SQL,
  INDEXES_SQL,
  SCHEMAS_SQL,
  TABLES_SQL,
  rowEstimateFrom,
  toRelationNode,
  toSchemaFolder,
  toTableMeta,
  type ColumnRow,
  type IndexRow,
  type RelationRow,
  type SchemaFolderRow,
} from './introspect';
import { rowsAsRecords } from './row-shape';

const SCOPE = 'schema';
const KEY_SEPARATOR = '\u0000';

export interface SchemaServiceDeps {
  readonly connections: ConnectionManager;
}

export class SchemaService {
  private readonly deps: SchemaServiceDeps;
  private readonly childrenCache = new Map<string, readonly SchemaNode[]>();
  private readonly tableCache = new Map<string, TableMeta>();

  constructor(deps: SchemaServiceDeps) {
    this.deps = deps;
  }

  /**
   * Children of a node: schemas at the root, relations inside a schema.
   *
   * Both are cached, because expanding the tree re-requests the same node every
   * time the user collapses and reopens it.
   */
  async childrenOf(
    connectionId: string,
    parentSchema: string | null,
  ): Promise<Result<readonly SchemaNode[]>> {
    const key = [connectionId, parentSchema ?? ''].join(KEY_SEPARATOR);
    const cached = this.childrenCache.get(key);
    if (cached) return ok(cached);

    const session = await this.deps.connections.requireSession(connectionId);
    if (!session.ok) return err<readonly SchemaNode[]>(session.error);

    try {
      const nodes =
        parentSchema === null
          ? rowsAsRecords(await session.value.query(SCHEMAS_SQL)).map((row) =>
              toSchemaFolder(row as unknown as SchemaFolderRow),
            )
          : rowsAsRecords(await session.value.query(TABLES_SQL, [parentSchema]))
              .map((row) => toRelationNode(row as unknown as RelationRow))
              .filter((node): node is SchemaNode => node !== null);

      this.childrenCache.set(key, nodes);
      return ok(nodes);
    } catch (error) {
      logError(SCOPE, error);
      return err<readonly SchemaNode[]>(toTabbyError(error, { connectionId }));
    }
  }

  async tableOf(connectionId: string, schema: string, table: string): Promise<Result<TableMeta>> {
    const key = [connectionId, schema, table].join(KEY_SEPARATOR);
    const cached = this.tableCache.get(key);
    if (cached) return ok(cached);

    const session = await this.deps.connections.requireSession(connectionId);
    if (!session.ok) return err<TableMeta>(session.error);

    try {
      // The relation row first: it tells us whether the table exists at all, and
      // carries the comment and the instant row estimate.
      const relations = rowsAsRecords(await session.value.query(TABLES_SQL, [schema]));
      const relation = relations.find((row) => row['relname'] === table);
      if (!relation) {
        return err<TableMeta>({
          code: 'RELATION_NOT_FOUND',
          message: `no relation "${schema}"."${table}"`,
          connectionId,
        });
      }

      const [columnResult, indexResult] = await Promise.all([
        session.value.query(COLUMNS_SQL, [schema, table]),
        session.value.query(INDEXES_SQL, [schema, table]),
      ]);

      const meta = toTableMeta({
        schema,
        name: table,
        comment: typeof relation['comment'] === 'string' ? relation['comment'] : null,
        rowEstimate: rowEstimateFrom(relation['reltuples']),
        columns: rowsAsRecords(columnResult) as unknown as ColumnRow[],
        indexes: rowsAsRecords(indexResult) as unknown as IndexRow[],
      });

      this.tableCache.set(key, meta);
      return ok(meta);
    } catch (error) {
      logError(SCOPE, error);
      return err<TableMeta>(toTabbyError(error, { connectionId }));
    }
  }

  /**
   * The columns to page a table by, or null when it has none.
   *
   * **Not** the v2 `RowIdentityResolver`, and deliberately so: this picks a key for
   * `ORDER BY` / `WHERE` in a read-only SELECT, which is a performance decision.
   * Row identity is a write decision, is declared-but-unimplemented in
   * `src/shared/domain.ts`, and will have to satisfy stricter rules (Phase 10).
   *
   * A nullable unique index is rejected here for the same reason it will be
   * rejected there: `NULL` never equals `NULL`, so the seek predicate could skip
   * or repeat rows.
   */
  async paginationKeyFor(
    connectionId: string,
    schema: string,
    table: string,
  ): Promise<readonly string[] | null> {
    const meta = await this.tableOf(connectionId, schema, table);
    if (!meta.ok) return null;

    const value = meta.value;
    if (value.primaryKey.length > 0) return value.primaryKey;

    const usable = value.uniqueIndexes.find(
      (index) => index.allColumnsNotNull && index.columns.length > 0,
    );
    return usable ? usable.columns : null;
  }

  /** Explicit invalidation for one connection. Returns how many entries were dropped. */
  refresh(connectionId: string): number {
    let dropped = 0;
    for (const map of [this.childrenCache, this.tableCache]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${connectionId}${KEY_SEPARATOR}`)) {
          map.delete(key);
          dropped += 1;
        }
      }
    }
    return dropped;
  }

  /** Same as refresh, for the connection-closed path where nobody reads the count. */
  dropConnection(connectionId: string): void {
    this.refresh(connectionId);
  }
}
