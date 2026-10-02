/**
 * Catalog introspection: the SQL text and the pure mappers that turn catalog
 * rows into domain objects (PLAN Phase 4, ARCHITECTURE §5).
 *
 * Tier 1 for the mappers and for the invariants on the SQL text. The queries
 * themselves are verified against a live server in tests/integration; what is
 * checked here is that they cannot be subverted and that they read the catalog
 * the way psql does.
 *
 * Two expectations carry real weight:
 *  - **Nothing is interpolated.** Every caller-supplied name is a `$n` parameter,
 *    so no schema or table name from the renderer reaches the statement text.
 *  - **Primary-key order is index order**, not alphabetical. A composite key
 *    reordered here would silently break the v2 row identity built on top of it.
 */
import { describe, expect, it } from 'vitest';
import {
  COLUMNS_SQL,
  CONSTRAINTS_SQL,
  INDEXES_SQL,
  READ_ONLY_PROBE_SQL,
  SCHEMAS_SQL,
  SERVER_VERSION_SQL,
  SYSTEM_SCHEMAS,
  TABLES_SQL,
  relationKindFor,
  rowEstimateFrom,
  toRelationNode,
  toSchemaFolder,
  toTableMeta,
  type ColumnRow,
  type IndexRow,
} from '../../src/main/db/introspect';

function columnRow(overrides: Partial<ColumnRow> = {}): ColumnRow {
  return {
    attnum: 1,
    attname: 'id',
    attisdropped: false,
    attnotnull: true,
    typname: 'int4',
    typeoid: 23,
    adsrc: null,
    comment: null,
    ...overrides,
  };
}

function indexRow(overrides: Partial<IndexRow> = {}): IndexRow {
  return {
    indexname: 'pk',
    indisprimary: true,
    indisunique: true,
    columns: ['id'],
    allnotnull: true,
    ...overrides,
  };
}

describe('system schema exclusion', () => {
  it('names the schemas a user never wants to browse', () => {
    expect(SYSTEM_SCHEMAS).toContain('pg_catalog');
    expect(SYSTEM_SCHEMAS).toContain('information_schema');
    expect(SYSTEM_SCHEMAS).toContain('pg_toast');
  });

  it('filters them in SQL rather than in JS, so the server does the work', () => {
    for (const schema of SYSTEM_SCHEMAS) {
      expect(SCHEMAS_SQL, schema).toContain(schema);
    }
    // Toast and temp schemas are also excluded by oid range, which is what psql's
    // \d does; a name filter alone misses per-session temp schemas.
    expect(SCHEMAS_SQL).toMatch(
      /oid\s*<\s*16384|pg_catalog\.pg_is_other_temp_schema|not\s+nspname\s*like\s*'pg_temp/i,
    );
  });
});

describe('catalog SQL invariants', () => {
  const ALL = [SCHEMAS_SQL, TABLES_SQL, COLUMNS_SQL, INDEXES_SQL, CONSTRAINTS_SQL];

  it('reads pg_catalog, not information_schema, so it matches psql', () => {
    expect(TABLES_SQL).toContain('pg_catalog.pg_class');
    expect(TABLES_SQL).toContain('pg_catalog.pg_namespace');
    expect(COLUMNS_SQL).toContain('pg_catalog.pg_attribute');
    expect(COLUMNS_SQL).toContain('pg_catalog.pg_type');
    expect(INDEXES_SQL).toContain('pg_catalog.pg_index');
    expect(CONSTRAINTS_SQL).toContain('pg_catalog.pg_constraint');
    expect(COLUMNS_SQL).toContain('pg_catalog.pg_description');
  });

  it('excludes expression and partial indexes, which cannot identify a row', () => {
    // `array_agg(attname)` over `indkey` yields zeros for an expression index, and
    // a partial index's predicate means "unique among some rows". Both would make
    // a plausible-looking row identity that does not actually pin a row.
    expect(INDEXES_SQL).toMatch(/indexprs\s+is\s+null/i);
    expect(INDEXES_SQL).toMatch(/indpred\s+is\s+null/i);
  });

  it('parameterises every caller-supplied name', () => {
    expect(TABLES_SQL).toContain('$1');
    expect(COLUMNS_SQL).toContain('$1');
    expect(COLUMNS_SQL).toContain('$2');
    expect(INDEXES_SQL).toContain('$1');
    expect(INDEXES_SQL).toContain('$2');
  });

  it('hardcodes no specific schema or table name', () => {
    for (const sql of ALL) {
      expect(sql, sql).not.toContain("'public'");
      expect(sql, sql).not.toMatch(/from\s+fixtures/i);
    }
  });

  it('excludes dropped columns and system columns', () => {
    expect(COLUMNS_SQL).toMatch(/attisdropped/);
    expect(COLUMNS_SQL).toMatch(/attnum\s*>\s*0/);
  });

  it('orders columns by attnum, which is the order the user sees in psql', () => {
    expect(COLUMNS_SQL).toMatch(/order by[^;]*attnum/i);
  });

  it('orders index columns inside the aggregate, not by whatever the join yields', () => {
    expect(INDEXES_SQL).toMatch(/array_agg\([^)]*order by/i);
  });

  it('reports the row estimate from reltuples without counting', () => {
    expect(TABLES_SQL).toContain('reltuples');
  });

  it('probes read-only mode with SHOW, which reports the session value', () => {
    expect(READ_ONLY_PROBE_SQL).toBe('show default_transaction_read_only');
    expect(SERVER_VERSION_SQL).toBe('select version()');
  });

  it('is a single statement each, so none can smuggle a second one', () => {
    for (const sql of ALL) {
      expect(sql.trim().endsWith(';'), sql.slice(0, 40)).toBe(false);
      expect(sql.split(';').length, sql.slice(0, 40)).toBe(1);
    }
  });
});

describe('rowEstimateFrom', () => {
  it('keeps a real estimate, rounded', () => {
    expect(rowEstimateFrom(1234)).toBe(1234);
    expect(rowEstimateFrom(1234.4)).toBe(1234);
    expect(rowEstimateFrom(1234.6)).toBe(1235);
    expect(rowEstimateFrom(10_000_000)).toBe(10_000_000);
  });

  it('accepts the string form, since reltuples is a float4 the driver may pass as text', () => {
    expect(rowEstimateFrom('5000')).toBe(5000);
    expect(rowEstimateFrom('0')).toBe(0);
  });

  it('distinguishes an empty table from one that has never been analysed', () => {
    // -1 is Postgres' own "unknown"; 0 is a real, if surprising, answer.
    expect(rowEstimateFrom(0)).toBe(0);
    expect(rowEstimateFrom(-1)).toBe(-1);
  });

  it('collapses every other unusable value to unknown', () => {
    for (const bad of [
      null,
      undefined,
      Number.NaN,
      -5,
      -1000,
      '',
      'abc',
      {},
      true,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(rowEstimateFrom(bad), String(bad)).toBe(-1);
    }
  });
});

describe('relationKindFor', () => {
  it('maps the relkind letters Postgres uses', () => {
    expect(relationKindFor('r')).toBe('table');
    expect(relationKindFor('p')).toBe('table'); // partitioned table
    expect(relationKindFor('v')).toBe('view');
    expect(relationKindFor('m')).toBe('materializedView');
    expect(relationKindFor('i')).toBe('index');
    expect(relationKindFor('S')).toBe('sequence');
  });

  it('returns null for a relkind the explorer should not show', () => {
    expect(relationKindFor('t')).toBeNull(); // TOAST
    expect(relationKindFor('c')).toBeNull(); // composite type
    expect(relationKindFor('f')).toBeNull(); // foreign table (v1 does not browse them)
    expect(relationKindFor('')).toBeNull();
    expect(relationKindFor('Z')).toBeNull();
  });
});

describe('toSchemaFolder', () => {
  it('builds a schema node that can be expanded', () => {
    const node = toSchemaFolder({ nspname: 'fixtures', oid: 16_384, comment: 'test data' });
    expect(node).toEqual({
      kind: 'schema',
      name: 'fixtures',
      schema: 'fixtures',
      oid: 16_384,
      comment: 'test data',
      rowEstimate: -1,
      hasChildren: true,
    });
  });

  it('reports no comment as null, not as an empty string', () => {
    expect(toSchemaFolder({ nspname: 's', oid: 1, comment: null }).comment).toBeNull();
  });
});

describe('toRelationNode', () => {
  it('maps a table with its estimate and comment', () => {
    const node = toRelationNode({
      nspname: 'fixtures',
      relname: 'big',
      relkind: 'r',
      oid: 16_400,
      comment: '10M rows',
      reltuples: 10_000_000,
    });
    expect(node).toEqual({
      kind: 'table',
      name: 'big',
      schema: 'fixtures',
      oid: 16_400,
      comment: '10M rows',
      rowEstimate: 10_000_000,
      hasChildren: false,
    });
  });

  it('maps a view and a sequence', () => {
    expect(
      toRelationNode({
        nspname: 's',
        relname: 'v',
        relkind: 'v',
        oid: 1,
        comment: null,
        reltuples: 0,
      })?.kind,
    ).toBe('view');
    expect(
      toRelationNode({
        nspname: 's',
        relname: 'q',
        relkind: 'S',
        oid: 2,
        comment: null,
        reltuples: -1,
      })?.kind,
    ).toBe('sequence');
  });

  it('returns null for a relation kind the explorer hides', () => {
    expect(
      toRelationNode({
        nspname: 's',
        relname: 'toast',
        relkind: 't',
        oid: 3,
        comment: null,
        reltuples: 0,
      }),
    ).toBeNull();
  });

  it('tolerates a missing oid', () => {
    expect(
      toRelationNode({
        nspname: 's',
        relname: 't',
        relkind: 'r',
        oid: null,
        comment: null,
        reltuples: 5,
      })?.oid,
    ).toBe(0);
  });
});

describe('toTableMeta: columns', () => {
  it('orders columns by attnum even when the rows arrive shuffled', () => {
    const meta = toTableMeta({
      schema: 'fixtures',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [
        columnRow({ attnum: 3, attname: 'third' }),
        columnRow({ attnum: 1, attname: 'first' }),
        columnRow({ attnum: 2, attname: 'second' }),
      ],
      indexes: [],
    });
    expect(meta.columns.map((c) => c.name)).toEqual(['first', 'second', 'third']);
  });

  it('numbers positions from 1 in that order', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [columnRow({ attnum: 2, attname: 'b' }), columnRow({ attnum: 1, attname: 'a' })],
      indexes: [],
    });
    expect(meta.columns.map((c) => c.position)).toEqual([1, 2]);
  });

  it('drops columns Postgres has already dropped', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [
        columnRow({ attnum: 1, attname: 'a' }),
        columnRow({ attnum: 2, attname: '........pg.dropped.2........', attisdropped: true }),
        columnRow({ attnum: 3, attname: 'c' }),
      ],
      indexes: [],
    });
    expect(meta.columns.map((c) => c.name)).toEqual(['a', 'c']);
    // Positions are renumbered over the surviving columns, so the grid never
    // shows a gap.
    expect(meta.columns.map((c) => c.position)).toEqual([1, 2]);
  });

  it('excludes system columns, which have negative attnum', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [columnRow({ attnum: -1, attname: 'ctid' }), columnRow({ attnum: 1, attname: 'a' })],
      indexes: [],
    });
    expect(meta.columns.map((c) => c.name)).toEqual(['a']);
  });

  it('carries nullability, default expression and comment', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [
        columnRow({
          attname: 'created_at',
          attnotnull: false,
          typname: 'timestamptz',
          typeoid: 1184,
          adsrc: 'now()',
          comment: 'row creation time',
        }),
      ],
      indexes: [],
    });
    expect(meta.columns[0]).toEqual({
      name: 'created_at',
      typeName: 'timestamptz',
      typeOid: 1184,
      nullable: true,
      defaultExpression: 'now()',
      comment: 'row creation time',
      position: 1,
    });
  });

  it('treats a missing nullability flag as nullable, the safe direction', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [columnRow({ attnotnull: undefined as unknown as boolean })],
      indexes: [],
    });
    expect(meta.columns[0]?.nullable).toBe(true);
  });

  it('handles a table with no columns without throwing', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [],
      indexes: [],
    });
    expect(meta.columns).toEqual([]);
    expect(meta.primaryKey).toEqual([]);
  });
});

describe('toTableMeta: identity', () => {
  it('takes the primary key from the primary index', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [],
      indexes: [indexRow({ columns: ['id'] })],
    });
    expect(meta.primaryKey).toEqual(['id']);
  });

  it('keeps a composite key in index order, not alphabetical', () => {
    // Alphabetical would give ['seq', 'tenant_id'] and every keyset page built on
    // it would compare the wrong way round.
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [],
      indexes: [indexRow({ columns: ['tenant_id', 'seq'] })],
    });
    expect(meta.primaryKey).toEqual(['tenant_id', 'seq']);
  });

  it('reports no primary key as an empty list, not as null', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [],
      indexes: [indexRow({ indexname: 'other_uq', indisprimary: false, columns: ['code'] })],
    });
    expect(meta.primaryKey).toEqual([]);
  });

  it('lists every unique index, flagging one over a nullable column as unusable', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [],
      indexes: [
        indexRow({ indexname: 'pk', indisprimary: true, columns: ['id'], allnotnull: true }),
        indexRow({
          indexname: 'email_uq',
          indisprimary: false,
          columns: ['email'],
          allnotnull: false,
        }),
      ],
    });
    expect(meta.uniqueIndexes).toEqual([
      { name: 'pk', columns: ['id'], isPrimary: true, allColumnsNotNull: true },
      { name: 'email_uq', columns: ['email'], isPrimary: false, allColumnsNotNull: false },
    ]);
  });

  it('ignores a non-unique index, which cannot identify a row', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [],
      indexes: [indexRow({ indexname: 'plain_ix', indisprimary: false, indisunique: false })],
    });
    expect(meta.uniqueIndexes).toEqual([]);
    expect(meta.primaryKey).toEqual([]);
  });

  it('prefers the primary index when a table somehow reports two', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [],
      indexes: [
        indexRow({ indexname: 'a_uq', indisprimary: false, columns: ['a'] }),
        indexRow({ indexname: 'pk', indisprimary: true, columns: ['id'] }),
      ],
    });
    expect(meta.primaryKey).toEqual(['id']);
  });

  it('refuses an index whose column list arrived as a raw array literal', () => {
    // `pg` returns `name[]` as the text `{tenant_id,seq}` unless the query casts it
    // to `text[]`. Spreading that string yields ['{','t','e','n',…] — a primary key
    // made of punctuation, which would then be quoted straight into a WHERE clause
    // and produce a query that silently matches nothing.
    const corrupt = indexRow({ columns: '{tenant_id,seq}' as unknown as string[] });
    expect(() =>
      toTableMeta({
        schema: 's',
        name: 't',
        comment: null,
        rowEstimate: -1,
        columns: [],
        indexes: [corrupt],
      }),
    ).toThrow(TypeError);
  });
});

describe('toTableMeta: table-level fields', () => {
  it('passes through schema, name, comment and estimate', () => {
    const meta = toTableMeta({
      schema: 'fixtures',
      name: 'big',
      comment: '10M rows',
      rowEstimate: 10_000_000,
      columns: [],
      indexes: [],
    });
    expect(meta.schema).toBe('fixtures');
    expect(meta.name).toBe('big');
    expect(meta.comment).toBe('10M rows');
    expect(meta.rowEstimate).toBe(10_000_000);
  });

  it('normalises an empty comment to null', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: '',
      rowEstimate: -1,
      columns: [],
      indexes: [],
    });
    expect(meta.comment).toBeNull();
  });

  it('returns a frozen-by-shape plain object, safe to send over IPC', () => {
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [columnRow()],
      indexes: [indexRow()],
    });
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
  });
});
