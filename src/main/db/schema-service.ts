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
import type {
  ConstraintMeta,
  IndexMeta,
  SchemaNode,
  TableDetail,
  TableMeta,
} from '../../shared/domain';
import { logError } from '../log';
import type { ConnectionManager } from './connection-manager';
import { createDdl } from './ddl';
import { toTabbyError } from './pg-error';
import {
  COLUMNS_SQL,
  CONSTRAINTS_SQL,
  INDEXES_SQL,
  INDEX_DEFS_SQL,
  RELATION_DEF_SQL,
  SCHEMAS_SQL,
  TABLES_SQL,
  rowEstimateFrom,
  toConstraint,
  toIndexMeta,
  toRelationNode,
  toSchemaFolder,
  toTableMeta,
  type ColumnRow,
  type ConstraintRow,
  type IndexDefRow,
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
  private readonly detailCache = new Map<string, TableDetail>();

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
   * Everything the Phase 6 detail pane shows for one relation.
   *
   * Separate from {@link tableOf} rather than an extension of it, because
   * `tableOf` sits on the paging hot path — `paginationKeyFor` reads it for every
   * browse query — and that path has no use for constraint text or generated DDL.
   * Folding the three extra catalog reads in would tax every table open to pay for
   * a pane the user may never click.
   *
   * The relation's `kind` comes from {@link childrenOf}, which the tree has almost
   * certainly already cached, so this costs three queries rather than four.
   */
  async detailOf(
    connectionId: string,
    schema: string,
    table: string,
  ): Promise<Result<TableDetail>> {
    const key = [connectionId, schema, table].join(KEY_SEPARATOR);
    const cached = this.detailCache.get(key);
    if (cached) return ok(cached);

    const meta = await this.tableOf(connectionId, schema, table);
    if (!meta.ok) return err<TableDetail>(meta.error);

    const siblings = await this.childrenOf(connectionId, schema);
    if (!siblings.ok) return err<TableDetail>(siblings.error);
    const kind = siblings.value.find((node) => node.name === table)?.kind;
    if (kind === undefined) {
      // `tableOf` and `childrenOf` read the same catalog, so this is not a relkind
      // filter disagreeing — it is the two *caches* disagreeing after a concurrent
      // DROP: `tableOf` served a meta it cached minutes ago while `childrenOf`
      // read the catalog fresh. Reporting the relation as gone is the honest
      // answer; inventing a kind would render a pane for an object that no longer
      // exists.
      return err<TableDetail>({
        code: 'RELATION_NOT_FOUND',
        message: `no relation "${schema}"."${table}"`,
        connectionId,
      });
    }

    const session = await this.deps.connections.requireSession(connectionId);
    if (!session.ok) return err<TableDetail>(session.error);

    try {
      const [indexResult, constraintResult, definitionResult] = await Promise.all([
        session.value.query(INDEX_DEFS_SQL, [schema, table]),
        session.value.query(CONSTRAINTS_SQL, [schema, table]),
        // Always sent: the query's own `relkind in ('v','m')` filter returns no
        // rows for a table instead of raising "cannot get view definition of
        // non-view", so branching here would only add a second code path to test.
        session.value.query(RELATION_DEF_SQL, [schema, table]),
      ]);

      const constraints = rowsAsRecords(constraintResult)
        .map((row) => toConstraint(row as unknown as ConstraintRow))
        .filter((constraint): constraint is ConstraintMeta => constraint !== null);

      const indexes = rowsAsRecords(indexResult)
        .map((row) => toIndexMeta(row as unknown as IndexDefRow))
        .filter((index): index is IndexMeta => index !== null);

      const definitionRows = rowsAsRecords(definitionResult);
      const rawDefinition = definitionRows.length > 0 ? definitionRows[0]?.['definition'] : null;
      const viewDefinition =
        typeof rawDefinition === 'string' && rawDefinition !== '' ? rawDefinition : null;

      const detail: TableDetail = {
        meta: meta.value,
        kind,
        indexes,
        constraints,
        ddl: createDdl({
          schema,
          name: table,
          kind,
          columns: meta.value.columns,
          constraints,
          comment: meta.value.comment,
          viewDefinition,
        }),
      };

      this.detailCache.set(key, detail);
      return ok(detail);
    } catch (error) {
      logError(SCOPE, error);
      return err<TableDetail>(toTabbyError(error, { connectionId }));
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
    for (const map of [this.childrenCache, this.tableCache, this.detailCache]) {
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
