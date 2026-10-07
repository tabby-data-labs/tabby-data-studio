<script setup lang="ts">
/**
 * The query-history panel (PLAN Phase 7).
 *
 * An overlay rather than a fourth sidebar: the window already carries the tree and
 * the detail pane, and history is something a user opens, takes one thing from, and
 * closes. It is mounted only while open, so its list — up to
 * `HISTORY_LIMITS.maxEntriesReturned` rows — costs nothing until then.
 *
 * The privacy note from PLAN is rendered here rather than left in a document, on
 * the reasoning that a warning about stored secrets belongs where the secrets are
 * listed. "Clear all" asks first, because it is the one action in the app that
 * destroys data the user did not create in this session.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { collapseSql, type HistoryEntry } from '@shared/history';
import { t, tPlural } from '@/i18n';
import { useHistoryStore } from '@/stores/history';

const emit = defineEmits<{
  /** Restore a statement into the editor. The panel does not own the editor. */
  load: [sql: string];
  notice: [text: string];
}>();

const history = useHistoryStore();

const search = ref(history.query);
/** Set while "Clear all" is waiting for a second click, instead of a modal dialog. */
const confirming = ref(false);

const rows = computed(() => history.filtered);

/** One row of the statement, collapsed — the list is a scannable index, not a viewer. */
function previewOf(entry: HistoryEntry): string {
  const collapsed = collapseSql(entry.sql);
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}…` : collapsed;
}

function whenOf(entry: HistoryEntry): string {
  // A hand-edited or clock-skewed file can carry an impossible timestamp; showing
  // "Invalid Date" for it would look like a crash rather than bad data.
  const date = new Date(entry.ranAt);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString();
}

function statusLabel(entry: HistoryEntry): string {
  if (entry.status === 'ok') {
    const rows = entry.rowCount < 0 ? '' : ` · ${entry.rowCount.toLocaleString()} rows`;
    const time = entry.elapsedMs < 0 ? '' : ` · ${entry.elapsedMs}ms`;
    return `ok${rows}${time}`;
  }
  return entry.status;
}

function onLoad(entry: HistoryEntry): void {
  if (entry.truncated) {
    // A prefix of a statement is a different statement, and running one because the
    // history looked complete is the kind of surprise that costs real money.
    emit('notice', t('history.truncated'));
    return;
  }
  emit('load', entry.sql);
  history.hide();
}

async function onDelete(entry: HistoryEntry): Promise<void> {
  const removed = await history.remove(entry.id);
  emit('notice', removed ? 'Removed from history' : `Could not remove: ${history.error?.message}`);
}

async function onClear(): Promise<void> {
  if (!confirming.value) {
    confirming.value = true;
    return;
  }
  confirming.value = false;
  const removed = await history.clear();
  emit(
    'notice',
    removed === null
      ? `Could not clear history: ${history.error?.message}`
      : tPlural('history.cleared', removed, { count: removed }),
  );
}

function onSearch(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  search.value = value;
  history.search(value);
}

/** Escape closes; nothing else is trapped, so Tab still leaves the panel. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    history.hide();
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    class="panel"
    role="dialog"
    :aria-label="t('history.title')"
    data-history-panel
    @keydown="onKeydown"
  >
    <header class="head">
      <h2 class="title">{{ t('history.title') }}</h2>
      <span class="count" data-history-count>
        {{ t('history.shown', { count: rows.length }) }}
      </span>
      <button
        type="button"
        class="btn"
        data-history-close
        :aria-label="t('common.close')"
        @click="history.hide()"
      >
        ✕
      </button>
    </header>

    <input
      class="search"
      type="search"
      data-history-search
      :placeholder="t('history.filterPlaceholder')"
      :aria-label="t('history.filterPlaceholder')"
      :value="search"
      @input="onSearch"
    />

    <p v-if="history.warning" class="warn" data-history-warning>{{ history.warning }}</p>
    <p v-if="history.error" class="warn" data-history-error>
      {{ history.error.code }}: {{ history.error.message }}
    </p>
    <p v-if="history.skipped > 0" class="warn" data-history-skipped>
      {{ history.skipped }} unreadable {{ history.skipped === 1 ? 'line' : 'lines' }} skipped
    </p>

    <div class="list" data-history-list>
      <p v-if="history.loading" class="empty" data-history-loading>Reading history…</p>
      <p v-else-if="history.isEmpty" class="empty" data-history-empty>
        {{ t('history.empty') }}
      </p>
      <p v-else-if="rows.length === 0" class="empty" data-history-no-match>
        No entry matches “{{ search }}”.
      </p>

      <ul v-else class="rows">
        <li v-for="entry in rows" :key="entry.id" class="row" data-history-item>
          <button
            type="button"
            class="main"
            data-history-load
            :class="{ truncated: entry.truncated }"
            :title="entry.truncated ? 'Stored as a prefix — too long to keep in full' : entry.sql"
            :aria-label="`Load ${previewOf(entry)}`"
            @click="onLoad(entry)"
          >
            <span class="line1">
              <span class="status" :data-status="entry.status">{{ statusLabel(entry) }}</span>
              <span class="when">{{ whenOf(entry) }}</span>
              <span v-if="entry.truncated" class="badge" data-history-truncated>truncated</span>
            </span>
            <span class="conn">{{ entry.connectionLabel || entry.connectionId }}</span>
            <code class="sql">{{ previewOf(entry) }}</code>
          </button>
          <button
            type="button"
            class="btn delete"
            data-history-delete
            aria-label="Delete this entry"
            @click="onDelete(entry)"
          >
            ✕
          </button>
        </li>
      </ul>
    </div>

    <footer class="foot">
      <button
        type="button"
        class="btn danger"
        data-history-clear
        :disabled="history.isEmpty"
        @click="onClear"
      >
        {{ confirming ? 'Click again to delete everything' : t('common.clear') }}
      </button>
      <span class="note" data-history-privacy>{{ t('history.privacy') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--color-line);
  border-radius: 6px;
  background: var(--color-panel);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  font-size: 11px;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-line);
}
.title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-fg);
}
.count {
  color: var(--color-muted);
  font-size: 10px;
}
.head .btn {
  margin-left: auto;
}

.search {
  margin: 6px 8px;
  padding: 3px 6px;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  background: var(--color-surface);
  color: var(--color-fg);
  font: inherit;
}
.search:focus {
  outline: 1px solid var(--color-accent);
}

.warn {
  margin: 0 8px 4px;
  color: var(--color-warn);
  font-size: 10px;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 6px;
}
.empty {
  margin: 12px 0;
  color: var(--color-muted);
  text-align: center;
}
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
}
.row {
  display: flex;
  align-items: stretch;
  gap: 4px;
  border-bottom: 1px solid rgba(28, 58, 94, 0.5);
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 2px;
  border: 0;
  background: transparent;
  color: var(--color-fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.main:hover {
  background: rgba(59, 118, 240, 0.14);
}
.main.truncated {
  cursor: default;
}
.line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
}
.status {
  color: var(--color-ok);
}
.status[data-status='failed'] {
  color: var(--color-warn);
}
.status[data-status='cancelled'] {
  color: var(--color-muted);
}
.when,
.conn {
  color: var(--color-muted);
  font-size: 10px;
}
.conn {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  padding: 0 4px;
  border: 1px solid var(--color-warn);
  border-radius: 3px;
  color: var(--color-warn);
  font-size: 9px;
}
.sql {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-top: 1px solid var(--color-line);
}
.note {
  color: var(--color-muted);
  font-size: 9px;
  line-height: 1.3;
}

.btn {
  padding: 2px 7px;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  background: rgba(28, 58, 94, 0.25);
  color: var(--color-fg);
  font: inherit;
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  background: rgba(59, 118, 240, 0.25);
}
.btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.btn.delete {
  align-self: center;
  color: var(--color-muted);
}
.btn.delete:hover {
  border-color: var(--color-warn);
  color: var(--color-warn);
}
.btn.danger:not(:disabled) {
  border-color: var(--color-warn);
  color: var(--color-warn);
  white-space: nowrap;
}
</style>
