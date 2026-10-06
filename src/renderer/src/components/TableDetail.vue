<script setup lang="ts">
/**
 * The table detail pane (PLAN Phase 6).
 *
 * Everything it shows comes from one `TableDetail` that main assembled from
 * `pg_catalog`, so the pane holds no logic of its own beyond formatting — which is
 * the point: a detail view that reinterprets the catalog is a second place for the
 * interpretation to be wrong.
 *
 * Fidelity against `psql`'s `\d+` is the exit criterion. Where this pane matches
 * it and where it deliberately does not, verified against a live PostgreSQL 18.6:
 *
 * **Matches.** Column names, order, types, nullability, defaults and descriptions.
 * Types are `format_type` output, so the pane says `character varying(255)` and
 * `numeric(12,4)`, not the bare `varchar`/`numeric` that `pg_type.typname` gives.
 *
 * **Differs in text, not meaning.** Index and constraint definitions are
 * `pg_get_indexdef` / `pg_get_constraintdef` output. psql *reformats* both: it
 * prints `CHECK (amount >= 0::numeric)` where the catalog returns
 * `CHECK ((amount >= (0)::numeric))`, and it reduces an index to
 * `btree (lower(code::text))` where the catalog returns the whole
 * `CREATE INDEX … USING btree (lower((code)::text))`. Tabby shows the catalog's
 * version, because that is the one guaranteed to re-parse when pasted back.
 *
 * **Omitted, on purpose.** The Collation column, and the `generated … as identity`
 * / `GENERATED ALWAYS AS (…) STORED` markers `\d+` folds into Default — both need
 * catalog reads Phase 6 does not make (`attcollation`, `attidentity`,
 * `attgenerated`), and inventing a value would be worse than leaving the cell out.
 * Also the "Not-null constraints" section 18 added: the Nullable column already
 * says it, and listing both would show every NOT NULL column twice.
 */
import { computed } from 'vue';
import type { TableDetail } from '@shared/domain';

const props = defineProps<{
  detail: TableDetail | null;
  loading: boolean;
  error: string | null;
}>();

const emit = defineEmits<{ notice: [message: string]; copyDdl: [text: string] }>();

const meta = computed(() => props.detail?.meta ?? null);

/** The relation name for the heading, taken from the meta so it cannot disagree. */
const qualified = computed(() => {
  const value = meta.value;
  return value === null ? '' : `${value.schema}.${value.name}`;
});

const rowCountLabel = computed(() => {
  const value = meta.value;
  if (value === null) return '';
  // -1 is Postgres' own "never analysed". Printing 0 there would claim the table
  // is empty, which is a different and much more misleading statement.
  if (value.rowEstimate < 0) return 'rows unknown — not analysed';
  return `~${value.rowEstimate.toLocaleString()} rows (estimate)`;
});

const keyColumns = computed(() => new Set(meta.value?.primaryKey ?? []));

const CONSTRAINT_LABELS: Record<string, string> = {
  primary: 'primary key',
  unique: 'unique',
  foreign: 'foreign key',
  check: 'check',
  exclusion: 'exclusion',
};

function constraintLabel(kind: string): string {
  return CONSTRAINT_LABELS[kind] ?? kind;
}

const ddlText = computed(() => (props.detail?.ddl ?? []).join('\n\n'));

async function onCopyDdl(): Promise<void> {
  const text = ddlText.value;
  if (text === '') return;
  emit('copyDdl', text);
}
</script>

<template>
  <section class="detail" data-table-detail aria-label="Table detail">
    <div v-if="loading" class="placeholder">Reading catalog…</div>

    <div v-else-if="error" class="placeholder warn" data-detail-error>{{ error }}</div>

    <div v-else-if="detail === null" class="placeholder">
      Select a table, view or materialized view to see its columns, indexes, constraints and DDL.
    </div>

    <template v-else>
      <header class="head">
        <h2 class="title" data-detail-title>{{ qualified }}</h2>
        <span class="kind">{{ detail.kind }}</span>
        <span class="rows">{{ rowCountLabel }}</span>
      </header>

      <p v-if="meta?.comment" class="comment">{{ meta.comment }}</p>

      <div class="scroll">
        <h3 class="section">Columns · {{ meta?.columns.length ?? 0 }}</h3>
        <table class="grid" data-detail-columns>
          <thead>
            <tr>
              <th class="num">#</th>
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="column in meta?.columns ?? []" :key="column.name">
              <td class="num muted">{{ column.position }}</td>
              <td class="name">
                <span v-if="keyColumns.has(column.name)" class="key" title="Primary key">🔑</span>
                {{ column.name }}
              </td>
              <!-- format_type, so the modifiers that define the column survive. -->
              <td class="type">{{ column.formattedType }}</td>
              <td :class="column.nullable ? 'muted' : 'notnull'">
                {{ column.nullable ? 'yes' : 'no' }}
              </td>
              <td class="default muted">{{ column.defaultExpression ?? '' }}</td>
              <td class="muted">{{ column.comment ?? '' }}</td>
            </tr>
            <tr v-if="(meta?.columns.length ?? 0) === 0">
              <td colspan="6" class="muted">no columns</td>
            </tr>
          </tbody>
        </table>

        <h3 class="section">Indexes · {{ detail.indexes.length }}</h3>
        <ul v-if="detail.indexes.length > 0" class="list" data-detail-indexes>
          <li v-for="index in detail.indexes" :key="index.name">
            <span class="badge" :class="{ primary: index.isPrimary, unique: index.isUnique }">
              {{ index.isPrimary ? 'pk' : index.isUnique ? 'unique' : 'index' }}
            </span>
            <!-- The server's own pg_get_indexdef text: already quoted, and it
                 renders expression and partial indexes we could not rebuild. -->
            <code class="def">{{ index.definition }}</code>
          </li>
        </ul>
        <p v-else class="muted none">no indexes</p>

        <h3 class="section">Constraints · {{ detail.constraints.length }}</h3>
        <ul v-if="detail.constraints.length > 0" class="list" data-detail-constraints>
          <li v-for="constraint in detail.constraints" :key="constraint.name">
            <span class="badge">{{ constraintLabel(constraint.kind) }}</span>
            <code class="def">{{ constraint.name }} — {{ constraint.definition }}</code>
          </li>
        </ul>
        <p v-else class="muted none">
          no constraints
          <!-- PostgreSQL 18 stores NOT NULL in pg_constraint as contype 'n'; it is
               dropped on purpose, because the Nullable column above already says
               it and listing both would show every column twice. -->
        </p>

        <h3 class="section">
          DDL
          <button v-if="ddlText !== ''" type="button" class="btn" data-copy-ddl @click="onCopyDdl">
            Copy
          </button>
        </h3>
        <pre v-if="ddlText !== ''" class="ddl" data-detail-ddl>{{ ddlText }}</pre>
        <p v-else class="muted none" data-detail-no-ddl>
          Tabby does not generate DDL for a {{ detail.kind }}. A sequence's start, increment and
          cache are not read here, and emitting <code>create sequence</code> without them would be
          valid and wrong.
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--color-surface);
}
.placeholder {
  padding: 16px;
  font-size: 11px;
  color: var(--color-muted);
}
.placeholder.warn {
  color: var(--color-warn);
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-line);
}
.title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-fg);
}
.kind,
.rows {
  font-size: 10px;
  color: var(--color-muted);
}
.rows {
  margin-left: auto;
}
.comment {
  margin: 0;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--color-muted);
  border-bottom: 1px solid var(--color-line);
}
.scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 10px 12px;
}
.section {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-muted);
}
.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.grid th {
  position: sticky;
  top: 0;
  padding: 3px 6px;
  border-bottom: 1px solid var(--color-line);
  background: var(--color-panel);
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 500;
  text-align: left;
}
.grid td {
  padding: 2px 6px;
  border-bottom: 1px solid rgba(28, 58, 94, 0.35);
  color: var(--color-fg);
  vertical-align: top;
}
.num {
  width: 2.5em;
  text-align: right;
}
.muted {
  color: var(--color-muted);
}
.notnull {
  color: var(--color-ok);
}
.type {
  color: var(--color-accent);
}
.default,
.name {
  white-space: nowrap;
}
.key {
  font-size: 9px;
}
.list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 11px;
}
.list li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(28, 58, 94, 0.35);
}
.badge {
  flex-shrink: 0;
  padding: 0 4px;
  border: 1px solid var(--color-line);
  border-radius: 3px;
  font-size: 9px;
  color: var(--color-muted);
}
.badge.primary {
  border-color: var(--color-ok);
  color: var(--color-ok);
}
.badge.unique {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.def {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--color-fg);
}
.none {
  margin: 2px 0;
  font-size: 11px;
}
.ddl {
  margin: 0;
  padding: 8px;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  background: var(--color-panel);
  color: var(--color-fg);
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.btn {
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid var(--color-line);
  border-radius: 3px;
  background: rgba(28, 58, 94, 0.25);
  color: var(--color-fg);
  font: inherit;
  font-size: 10px;
  text-transform: none;
  letter-spacing: 0;
  cursor: pointer;
}
.btn:hover {
  background: rgba(59, 118, 240, 0.25);
}
</style>
