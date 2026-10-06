// @vitest-environment happy-dom
/**
 * The table detail pane (PLAN Phase 6).
 *
 * Tier 2 — Vue plus DOM, written after the implementation. The DDL text itself is
 * Tier 1 and tested test-first in `db-ddl.spec.ts`; what only a mounted component
 * can show is that the pane renders the catalog faithfully and degrades honestly.
 *
 * The strings asserted here are the real PostgreSQL 18.6 catalog output for
 * `fixtures.detail_sample`, so a mapping regression shows up as a diff against
 * something a user could have read in `psql`.
 */
import { describe, expect, it } from 'vitest';
import { mount, type DOMWrapper } from '@vue/test-utils';
import type { ColumnInfo, ConstraintMeta, IndexMeta, TableDetail } from '@shared/domain';
import TableDetailVue from '@/components/TableDetail.vue';

function column(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name: 'id',
    typeName: 'int8',
    formattedType: 'bigint',
    typeOid: 20,
    nullable: false,
    defaultExpression: null,
    comment: null,
    position: 1,
    ...overrides,
  };
}

function index(overrides: Partial<IndexMeta> = {}): IndexMeta {
  return {
    name: 'detail_sample_pkey',
    isPrimary: true,
    isUnique: true,
    definition: 'CREATE UNIQUE INDEX detail_sample_pkey ON fixtures.detail_sample USING btree (id)',
    ...overrides,
  };
}

function constraint(overrides: Partial<ConstraintMeta> = {}): ConstraintMeta {
  return {
    name: 'detail_sample_pkey',
    kind: 'primary',
    definition: 'PRIMARY KEY (id)',
    ...overrides,
  };
}

/** Mirrors the live `fixtures.detail_sample` fixture. */
function tableDetail(overrides: Partial<TableDetail> = {}): TableDetail {
  return {
    meta: {
      schema: 'fixtures',
      name: 'detail_sample',
      columns: [
        column(),
        column({
          name: 'tenant_id',
          typeName: 'int4',
          formattedType: 'integer',
          typeOid: 23,
          defaultExpression: '1',
          position: 2,
        }),
        column({
          name: 'code',
          typeName: 'varchar',
          formattedType: 'character varying(64)',
          typeOid: 1043,
          position: 3,
        }),
        column({
          name: 'label',
          typeName: 'varchar',
          formattedType: 'character varying(255)',
          typeOid: 1043,
          nullable: true,
          position: 4,
        }),
        column({
          name: 'amount',
          typeName: 'numeric',
          formattedType: 'numeric(12,4)',
          typeOid: 1700,
          nullable: true,
          defaultExpression: '0',
          comment: 'non-negative, enforced by a check',
          position: 5,
        }),
        column({
          name: 'created_at',
          typeName: 'timestamptz',
          formattedType: 'timestamp with time zone',
          typeOid: 1184,
          defaultExpression: 'now()',
          position: 6,
        }),
        column({
          name: 'note',
          typeName: 'text',
          formattedType: 'text',
          typeOid: 25,
          nullable: true,
          comment: 'nullable on purpose',
          position: 7,
        }),
      ],
      primaryKey: ['id'],
      uniqueIndexes: [],
      comment: 'the detail-pane comparison fixture',
      rowEstimate: -1,
    },
    kind: 'table',
    indexes: [
      index(),
      index({
        name: 'detail_sample_label_idx',
        isPrimary: false,
        isUnique: false,
        definition:
          'CREATE INDEX detail_sample_label_idx ON fixtures.detail_sample USING btree (label)',
      }),
      index({
        name: 'detail_sample_lower_code_idx',
        isPrimary: false,
        isUnique: false,
        definition:
          'CREATE INDEX detail_sample_lower_code_idx ON fixtures.detail_sample USING btree (lower((code)::text))',
      }),
    ],
    constraints: [
      constraint(),
      constraint({
        name: 'detail_sample_amount_chk',
        kind: 'check',
        definition: 'CHECK ((amount >= (0)::numeric))',
      }),
      constraint({
        name: 'detail_sample_tenant_fk',
        kind: 'foreign',
        definition: 'FOREIGN KEY (tenant_id) REFERENCES fixtures.plain_table(id)',
      }),
    ],
    ddl: [
      'create table "fixtures"."detail_sample" (\n  "id" bigint not null\n);',
      `comment on table "fixtures"."detail_sample" is 'the detail-pane comparison fixture';`,
    ],
    ...overrides,
  };
}

interface PaneProps {
  readonly detail?: TableDetail | null;
  readonly loading?: boolean;
  readonly error?: string | null;
}

function mountPane(props: PaneProps = {}) {
  return mount(TableDetailVue, {
    props: { detail: tableDetail(), loading: false, error: null, ...props },
  });
}

function columnRows(wrapper: ReturnType<typeof mountPane>): DOMWrapper<HTMLTableRowElement>[] {
  return wrapper.findAll('[data-detail-columns] tbody tr');
}

/**
 * `noUncheckedIndexedAccess` makes every `rows[i]` possibly undefined, which is
 * correct and unhelpful here: a missing row is a test failure, not a branch to
 * handle. Throwing names the row that was not rendered.
 */
function cellTexts(row: DOMWrapper<HTMLTableRowElement> | undefined, count: number): string[] {
  if (row === undefined) throw new Error('expected a column row that was not rendered');
  const cells = row.findAll('td');
  return Array.from({ length: count }, (_, index) => cells[index]?.text() ?? '');
}

describe('columns', () => {
  it('renders every column in catalog order with its format_type text', () => {
    const wrapper = mountPane();
    const rows = columnRows(wrapper);
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => cellTexts(row, 6)[1]?.trim().replace('🔑', '').trim())).toEqual([
      'id',
      'tenant_id',
      'code',
      'label',
      'amount',
      'created_at',
      'note',
    ]);
    expect(rows.map((row) => cellTexts(row, 6)[2])).toEqual([
      'bigint',
      'integer',
      'character varying(64)',
      'character varying(255)',
      'numeric(12,4)',
      'timestamp with time zone',
      'text',
    ]);
  });

  it('shows the modifiers psql shows, not the bare typname', () => {
    // `varchar` and `character varying(255)` are the same type, but only the second
    // tells the user what the column can hold — and only the second round-trips
    // into DDL that recreates it.
    const text = mountPane().find('[data-detail-columns]').text();
    expect(text).toContain('character varying(255)');
    expect(text).not.toMatch(/\bvarchar\b/);
  });

  it('renders nullability as yes/no, and defaults verbatim', () => {
    const rows = columnRows(mountPane());
    expect(cellTexts(rows[0], 6)[3]).toBe('no');
    expect(cellTexts(rows[3], 6)[3]).toBe('yes');
    expect(cellTexts(rows[1], 6)[4]).toBe('1');
    expect(cellTexts(rows[5], 6)[4]).toBe('now()');
    expect(cellTexts(rows[0], 6)[4]).toBe('');
  });

  it('renders column comments, and leaves the cell empty rather than printing null', () => {
    const rows = columnRows(mountPane());
    expect(cellTexts(rows[6], 6)[5]).toBe('nullable on purpose');
    expect(cellTexts(rows[0], 6)[5]).toBe('');
    // Checked cell by cell rather than over the whole table's text: the string
    // "null" legitimately appears inside "nullable on purpose", so a substring
    // search over the section would pass or fail for the wrong reason.
    for (const row of rows) {
      for (const cell of cellTexts(row, 6)) {
        expect(cell, cell).not.toBe('null');
        expect(cell, cell).not.toBe('undefined');
      }
    }
  });

  it('marks the primary-key column', () => {
    const rows = columnRows(mountPane());
    expect(rows[0]!.text()).toContain('🔑');
    expect(rows[1]!.text()).not.toContain('🔑');
  });

  it('says "no columns" rather than rendering an empty table', () => {
    const wrapper = mountPane({
      detail: tableDetail({ meta: { ...tableDetail().meta, columns: [] } }),
    });
    expect(wrapper.find('[data-detail-columns]').text()).toContain('no columns');
  });
});

describe('indexes and constraints', () => {
  it('renders index definitions exactly as the catalog returned them', () => {
    const text = mountPane().find('[data-detail-indexes]').text();
    // Full parenthesisation and all: this is `pg_get_indexdef`, which psql reduces
    // to `btree (lower(code::text))`. Showing the function's text is deliberate —
    // it is the form that re-parses when pasted back into a console.
    expect(text).toContain('lower((code)::text)');
    expect(text).toContain('CREATE INDEX detail_sample_label_idx');
  });

  it('badges the primary key distinctly from a plain index', () => {
    const badges = mountPane()
      .findAll('[data-detail-indexes] .badge')
      .map((badge) => badge.text());
    expect(badges).toEqual(['pk', 'index', 'index']);
  });

  it('renders constraint definitions verbatim, with a readable kind label', () => {
    const items = mountPane().findAll('[data-detail-constraints] li');
    // Badge and definition are asserted separately, not through `li.text()`:
    // happy-dom concatenates adjacent inline elements without the whitespace the
    // template's indentation implies, so the joined string is an artefact of the
    // test environment rather than a property of the pane.
    expect(items.map((item) => item.find('.badge').text())).toEqual([
      'primary key',
      'check',
      'foreign key',
    ]);
    expect(items.map((item) => item.find('.def').text())).toEqual([
      'detail_sample_pkey — PRIMARY KEY (id)',
      'detail_sample_amount_chk — CHECK ((amount >= (0)::numeric))',
      'detail_sample_tenant_fk — FOREIGN KEY (tenant_id) REFERENCES fixtures.plain_table(id)',
    ]);
  });

  it('says "no indexes" and "no constraints" instead of hiding the sections', () => {
    const wrapper = mountPane({
      detail: tableDetail({ indexes: [], constraints: [] }),
    });
    expect(wrapper.text()).toContain('no indexes');
    expect(wrapper.text()).toContain('no constraints');
  });
});

describe('generated DDL', () => {
  it('renders the statements and offers to copy them', async () => {
    const wrapper = mountPane();
    expect(wrapper.find('[data-detail-ddl]').text()).toContain(
      'create table "fixtures"."detail_sample"',
    );
    expect(wrapper.find('[data-detail-ddl]').text()).toContain('comment on table');

    await wrapper.find('[data-copy-ddl]').trigger('click');
    const emitted = wrapper.emitted('copyDdl');
    expect(emitted).toHaveLength(1);
    expect(emitted![0]![0]).toBe(tableDetail().ddl.join('\n\n'));
  });

  it('explains why there is no DDL, rather than showing a blank section', () => {
    const wrapper = mountPane({
      detail: tableDetail({ kind: 'sequence', ddl: [] }),
    });
    expect(wrapper.find('[data-detail-ddl]').exists()).toBe(false);
    expect(wrapper.find('[data-copy-ddl]').exists()).toBe(false);
    // The reason is stated, because "nothing here" reads as a bug otherwise.
    expect(wrapper.find('[data-detail-no-ddl]').text()).toMatch(
      /does not generate DDL for a sequence/,
    );
  });
});

describe('header and states', () => {
  it('shows the qualified name, kind and an honest row estimate', () => {
    const wrapper = mountPane();
    expect(wrapper.find('[data-detail-title]').text()).toBe('fixtures.detail_sample');
    expect(wrapper.find('.head').text()).toContain('table');
    // -1 means "never analysed". Rendering 0 would claim the table is empty.
    expect(wrapper.find('.head').text()).toContain('rows unknown — not analysed');
  });

  it('shows the estimate, marked as one, when the server has a number', () => {
    const detail = tableDetail();
    const wrapper = mountPane({
      detail: { ...detail, meta: { ...detail.meta, rowEstimate: 10_000_000 } },
    });
    expect(wrapper.find('.head').text()).toContain('~10,000,000 rows (estimate)');
  });

  it('shows the table comment', () => {
    expect(mountPane().find('.comment').text()).toBe('the detail-pane comparison fixture');
  });

  it('shows a loading state rather than a stale table', () => {
    const wrapper = mountPane({ loading: true, detail: null });
    expect(wrapper.text()).toContain('Reading catalog');
    expect(wrapper.find('[data-detail-columns]').exists()).toBe(false);
  });

  it('shows an error state', () => {
    const wrapper = mountPane({
      error: 'PERMISSION_DENIED: permission denied for table big',
      detail: null,
    });
    expect(wrapper.find('[data-detail-error]').text()).toContain('PERMISSION_DENIED');
  });

  it('invites a selection when nothing is selected', () => {
    const wrapper = mountPane({ detail: null });
    expect(wrapper.text()).toMatch(/Select a table, view or materialized view/);
  });

  it('does not crash on a detail with no meta comment and no ddl', () => {
    const detail = tableDetail();
    const wrapper = mountPane({
      detail: { ...detail, meta: { ...detail.meta, comment: null }, ddl: [] },
    });
    expect(wrapper.find('.comment').exists()).toBe(false);
    expect(wrapper.find('[data-detail-no-ddl]').exists()).toBe(true);
  });
});

describe('does not reinterpret the catalog', () => {
  it('renders whatever the server said, even when it is unexpected', () => {
    // A pane that "tidied" a definition would be a second place for the
    // interpretation to be wrong. Whatever arrives is what is shown.
    const wrapper = mountPane({
      detail: tableDetail({
        constraints: [
          constraint({
            name: 'weird',
            kind: 'exclusion',
            definition: 'EXCLUDE USING gist (range_a WITH &&)',
          }),
        ],
      }),
    });
    expect(wrapper.find('[data-detail-constraints] .badge').text()).toBe('exclusion');
    expect(wrapper.find('[data-detail-constraints] .def').text()).toBe(
      'weird — EXCLUDE USING gist (range_a WITH &&)',
    );
  });

  it('survives a hostile name without rendering it as markup', () => {
    const detail = tableDetail();
    const wrapper = mountPane({
      detail: {
        ...detail,
        meta: { ...detail.meta, schema: 's', name: '<img src=x onerror=alert(1)>' },
      },
    });
    // Vue escapes interpolation, so the string appears as text and no element is
    // created — the pane is not an injection surface for a catalog value.
    expect(wrapper.find('[data-detail-title]').text()).toBe('s.<img src=x onerror=alert(1)>');
    expect(wrapper.element.querySelectorAll('img')).toHaveLength(0);
  });
});
