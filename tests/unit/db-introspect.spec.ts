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
  INDEX_DEFS_SQL,
  READ_ONLY_PROBE_SQL,
  RELATION_DEF_SQL,
  SCHEMAS_SQL,
  SERVER_VERSION_SQL,
  SYSTEM_SCHEMAS,
  TABLES_SQL,
  constraintKindFor,
  relationKindFor,
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
} from '../../src/main/db/introspect';

function columnRow(overrides: Partial<ColumnRow> = {}): ColumnRow {
  return {
    attnum: 1,
    attname: 'id',
    attisdropped: false,
    attnotnull: true,
    typname: 'int4',
    typfmt: 'integer',
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
  const ALL = [
    SCHEMAS_SQL,
    TABLES_SQL,
    COLUMNS_SQL,
    INDEXES_SQL,
    CONSTRAINTS_SQL,
    INDEX_DEFS_SQL,
    RELATION_DEF_SQL,
  ];

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
    expect(INDEX_DEFS_SQL).toContain('$1');
    expect(INDEX_DEFS_SQL).toContain('$2');
    expect(CONSTRAINTS_SQL).toContain('$1');
    expect(CONSTRAINTS_SQL).toContain('$2');
    expect(RELATION_DEF_SQL).toContain('$1');
    expect(RELATION_DEF_SQL).toContain('$2');
  });

  it('formats column types the way psql does, not as a bare typname', () => {
    // `\d+` prints `character varying(255)` and `numeric(12,4)`; `pg_type.typname`
    // alone prints `varchar` and `numeric`, losing the modifiers that make the
    // column's DDL reproducible.
    expect(COLUMNS_SQL).toMatch(
      /pg_catalog\.format_type\s*\(\s*att\.atttypid\s*,\s*att\.atttypmod\s*\)/i,
    );
  });

  it('renders index definitions with pg_get_indexdef, which handles expressions', () => {
    // INDEXES_SQL aggregates `indkey` and must therefore exclude expression and
    // partial indexes. The detail pane shows *every* index, so it reads the
    // server's own definition text instead of rebuilding one from attnums.
    expect(INDEX_DEFS_SQL).toMatch(/pg_catalog\.pg_get_indexdef/i);
    expect(INDEX_DEFS_SQL).not.toMatch(/indisunique\s*$/im);
    expect(INDEX_DEFS_SQL).not.toContain('and idx.indisunique');
  });

  it('reads a view body with pg_get_viewdef, pretty-printed', () => {
    expect(RELATION_DEF_SQL).toMatch(/pg_catalog\.pg_get_viewdef/i);
    // `true` is the pretty flag; without it the whole body arrives on one line.
    expect(RELATION_DEF_SQL).toMatch(/pg_get_viewdef\([^)]*,\s*true\s*\)/i);
    // Restricted to the relkinds that have a definition, so a table returns no row
    // rather than an error.
    expect(RELATION_DEF_SQL).toMatch(/relkind\s+in\s*\(\s*'v'\s*,\s*'m'\s*\)/i);
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
          typfmt: 'timestamp with time zone',
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
      formattedType: 'timestamp with time zone',
      typeOid: 1184,
      nullable: true,
      defaultExpression: 'now()',
      comment: 'row creation time',
      position: 1,
    });
  });

  it('keeps the bare typname as the display type, and format_type as the DDL type', () => {
    // The grid's column header wants the short name (`int8`); `\d+` and generated
    // DDL want the formatted one (`bigint`). Dropping either would make one of the
    // two views wrong, so both are carried.
    const meta = toTableMeta({
      schema: 's',
      name: 't',
      comment: null,
      rowEstimate: -1,
      columns: [columnRow({ typname: 'varchar', typfmt: 'character varying(255)' })],
      indexes: [],
    });
    expect(meta.columns[0]?.typeName).toBe('varchar');
    expect(meta.columns[0]?.formattedType).toBe('character varying(255)');
  });

  it('falls back to typname when the server returned no formatted type', () => {
    for (const missing of [null, undefined, '']) {
      const meta = toTableMeta({
        schema: 's',
        name: 't',
        comment: null,
        rowEstimate: -1,
        columns: [columnRow({ typname: 'int4', typfmt: missing as string | null })],
        indexes: [],
      });
      expect(meta.columns[0]?.formattedType, String(missing)).toBe('int4');
    }
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

describe('constraintKindFor', () => {
  it('maps the pg_constraint.contype letters', () => {
    expect(constraintKindFor('p')).toBe('primary');
    expect(constraintKindFor('u')).toBe('unique');
    expect(constraintKindFor('f')).toBe('foreign');
    expect(constraintKindFor('c')).toBe('check');
    expect(constraintKindFor('x')).toBe('exclusion');
  });

  it('returns null for the kinds the detail pane does not render', () => {
    // 't' is a constraint trigger, which has no pg_get_constraintdef text worth
    // showing next to a column list. An unknown letter must not become a category.
    expect(constraintKindFor('t')).toBeNull();
    expect(constraintKindFor('')).toBeNull();
    expect(constraintKindFor('P')).toBeNull(); // case-sensitive: the catalog is
    expect(constraintKindFor(null)).toBeNull();
    expect(constraintKindFor(undefined)).toBeNull();
    expect(constraintKindFor(112)).toBeNull();
  });

  it('drops NOT NULL, which PostgreSQL 18 also stores in pg_constraint', () => {
    // Verified against a live server: `select pg_get_constraintdef(oid) from
    // pg_constraint where conrelid = 'fixtures.composite_pk'::regclass` returns
    // `NOT NULL tenant_id` and `NOT NULL seq` alongside `PRIMARY KEY (…)`. Before
    // 18 those lived only in pg_attribute.attnotnull. Rendering them as
    // constraints would list every NOT NULL column twice — once in the column
    // table's "nullable" cell and once below it.
    expect(constraintKindFor('n')).toBeNull();
    expect(
      toConstraint({
        conname: 'composite_pk_tenant_id_not_null',
        contype: 'n',
        definition: 'NOT NULL tenant_id',
      }),
    ).toBeNull();
  });
});

describe('toConstraint', () => {
  function constraintRow(overrides: Partial<ConstraintRow> = {}): ConstraintRow {
    return {
      conname: 'users_pkey',
      contype: 'p',
      definition: 'PRIMARY KEY (id)',
      ...overrides,
    };
  }

  it('keeps the server definition verbatim, because it is already correctly quoted', () => {
    // Re-quoting `PRIMARY KEY (id)` ourselves would mean re-deriving column order
    // and operator classes from attnums. The server's text is authoritative and is
    // exactly what `\d+` prints.
    const constraint = toConstraint(
      constraintRow({
        contype: 'f',
        definition: 'FOREIGN KEY (owner_id) REFERENCES "Mixed Case"(id) ON DELETE CASCADE',
      }),
    );
    expect(constraint).toEqual({
      name: 'users_pkey',
      kind: 'foreign',
      definition: 'FOREIGN KEY (owner_id) REFERENCES "Mixed Case"(id) ON DELETE CASCADE',
    });
  });

  it('maps every renderable kind', () => {
    expect(
      toConstraint(constraintRow({ contype: 'c', definition: 'CHECK ((amount > 0))' }))?.kind,
    ).toBe('check');
    expect(toConstraint(constraintRow({ contype: 'u', definition: 'UNIQUE (email)' }))?.kind).toBe(
      'unique',
    );
    expect(
      toConstraint(
        constraintRow({ contype: 'x', definition: 'EXCLUDE USING gist (range_a WITH &&)' }),
      )?.kind,
    ).toBe('exclusion');
  });

  it('returns null for a contype it does not render, rather than inventing one', () => {
    expect(toConstraint(constraintRow({ contype: 't' }))).toBeNull();
    expect(toConstraint(constraintRow({ contype: 'zz' }))).toBeNull();
  });

  it('refuses a row whose definition is not a string', () => {
    // A constraint with no definition text cannot be shown or regenerated, and
    // silently rendering `undefined` into a DDL statement would be worse than
    // dropping the row.
    expect(toConstraint(constraintRow({ definition: null as unknown as string }))).toBeNull();
    expect(toConstraint(constraintRow({ definition: 42 as unknown as string }))).toBeNull();
  });

  it('survives a null or malformed row object', () => {
    expect(toConstraint(null as unknown as ConstraintRow)).toBeNull();
    expect(toConstraint(undefined as unknown as ConstraintRow)).toBeNull();
  });
});

describe('toIndexMeta', () => {
  function indexDefRow(overrides: Partial<IndexDefRow> = {}): IndexDefRow {
    return {
      indexname: 'big_bucket_idx',
      indisprimary: false,
      indisunique: false,
      definition: 'CREATE INDEX big_bucket_idx ON fixtures.big USING btree (bucket)',
      ...overrides,
    };
  }

  it('carries the flags and the server definition', () => {
    expect(toIndexMeta(indexDefRow({ indisprimary: true, indisunique: true }))).toEqual({
      name: 'big_bucket_idx',
      isPrimary: true,
      isUnique: true,
      definition: 'CREATE INDEX big_bucket_idx ON fixtures.big USING btree (bucket)',
    });
  });

  it('shows expression and partial indexes, which INDEXES_SQL must exclude', () => {
    // The row-identity query cannot use these, but a user reading the detail pane
    // has to see them: hiding a partial unique index would be hiding the reason a
    // duplicate insert was rejected.
    const expression = toIndexMeta(
      indexDefRow({
        indexname: 'label_lower_idx',
        definition: 'CREATE INDEX label_lower_idx ON fixtures.big USING btree (lower(label))',
      }),
    );
    expect(expression?.definition).toContain('lower(label)');

    const partial = toIndexMeta(
      indexDefRow({
        indisunique: true,
        definition: 'CREATE UNIQUE INDEX u ON s.t (a) WHERE (a IS NOT NULL)',
      }),
    );
    expect(partial?.isUnique).toBe(true);
    expect(partial?.definition).toContain('WHERE');
  });

  it('treats missing flags as false, the safe direction', () => {
    const index = toIndexMeta(
      indexDefRow({
        indisprimary: undefined as unknown as boolean,
        indisunique: undefined as unknown as boolean,
      }),
    );
    expect(index).toMatchObject({ isPrimary: false, isUnique: false });
  });

  it('returns null when there is no usable definition text', () => {
    expect(toIndexMeta(indexDefRow({ definition: null as unknown as string }))).toBeNull();
    expect(toIndexMeta(indexDefRow({ definition: '' }))).toBeNull();
    expect(toIndexMeta(indexDefRow({ definition: 7 as unknown as string }))).toBeNull();
  });

  it('survives a null row object', () => {
    expect(toIndexMeta(null as unknown as IndexDefRow)).toBeNull();
  });
});
