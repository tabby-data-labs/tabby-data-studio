<script setup lang="ts">
/**
 * The minimum viable way to get live rows on screen: a statement box and a
 * "browse a table" shortcut.
 *
 * Phase 7 replaces the textarea with a real editor (highlight layer, lexer-aware
 * statement splitting); this exists so Phase 5's exit criteria — fast-scrolling a
 * 10M-row table shows placeholders, never wrong data — can actually be looked at.
 *
 * The browse shortcut is the reason `@shared/ident` exists in the renderer: it
 * builds `select * from "schema"."table"` and sends the names separately as the
 * `browse` target, so main can page without holding a transaction open.
 */
import { computed, ref } from 'vue';
import { quoteQualified } from '@shared/ident';
import type { RunInput } from '@/stores/results';

const props = defineProps<{
  connectionId: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{ run: [input: RunInput] }>();

const sql = ref('');
const tableRef = ref('');
const hint = ref<string | null>(null);

const canRun = computed(() => props.connectionId !== null && !props.busy);

/** Rows fetched before the first window request; matches main's default. */
const INITIAL_ROWS = 200;

function titleFor(statement: string): string {
  const collapsed = statement.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}…` : collapsed;
}

function runSql(): void {
  if (!canRun.value || props.connectionId === null) return;
  const statement = sql.value.trim();
  if (statement === '') {
    hint.value = 'nothing to run';
    return;
  }
  hint.value = null;
  emit('run', {
    connectionId: props.connectionId,
    sql: statement,
    title: titleFor(statement),
    initialRows: INITIAL_ROWS,
  });
}

/**
 * Splits `schema.table` on the **first** dot. A table name may itself contain a
 * dot (`"weird.name"`), and Postgres qualified names in this position are always
 * two parts, so everything after the first dot is the table.
 */
function parseTableRef(raw: string): { schema: string; table: string } | null {
  const text = raw.trim();
  if (text === '') return null;
  const dot = text.indexOf('.');
  return dot < 0
    ? { schema: 'public', table: text }
    : { schema: text.slice(0, dot), table: text.slice(dot + 1) };
}

function browseTable(): void {
  if (!canRun.value || props.connectionId === null) return;
  const parsed = parseTableRef(tableRef.value);
  if (!parsed || parsed.schema === '' || parsed.table === '') {
    hint.value = 'enter a table as schema.table (schema defaults to public)';
    return;
  }

  let statement: string;
  try {
    statement = `select * from ${quoteQualified(parsed.schema, parsed.table)}`;
  } catch {
    // quoteIdent refuses a NUL byte or a name over 63 bytes. Reporting that here
    // beats sending something main would reject with a less specific message.
    hint.value = 'that is not a usable identifier (NUL byte, or over 63 bytes)';
    return;
  }

  hint.value = null;
  emit('run', {
    connectionId: props.connectionId,
    sql: statement,
    title: `${parsed.schema}.${parsed.table}`,
    browse: parsed,
    initialRows: INITIAL_ROWS,
  });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    runSql();
  }
}
</script>

<template>
  <div class="border-b border-line bg-panel px-4 py-2 text-xs">
    <div class="flex items-start gap-2">
      <textarea
        v-model="sql"
        class="input h-14 flex-1 resize-y font-mono"
        placeholder="select * from fixtures.big order by id"
        spellcheck="false"
        @keydown="onKeydown"
      />
      <div class="flex flex-col gap-1">
        <button type="button" class="btn" :disabled="!canRun" @click="runSql">
          {{ busy ? 'Running…' : 'Run' }}
        </button>
        <span class="text-[10px] text-muted">⌘/Ctrl+↵</span>
      </div>
    </div>

    <div class="mt-2 flex flex-wrap items-center gap-2">
      <span class="text-muted">or browse</span>
      <input
        v-model="tableRef"
        class="input w-64"
        data-browse-input
        placeholder="fixtures.big"
        spellcheck="false"
        @keydown.enter="browseTable"
      />
      <button type="button" class="btn" :disabled="!canRun" @click="browseTable">Open table</button>
      <span class="text-[10px] text-muted">
        pages without holding a transaction open when the table has a usable key
      </span>
      <span v-if="hint" class="text-warn">{{ hint }}</span>
      <span v-if="connectionId === null" class="text-warn">open a connection first</span>
    </div>
  </div>
</template>

<style scoped>
.btn {
  border: 1px solid var(--color-line);
  border-radius: 4px;
  padding: 3px 8px;
  color: var(--color-fg);
  background: rgba(28, 58, 94, 0.25);
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  background: rgba(59, 118, 240, 0.25);
}
.btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.input {
  border: 1px solid var(--color-line);
  border-radius: 4px;
  padding: 3px 6px;
  background: var(--color-surface);
  color: var(--color-fg);
  font: inherit;
}
</style>
