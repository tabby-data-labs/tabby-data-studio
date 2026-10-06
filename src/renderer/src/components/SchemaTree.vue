<script setup lang="ts">
/**
 * The schema explorer's tree (PLAN Phase 6).
 *
 * Hand-built and virtualised: a native scroller whose content is a spacer sized to
 * the whole tree, with only the visible slice — plus overscan — actually in the
 * DOM. Two thousand relations and twenty cost the same per frame, because the
 * scroll handler updates one number and `virtualWindow` is O(1). Everything that
 * decides *which* rows exist lives in `@/schema/tree-model` and is tested there;
 * this file renders the answer and forwards intent.
 *
 * **Accessibility, stated plainly.** A virtualised list cannot expose rows that are
 * not rendered. Each `treeitem` therefore carries `aria-level`, `aria-posinset` and
 * `aria-setsize`, which is the WAI-ARIA-sanctioned way to tell an assistive
 * technology its true position in a list it can only see a window of. The nesting
 * is conveyed by `aria-level` rather than by nested `role="group"` elements, since
 * the DOM is deliberately flat. The spacer and slice wrappers are
 * `role="presentation"` so they do not break the `tree` → `treeitem` ownership
 * chain. This has not had a human VoiceOver pass — see the readme.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { quoteIdent, quoteQualified } from '@shared/ident';
import TreeMenu from './TreeMenu.vue';
import { useSchemaStore } from '@/stores/schema';
import {
  DEFAULT_ROW_HEIGHT,
  indexOfId,
  keyAction,
  scrollOffsetForIndex,
  virtualWindow,
  type TreeRow,
} from '@/schema/tree-model';

const emit = defineEmits<{
  /** Browse the relation: paged, unlimited, no transaction held open. */
  open: [row: TreeRow];
  /** `select * from … limit 1000`, run as an ordinary query. */
  openTop: [row: TreeRow];
  notice: [message: string];
}>();

const schema = useSchemaStore();

const scroller = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
const menu = ref<{ x: number; y: number; row: TreeRow } | null>(null);

/**
 * The per-frame path. Reads exactly two refs and does constant work; the row list
 * is not touched, which is the whole point of splitting flatten from window.
 */
const view = computed(() =>
  virtualWindow({
    scrollTop: scrollTop.value,
    viewportHeight: viewportHeight.value,
    rowHeight: DEFAULT_ROW_HEIGHT,
    totalRows: schema.rows.length,
  }),
);

const visible = computed(() => schema.rows.slice(view.value.start, view.value.end));

const RELATION_KINDS = new Set(['table', 'view', 'materializedView']);

function isRelation(row: TreeRow): boolean {
  return RELATION_KINDS.has(row.kind);
}

/** The caret glyph doubles as the expansion state for sighted users. */
function caretFor(row: TreeRow): string {
  if (row.loading) return '⟳';
  if (row.failed) return '!';
  if (!row.expandable) return '';
  return row.expanded ? '▾' : '▸';
}

function glyphFor(row: TreeRow): string {
  switch (row.kind) {
    case 'connection':
      return '⌁';
    case 'schema':
      return '▤';
    case 'table':
      return '▦';
    case 'view':
      return '◇';
    case 'materializedView':
      return '◈';
    case 'sequence':
      return '#';
    default:
      return '·';
  }
}

/**
 * `~10M` from `reltuples`, or nothing. An estimate is marked as one; `-1` means
 * the table has never been analysed and showing `0` there would be a lie.
 */
function estimateFor(row: TreeRow): string {
  if (row.rowEstimate < 0) return '';
  if (row.rowEstimate >= 1_000_000) return `~${(row.rowEstimate / 1_000_000).toFixed(1)}M`;
  if (row.rowEstimate >= 1_000) return `~${(row.rowEstimate / 1_000).toFixed(1)}k`;
  return `${row.rowEstimate}`;
}

function onClick(row: TreeRow): void {
  schema.select(row);
}

function onCaretClick(row: TreeRow): void {
  schema.toggle(row);
}

function onDoubleClick(row: TreeRow): void {
  if (isRelation(row)) {
    emit('open', row);
    return;
  }
  if (row.expandable) schema.toggle(row);
}

function onScroll(): void {
  const el = scroller.value;
  if (el) scrollTop.value = el.scrollTop;
}

function reveal(index: number): void {
  const el = scroller.value;
  if (!el || index < 0) return;
  const target = scrollOffsetForIndex(
    index,
    DEFAULT_ROW_HEIGHT,
    viewportHeight.value,
    el.scrollTop,
    schema.rows.length,
  );
  // Assigning scrollTop fires the scroll event, which updates `scrollTop` and so
  // the rendered slice — no manual invalidation needed.
  if (target !== null) el.scrollTop = target;
}

function rowAt(id: string): TreeRow | null {
  const index = indexOfId(schema.rows, id);
  return index < 0 ? null : (schema.rows[index] ?? null);
}

function onKeydown(event: KeyboardEvent): void {
  const pageSize = Math.max(1, Math.floor(viewportHeight.value / DEFAULT_ROW_HEIGHT));
  const action = keyAction(schema.rows, schema.selectedId, event.key, { pageSize });
  if (action.type === 'none') return;

  // Prevented only for keys the tree owns. Swallowing Tab would trap focus in the
  // pane and make the rest of the app unreachable by keyboard.
  event.preventDefault();

  if (action.type === 'select') {
    const row = rowAt(action.id);
    schema.select(row);
    reveal(indexOfId(schema.rows, action.id));
    return;
  }
  if (action.type === 'toggle') {
    const row = rowAt(action.id);
    if (row) schema.toggle(row);
    return;
  }
  const row = rowAt(action.id);
  if (row) emit('open', row);
}

function onContextMenu(row: TreeRow, event: MouseEvent): void {
  schema.select(row);
  menu.value = { x: event.clientX, y: event.clientY, row };
}

const menuItems = computed(() => {
  const row = menu.value?.row;
  if (!row) return [];
  const relation = isRelation(row);
  return [
    { id: 'open', label: 'Select top 1000', disabled: !relation },
    { id: 'browse', label: 'Browse all rows', disabled: !relation },
    { id: 'copy-name', label: 'Copy name' },
    {
      id: 'copy-qualified',
      label: 'Copy qualified name',
      disabled: row.kind === 'connection',
    },
    { id: 'filter', label: `Filter to “${row.label}”` },
    { id: 'refresh', label: 'Refresh schema' },
  ];
});

/**
 * The name a user would paste into SQL. Quoted, because a name that needs quotes
 * is exactly the name that breaks when copied bare — and `quoteIdent` is the same
 * function main uses, so what is copied is what will run.
 */
function qualifiedNameFor(row: TreeRow): string | null {
  try {
    if (isRelation(row) || row.kind === 'sequence' || row.kind === 'index') {
      return row.schema === '' ? quoteIdent(row.label) : quoteQualified(row.schema, row.label);
    }
    if (row.kind === 'schema') return quoteIdent(row.label);
    return null;
  } catch {
    // A name quoteIdent refuses cannot be pasted into SQL either; saying so beats
    // putting a broken identifier on the clipboard.
    return null;
  }
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    emit('notice', `Copied ${what}`);
  } catch {
    // A packaged renderer is a non-secure `file://` origin, where the async
    // clipboard API can be unavailable. Report it rather than failing silently:
    // the user asked for something and got nothing.
    emit('notice', `Clipboard refused — ${what} not copied`);
  }
}

async function onMenuSelect(id: string): Promise<void> {
  const row = menu.value?.row;
  menu.value = null;
  if (!row) return;

  switch (id) {
    case 'open':
      emit('openTop', row);
      return;
    case 'browse':
      emit('open', row);
      return;
    case 'copy-name':
      await copyText(row.label, `"${row.label}"`);
      return;
    case 'copy-qualified': {
      const qualified = qualifiedNameFor(row);
      if (qualified === null) {
        emit('notice', 'Nothing to copy for that node');
        return;
      }
      await copyText(qualified, qualified);
      return;
    }
    case 'filter':
      schema.filter = row.label;
      return;
    case 'refresh':
      await schema.refresh();
      emit('notice', 'Schema refreshed');
      return;
    default:
      return;
  }
}

let observer: ResizeObserver | null = null;

/**
 * Measures the scroller and (re)attaches the resize observer.
 *
 * Called from a watcher on the template ref as well as from `onMounted`, because
 * the scroller does not always exist at mount time: the pane renders an empty
 * state while no connection is open, and the `v-else` branch creates the element
 * later. Measuring only in `onMounted` would leave `viewportHeight` at 0 for the
 * rest of the session, and a zero viewport collapses the window to its overscan —
 * the tree would show six rows and never grow.
 */
function measure(): void {
  const el = scroller.value;
  observer?.disconnect();
  observer = null;
  if (!el) {
    viewportHeight.value = 0;
    return;
  }
  viewportHeight.value = el.clientHeight;
  // Guarded because happy-dom does not implement ResizeObserver; the pane still
  // works there, it just measures once.
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      viewportHeight.value = el.clientHeight;
    });
    observer.observe(el);
  }
}

watch(scroller, measure, { flush: 'post' });

onMounted(measure);

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <aside class="tree-pane" data-schema-tree aria-label="Schema explorer">
    <div class="toolbar">
      <input
        v-model="schema.filter"
        class="filter"
        data-tree-filter
        type="search"
        placeholder="Filter loaded objects…"
        spellcheck="false"
        aria-label="Filter the schema tree"
      />
      <button
        type="button"
        class="btn"
        data-tree-refresh
        :disabled="!schema.isAttached || schema.refreshing"
        title="Drop the cached catalog and reload"
        @click="schema.refresh()"
      >
        {{ schema.refreshing ? '…' : '⟳' }}
      </button>
    </div>

    <div v-if="!schema.isAttached" class="empty">Open a connection to browse its schema.</div>

    <div
      v-else
      ref="scroller"
      class="scroller"
      data-tree-scroller
      role="tree"
      tabindex="0"
      :aria-label="schema.connectionLabel"
      @scroll="onScroll"
      @keydown="onKeydown"
    >
      <!-- Height is the whole tree; only the slice below is in the DOM. -->
      <div role="presentation" :style="{ height: `${view.contentHeight}px`, position: 'relative' }">
        <div
          role="presentation"
          :style="{ transform: `translateY(${view.offsetY}px)` }"
          data-tree-slice
        >
          <div
            v-for="(row, offset) in visible"
            :key="row.id"
            class="row"
            :class="{
              selected: row.id === schema.selectedId,
              failed: row.failed,
              leaf: !row.expandable,
            }"
            :style="{ height: `${DEFAULT_ROW_HEIGHT}px`, paddingLeft: `${row.depth * 14 + 4}px` }"
            role="treeitem"
            :aria-level="row.depth + 1"
            :aria-selected="row.id === schema.selectedId"
            :aria-expanded="row.expandable ? row.expanded : undefined"
            :aria-setsize="schema.rows.length"
            :aria-posinset="view.start + offset + 1"
            :data-row-index="view.start + offset"
            :data-node-kind="row.kind"
            :data-node-label="row.label"
            :title="row.comment ?? undefined"
            @click="onClick(row)"
            @dblclick="onDoubleClick(row)"
            @contextmenu.prevent="onContextMenu(row, $event)"
          >
            <span
              class="caret"
              :class="{ clickable: row.expandable }"
              @click.stop="onCaretClick(row)"
            >
              {{ caretFor(row) }}
            </span>
            <span class="glyph" :data-glyph="row.kind">{{ glyphFor(row) }}</span>
            <span class="label">{{ row.label }}</span>
            <span v-if="row.loading" class="hint">loading…</span>
            <span v-else-if="row.failed" class="hint warn">failed</span>
            <span v-else-if="row.expanded && row.childCount === 0" class="hint">(empty)</span>
            <span v-else class="estimate">{{ estimateFor(row) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="schema.isAttached" class="status">
      <span>{{ schema.rows.length.toLocaleString() }} visible</span>
      <span v-if="schema.filterIsIncomplete" class="warn">
        {{ schema.unsearchedSchemas }} schema{{ schema.unsearchedSchemas === 1 ? '' : 's' }} not
        searched
      </span>
      <span v-else-if="schema.filtering" class="muted">filtered</span>
    </div>

    <div v-if="schema.error" class="error" data-tree-error>
      {{ schema.error.code }}: {{ schema.error.message }}
    </div>

    <TreeMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </aside>
</template>

<style scoped>
.tree-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  border-right: 1px solid var(--color-line);
  background: var(--color-surface);
}
.toolbar {
  display: flex;
  gap: 4px;
  padding: 6px;
  border-bottom: 1px solid var(--color-line);
}
.filter {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  background: var(--color-panel);
  color: var(--color-fg);
  font: inherit;
  font-size: 11px;
}
.btn {
  padding: 3px 8px;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  background: rgba(28, 58, 94, 0.25);
  color: var(--color-fg);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  background: rgba(59, 118, 240, 0.25);
}
.btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.scroller {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  outline: none;
}
.scroller:focus-visible {
  box-shadow: inset 0 0 0 1px var(--color-accent);
}
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 6px;
  font-size: 11px;
  white-space: nowrap;
  cursor: default;
  user-select: none;
}
.row:hover {
  background: rgba(28, 58, 94, 0.35);
}
.row.selected {
  background: rgba(59, 118, 240, 0.3);
}
.row.failed .label {
  color: var(--color-warn);
}
.caret {
  width: 12px;
  flex-shrink: 0;
  text-align: center;
  color: var(--color-muted);
}
.caret.clickable {
  cursor: pointer;
}
.glyph {
  flex-shrink: 0;
  color: var(--color-muted);
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-fg);
}
.estimate,
.hint {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--color-muted);
  font-size: 10px;
}
.hint.warn {
  color: var(--color-warn);
}
.empty {
  padding: 12px;
  font-size: 11px;
  color: var(--color-muted);
}
.status {
  display: flex;
  gap: 8px;
  padding: 4px 6px;
  border-top: 1px solid var(--color-line);
  font-size: 10px;
  color: var(--color-muted);
}
.status .warn {
  color: var(--color-warn);
}
.status .muted {
  color: var(--color-muted);
}
.error {
  padding: 4px 6px;
  border-top: 1px solid var(--color-line);
  font-size: 10px;
  color: var(--color-warn);
}
</style>
