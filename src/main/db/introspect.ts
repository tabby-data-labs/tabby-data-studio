/**
 * Catalog introspection: the queries and the pure mappers that turn catalog rows
 * into domain objects (PLAN Phase 4).
 *
 * The queries read `pg_catalog` rather than `information_schema`, because
 * `pg_catalog` is what `\d+` reads and it exposes the things a data viewer
 * actually needs — `reltuples` for an instant row estimate, `indkey` for index
 * column order, `pg_description` for comments.
 *
 * Every caller-supplied name is a `$n` parameter. No schema or table name from
 * the renderer is ever concatenated into these strings, so `quoteIdent` is not
 * needed here — and cannot be forgotten here.
 */
import type { SchemaNode, SchemaNodeKind, TableMeta, UniqueIndexMeta } from '../../shared/domain';

/** Schemas a user never wants to browse. Excluded in SQL so the server does the work. */
export const SYSTEM_SCHEMAS: readonly string[] = ['pg_catalog', 'information_schema', 'pg_toast'];

export const SCHEMAS_SQL = `
select nsp.nspname,
       nsp.oid,
       dsc.description as comment
from pg_catalog.pg_namespace nsp
left join pg_catalog.pg_description dsc
       on dsc.objoid = nsp.oid
      and dsc.classoid = 'pg_catalog.pg_namespace'::regclass
where nsp.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
  and nsp.nspname not like 'pg\\_temp\\_%'
  and nsp.nspname not like 'pg\\_toast\\_%'
  and not pg_catalog.pg_is_other_temp_schema(nsp.oid)
order by nsp.nspname
`.trim();

/** $1 = schema name. */
export const TABLES_SQL = `
select nsp.nspname,
       cls.relname,
       cls.relkind,
       cls.oid,
       dsc.description as comment,
       cls.reltuples
from pg_catalog.pg_class cls
join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
left join pg_catalog.pg_description dsc on dsc.objoid = cls.oid and dsc.objsubid = 0
where nsp.nspname = $1
  and cls.relkind in ('r', 'p', 'v', 'm', 'S')
order by cls.relname
`.trim();

/** $1 = schema name, $2 = relation name. */
export const COLUMNS_SQL = `
select att.attnum,
       att.attname,
       att.attisdropped,
       att.attnotnull,
       typ.typname,
       typ.oid as typeoid,
       pg_catalog.pg_get_expr(def.adbin, def.adrelid) as adsrc,
       dsc.description as comment
from pg_catalog.pg_attribute att
join pg_catalog.pg_class cls on cls.oid = att.attrelid
join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
join pg_catalog.pg_type typ on typ.oid = att.atttypid
left join pg_catalog.pg_attrdef def on def.adrelid = att.attrelid and def.adnum = att.attnum
left join pg_catalog.pg_description dsc on dsc.objoid = att.attrelid and dsc.objsubid = att.attnum
where nsp.nspname = $1
  and cls.relname = $2
  and att.attnum > 0
  and not att.attisdropped
order by att.attnum
`.trim();

/**
 * $1 = schema name, $2 = relation name.
 *
 * Expression indexes are excluded because `indkey` holds zeros for them, so there
 * is no column list to aggregate; partial indexes are excluded because "unique
 * among rows matching a predicate" cannot identify a row. Both would otherwise
 * look like a usable row identity to the v2 editor.
 */
export const INDEXES_SQL = `
select cls.relname as indexname,
       idx.indisprimary,
       idx.indisunique,
       pg_catalog.array_agg(att.attname order by k.ord)::text[] as columns,
       bool_and(att.attnotnull) as allnotnull
from pg_catalog.pg_index idx
join pg_catalog.pg_class cls on cls.oid = idx.indexrelid
join pg_catalog.pg_class tbl on tbl.oid = idx.indrelid
join pg_catalog.pg_namespace nsp on nsp.oid = tbl.relnamespace
cross join lateral pg_catalog.unnest(idx.indkey) with ordinality as k(attnum, ord)
join pg_catalog.pg_attribute att on att.attrelid = idx.indrelid and att.attnum = k.attnum
where nsp.nspname = $1
  and tbl.relname = $2
  and idx.indisunique
  and idx.indexprs is null
  and idx.indpred is null
group by cls.relname, idx.indisprimary, idx.indisunique
order by idx.indisprimary desc, cls.relname
`.trim();

/** $1 = schema name, $2 = relation name. Read now, rendered by the Phase 6 detail pane. */
export const CONSTRAINTS_SQL = `
select con.conname,
       con.contype,
       pg_catalog.pg_get_constraintdef(con.oid) as definition
from pg_catalog.pg_constraint con
join pg_catalog.pg_class tbl on tbl.oid = con.conrelid
join pg_catalog.pg_namespace nsp on nsp.oid = tbl.relnamespace
where nsp.nspname = $1
  and tbl.relname = $2
order by con.contype, con.conname
`.trim();

export const SERVER_VERSION_SQL = 'select version()';

/** `SHOW`, not `SELECT current_setting(…)`: it reports what this session sees. */
export const READ_ONLY_PROBE_SQL = 'show default_transaction_read_only';

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface SchemaFolderRow {
  readonly nspname: string;
  readonly oid: number | null;
  readonly comment: string | null;
}

export interface RelationRow {
  readonly nspname: string;
  readonly relname: string;
  readonly relkind: string;
  readonly oid: number | null;
  readonly comment: string | null;
  readonly reltuples: number | string | null;
}

export interface ColumnRow {
  readonly attnum: number;
  readonly attname: string;
  readonly attisdropped: boolean;
  readonly attnotnull: boolean;
  readonly typname: string;
  readonly typeoid: number;
  readonly adsrc: string | null;
  readonly comment: string | null;
}

export interface IndexRow {
  readonly indexname: string;
  readonly indisprimary: boolean;
  readonly indisunique: boolean;
  /** In index order, as aggregated by `array_agg(… order by …)`. */
  readonly columns: readonly string[];
  readonly allnotnull: boolean;
}

export interface TableMetaInput {
  readonly schema: string;
  readonly name: string;
  readonly comment: string | null;
  readonly rowEstimate: number;
  readonly columns: readonly ColumnRow[];
  readonly indexes: readonly IndexRow[];
}

// ── Mappers ──────────────────────────────────────────────────────────────────

/**
 * A `Map`, not an object literal: `RELKINDS['constructor']` on a plain object
 * would find `Object.prototype.constructor` and report a function as a relkind.
 */
const RELKINDS = new Map<string, SchemaNodeKind>([
  ['r', 'table'],
  ['p', 'table'], // partitioned table
  ['v', 'view'],
  ['m', 'materializedView'],
  ['i', 'index'],
  ['S', 'sequence'],
]);

/** Null for the relkinds the explorer hides: TOAST, composite types, foreign tables. */
export function relationKindFor(relkind: unknown): SchemaNodeKind | null {
  if (typeof relkind !== 'string') return null;
  return RELKINDS.get(relkind) ?? null;
}

/**
 * `pg_class.reltuples` is a float4 estimate, and `-1` is Postgres' own spelling of
 * "never analysed". Keeping `-1` distinct from `0` matters: an empty table and an
 * unanalysed one need different UI ("no rows" vs "unknown, run ANALYZE").
 */
export function rowEstimateFrom(reltuples: unknown): number {
  let value: number;
  if (typeof reltuples === 'number') {
    value = reltuples;
  } else if (typeof reltuples === 'string' && reltuples.trim() !== '') {
    value = Number(reltuples);
  } else {
    return -1;
  }
  if (!Number.isFinite(value) || value < 0) return -1;
  return Math.round(value);
}

function emptyToNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function oidOrZero(oid: unknown): number {
  return typeof oid === 'number' && Number.isFinite(oid) ? oid : 0;
}

export function toSchemaFolder(row: SchemaFolderRow): SchemaNode {
  return {
    kind: 'schema',
    name: row.nspname,
    schema: row.nspname,
    oid: oidOrZero(row.oid),
    comment: emptyToNull(row.comment),
    rowEstimate: -1,
    hasChildren: true,
  };
}

export function toRelationNode(row: RelationRow): SchemaNode | null {
  const kind = relationKindFor(row?.relkind);
  if (kind === null) return null;
  return {
    kind,
    name: row.relname,
    schema: row.nspname,
    oid: oidOrZero(row.oid),
    comment: emptyToNull(row.comment),
    rowEstimate: rowEstimateFrom(row.reltuples),
    hasChildren: false,
  };
}

/**
 * The index's columns, verified to be a list.
 *
 * `pg` returns `name[]` as the raw text `{tenant_id,seq}` unless the query casts it
 * to `text[]`. Spreading that string yields `['{','t','e','n',…]` — a primary key
 * made of punctuation, which would then be quoted into a WHERE clause and produce
 * a query that silently matches nothing. Failing loudly is the only safe response.
 */
function indexColumns(index: IndexRow): readonly string[] {
  if (!Array.isArray(index.columns)) {
    throw new TypeError(
      `index "${index.indexname}" returned its column list as ${typeof index.columns}, not an array`,
    );
  }
  return [...index.columns];
}

/**
 * Assembles a table's metadata.
 *
 * Two details are load-bearing. Columns are ordered by `attnum` and renumbered
 * from 1 after dropped and system columns are filtered out, so the grid never
 * shows a gap. And the primary key keeps **index order**, not alphabetical order
 * — a reordered composite key would make every keyset page built on it compare
 * the wrong way round.
 */
export function toTableMeta(input: TableMetaInput): TableMeta {
  const columns = input.columns
    .filter((column) => column.attisdropped !== true && column.attnum > 0)
    .slice()
    .sort((a, b) => a.attnum - b.attnum)
    .map((column, index) => ({
      name: column.attname,
      typeName: column.typname,
      typeOid: column.typeoid,
      // A missing flag reads as nullable: claiming NOT NULL when unsure would let
      // a future editor skip a null check.
      nullable: column.attnotnull !== true,
      defaultExpression: column.adsrc ?? null,
      comment: emptyToNull(column.comment),
      position: index + 1,
    }));

  const uniqueIndexes: UniqueIndexMeta[] = input.indexes
    .filter((index) => index.indisunique === true)
    .map((index) => ({
      name: index.indexname,
      columns: indexColumns(index),
      isPrimary: index.indisprimary === true,
      // Kept separate from isPrimary because a unique index over a nullable
      // column cannot identify a row: NULL never equals NULL, so an UPDATE keyed
      // on it could match zero rows and report success.
      allColumnsNotNull: index.allnotnull === true,
    }));

  const primary = input.indexes.find((index) => index.indisprimary === true);

  return {
    schema: input.schema,
    name: input.name,
    columns,
    primaryKey: primary ? indexColumns(primary) : [],
    uniqueIndexes,
    comment: emptyToNull(input.comment),
    rowEstimate: input.rowEstimate,
  };
}
