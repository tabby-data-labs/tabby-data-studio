<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { quoteQualified } from '@shared/ident';
import type { SqlStatement } from '@shared/sql-split';
import ConnectionBar from '@/components/ConnectionBar.vue';
import DataGridVue from '@/components/DataGridVue.vue';
import QueryEditor from '@/components/QueryEditor.vue';
import ResultStatus from '@/components/ResultStatus.vue';
import SchemaTree from '@/components/SchemaTree.vue';
import TabBar from '@/components/TabBar.vue';
import TableDetail from '@/components/TableDetail.vue';
import { runScrollBench, type BenchResult } from '@/grid/bench';
import type { DataGrid } from '@/grid/create-data-grid';
import type { ClipboardFormat } from '@/grid/clipboard';
import { FakeDataSource } from '@/grid/fake-source';
import { boundingBox, selectedCellCount } from '@/grid/selection';
import type { DataSource, SelectionState, SortSpec } from '@/grid/types';
import type { TreeRow } from '@/schema/tree-model';
import { useConnectionsStore } from '@/stores/connections';
import { useResultsStore, type RunInput } from '@/stores/results';
import { useSchemaStore } from '@/stores/schema';
import { useTabsStore } from '@/stores/tabs';

const SYNTHETIC_ROWS = 1_000_000;
const SYNTHETIC_COLUMNS = 30;
/** Rows fetched before the first window request; matches main's default. */
const INITIAL_ROWS = 200;
/** What the tree's "Select top 1000" asks for. The SSMS idiom, kept verbatim. */
const TOP_ROWS = 1_000;
/**
 * The demo tab's sentinel result id. Main has never heard of it. It exists so the
 * synthetic 1M-row grid — and therefore the benchmark the perf gate drives —
 * stays reachable once live results are in the tab strip.
 */
const SYNTHETIC_RESULT_ID = 'synthetic';

const synthetic = new FakeDataSource({
  rowCount: SYNTHETIC_ROWS,
  columnCount: SYNTHETIC_COLUMNS,
  seed: 20260923,
});

const connections = useConnectionsStore();
const results = useResultsStore();
const schema = useSchemaStore();
const tabs = useTabsStore();

const grid = shallowRef<DataGrid | null>(null);
const frozen = ref(1);
const selection = ref<SelectionState | null>(null);
const bench = ref<BenchResult | null>(null);
const benching = ref(false);
const sort = ref<SortSpec | null>(null);
const notice = ref<string | null>(null);
const copying = ref<ClipboardFormat | null>(null);
const copyProgress = ref(0);
const versions = ref<{ electron: string; chrome: string; node: string } | null>(null);

const liveResultId = computed(() => {
  const tab = tabs.active;
  // A query tab has no result of its own yet — the editor arrives in Phase 7 — so
  // it shows the demo grid rather than an empty pane.
  return tab?.kind === 'result' && tab.resultId !== SYNTHETIC_RESULT_ID ? tab.resultId : null;
});

/**
 * The grid is remounted, not re-pointed.
 *
 * `DataGridVue` reads `source` once in `onMounted`, and `createDataGrid` binds it
 * into its paint, windowing and clipboard closures. A `:key` change is the honest
 * way to swap a 10M-row live result for a synthetic one; teaching the grid to
 * accept a new source would mean changing its public API, which Phase 5's exit
 * criterion forbids.
 */
const activeSource = computed<DataSource | null>(() => {
  const id = liveResultId.value;
  return id === null ? synthetic : results.sourceOf(id);
});
const gridKey = computed(() => `grid:${liveResultId.value ?? SYNTHETIC_RESULT_ID}`);

const gridLabel = computed(() =>
  liveResultId.value === null
    ? `Synthetic ${SYNTHETIC_ROWS.toLocaleString()} rows`
    : (tabs.active?.title ?? 'Query result'),
);

const headerSummary = computed(() => {
  const source = activeSource.value;
  if (source === null) return 'result closed';
  const rows = source.rowCount;
  const shown =
    rows < 0
      ? 'unknown rows'
      : `${source.rowCountIsEstimate ? '~' : ''}${rows.toLocaleString()} rows`;
  return `${shown} × ${source.columns.length} cols`;
});

onMounted(async () => {
  // Seeded before anything that can fail, so the demo grid is on screen even with
  // no preload and no database.
  tabs.openResult({
    resultId: SYNTHETIC_RESULT_ID,
    title: `demo · ${SYNTHETIC_ROWS.toLocaleString()} synthetic`,
    connectionId: null,
  });

  if (!window.tabby) return;
  versions.value = { ...window.tabby.versions };
  // One subscription for the whole app rather than one per result: a listener
  // attached per tab leaks the moment tabs start closing.
  results.subscribe();
  schema.subscribe();
  await connections.load();
});

onBeforeUnmount(() => {
  results.unsubscribe();
  schema.unsubscribe();
});

/**
 * Reconciles live results against the tab strip.
 *
 * TabBar closes tabs directly on the tabs store, so there is no single call site to
 * hook. Watching the strip means close, close-others and close-all all release
 * their cursors — without it, closing a tab would leave a server-side transaction
 * open, pinning an xmin horizon until the registry's TTL reaped it.
 */
watch(
  () => tabs.all.map((tab) => tab.resultId),
  (openResultIds) => {
    for (const resultId of results.ids) {
      if (!openResultIds.includes(resultId)) results.close(resultId);
    }
  },
);

async function onRun(input: RunInput): Promise<void> {
  notice.value = null;
  const started = await results.run(input);
  if (!started.ok) return;
  tabs.openResult({
    resultId: started.value,
    title: input.title,
    connectionId: input.connectionId,
  });
}

// ── Query console (Phase 7) ──────────────────────────────────────────────────

const runningTitle = ref<string | null>(null);
/** Set when the user cancels, so the rest of a multi-statement script is skipped. */
let cancelled = false;

const runningLabel = computed(() =>
  results.running && runningTitle.value !== null ? runningTitle.value : null,
);

/** First line, collapsed and truncated — the tab has to stay readable. */
function titleFor(statement: SqlStatement): string {
  const firstLine = statement.text.split('\n', 1)[0] ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}…` : collapsed;
}

/**
 * Runs a script one statement at a time, opening a tab per statement.
 *
 * Sequential, not parallel: five tabs filling at once would need five pooled
 * clients, and a script whose second statement depends on the first would race it.
 *
 * Stops at the first failure rather than continuing. Running the rest of a script
 * after a statement has failed almost always produces a cascade of errors that
 * obscure the real one, and — since v1 is read-only but a `create`/`drop` script is
 * still refused rather than ignored — continuing would only add noise.
 */
async function onRunStatements(statements: readonly SqlStatement[]): Promise<void> {
  const connectionId = connections.activeId;
  if (connectionId === null || statements.length === 0) return;

  notice.value = null;
  cancelled = false;

  for (const statement of statements) {
    if (cancelled) break;
    const title = titleFor(statement);
    runningTitle.value = title;

    const started = await results.run({
      connectionId,
      sql: statement.text,
      title,
      initialRows: INITIAL_ROWS,
    });

    if (!started.ok) {
      if (started.error.code === 'QUERY_CANCELLED') {
        cancelled = true;
        notice.value = 'Cancelled';
      }
      break;
    }

    const id = started.value;
    const meta = results.metas.get(id);
    tabs.openResult({
      resultId: id,
      // Per-statement timing in the tab, so five results can be compared without
      // clicking through them. The row count is not here on purpose: it arrives
      // later from the background count and the status line already shows it.
      title: meta === undefined ? title : `${title} · ${meta.elapsedMs}ms`,
      connectionId,
    });
  }

  runningTitle.value = null;
}

/**
 * `EXPLAIN` as an ordinary query, which is exactly what `psql` shows: one text row
 * per plan line, in the grid, selectable and copyable.
 *
 * Not the rendered plan tree PLAN describes — see the Phase 7 notes. Text form is
 * the honest interim: it is complete information, just not pretty.
 */
async function onExplain(statement: SqlStatement): Promise<void> {
  const connectionId = connections.activeId;
  if (connectionId === null) return;
  await onRun({
    connectionId,
    sql: `explain (format text) ${statement.text}`,
    title: `explain · ${titleFor(statement)}`,
    initialRows: INITIAL_ROWS,
  });
}

async function onCancel(): Promise<void> {
  const result = await results.cancelRunning();
  if (result.ok) return;
  // NOT_FOUND here means the run settled between the click and the bridge call,
  // which is a success from the user's point of view, not something to report.
  if (result.error.code === 'NOT_FOUND') return;
  notice.value = `Cancel failed: ${result.error.message}`;
}

function onCloseResult(resultId: string): void {
  const tab = tabs.byResultId(resultId);
  if (tab) tabs.close(tab.id);
}

// ── Schema explorer (Phase 6) ────────────────────────────────────────────────

/**
 * The tree follows the open connection.
 *
 * `opened` is joined into the watch source because `isOpen` is a method: watching
 * it directly would not register a dependency, and the tree would keep showing a
 * closed connection's catalog. Closing detaches rather than merely clearing, so a
 * stale tree can never be browsed into a `NOT_CONNECTED` error.
 */
watch(
  () => [connections.activeId, connections.opened.join(',')] as const,
  ([activeId]) => {
    if (activeId !== null && connections.isOpen(activeId)) {
      const summary = connections.list.find((candidate) => candidate.id === activeId);
      const label =
        summary === undefined
          ? activeId
          : `${summary.name} · ${summary.host}:${summary.port}/${summary.database}`;
      schema.attach(activeId, label);
      return;
    }
    schema.detach();
  },
  { immediate: true },
);

const RELATION_KINDS = new Set(['table', 'view', 'materializedView']);

/** Builds the statement a tree row stands for, or null if the name cannot be quoted. */
function statementFor(row: TreeRow, suffix: string): string | null {
  if (!RELATION_KINDS.has(row.kind) || row.schema === '') return null;
  try {
    return `select * from ${quoteQualified(row.schema, row.label)}${suffix}`;
  } catch {
    return null;
  }
}

/**
 * Double-click / Enter / "Browse all rows": the paged browse path.
 *
 * `browse` is what keeps it cheap — main resolves a pagination key from the
 * catalog and pages with a keyset seek, holding **no transaction open**. Without
 * it the same rows would pin a cursor, and therefore an xmin horizon, for as long
 * as the tab stays open.
 */
async function onBrowseRelation(row: TreeRow): Promise<void> {
  const statement = statementFor(row, '');
  if (statement === null) {
    notice.value = 'That node cannot be browsed';
    return;
  }
  await onRun({
    connectionId: row.connectionId,
    sql: statement,
    title: `${row.schema}.${row.label}`,
    browse: { schema: row.schema, table: row.label },
    initialRows: INITIAL_ROWS,
  });
}

/**
 * "Select top 1000": a real `limit`, run as an ordinary statement.
 *
 * Two things are honest about this one. The rows are whatever the server returns
 * first — no `order by`, so a repeat can differ, exactly as SSMS's "Edit Top 200
 * Rows" does. And unlike the browse path it takes a cursor, which holds a
 * transaction; `idle_in_transaction_session_timeout` (60s by default) will close
 * it if the tab is left alone, and the status line then offers a Retry. That is
 * the pre-existing behaviour of every query-console result, not something the tree
 * introduces.
 */
async function onTopRows(row: TreeRow): Promise<void> {
  const statement = statementFor(row, ` limit ${TOP_ROWS}`);
  if (statement === null) {
    notice.value = 'That node cannot be queried';
    return;
  }
  await onRun({
    connectionId: row.connectionId,
    sql: statement,
    title: `${row.schema}.${row.label} · top ${TOP_ROWS}`,
    initialRows: TOP_ROWS,
  });
}

async function onCopyDdl(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notice.value = 'Copied the generated DDL';
  } catch {
    // A packaged renderer is a non-secure file:// origin, where the async clipboard
    // API can be unavailable. Say so; the text is on screen and selectable either way.
    notice.value = 'Clipboard refused — select the DDL text to copy it';
  }
}

/**
 * The detail pane is always mounted, and shows its own invitation when nothing is
 * selected.
 *
 * Mounting it conditionally was the obvious first version and is worse for two
 * reasons: a pane that appears and disappears resizes the grid under the user, and
 * "Copy DDL" would have no permanent home. Its empty state is a feature — it is how
 * the user learns the pane exists.
 */
const detailErrorText = computed(() => {
  const error = schema.detailError;
  return error === null ? null : `${error.code}: ${error.message}`;
});

const selectionSummary = computed(() => {
  const current = selection.value;
  if (!current || current.ranges.length === 0) return 'No selection';
  const box = boundingBox(current);
  if (!box) return 'No selection';
  const cells = selectedCellCount(current);
  const ranges = current.ranges.length > 1 ? ` · ${current.ranges.length} ranges` : '';
  return `${cells.toLocaleString()} cell${cells === 1 ? '' : 's'} · rows ${box.start.row + 1}–${
    box.end.row + 1
  } · cols ${box.start.col + 1}–${box.end.col + 1}${ranges}`;
});

function onReady(instance: DataGrid): void {
  grid.value = instance;
}

/**
 * Machine-readable copy of the last bench result. The perf gate in
 * src/main/bench-main.ts drives the real UI button and reads this back, so the
 * measurement exercises the same code path a user would.
 */
const benchJson = computed(() => (bench.value ? JSON.stringify(bench.value) : ''));

async function onBench(): Promise<void> {
  const source = activeSource.value;
  if (!grid.value || !source || benching.value) return;
  benching.value = true;
  notice.value = null;
  try {
    // Benchmarks whichever result is on screen, so the 10M-row live case is
    // measured through the same button as the synthetic one.
    bench.value = await runScrollBench(grid.value, {
      frames: 600,
      rowsPerFrame: 40,
      rowCount: Math.max(1, source.rowCount),
    });
  } finally {
    benching.value = false;
  }
}

const COPY_FORMATS = ['tsv', 'csv', 'json', 'sql', 'markdown'] as const;
/** Above this many cells, confirm first: serialising is not free. */
const COPY_CONFIRM_CELLS = 100_000;

async function onCopy(format: ClipboardFormat): Promise<void> {
  if (!grid.value) return;

  const cells = grid.value.selectedCellCount();
  if (cells === 0) {
    notice.value = 'Nothing selected';
    return;
  }
  if (cells > COPY_CONFIRM_CELLS) {
    const ok = window.confirm(
      `Copy ${cells.toLocaleString()} cells as ${format.toUpperCase()}? This may take a moment.`,
    );
    if (!ok) return;
  }

  copying.value = format;
  notice.value = null;
  try {
    const text = await grid.value.copy({
      format,
      includeHeader: format === 'csv' || format === 'markdown',
      table: 'public.exported',
      onProgress: (done, total) => {
        copyProgress.value = total > 0 ? done / total : 0;
      },
    });
    const lines = text.split('\n').length;
    // Distinguish "copied" from "serialised but the clipboard refused", which is
    // a real possibility in a packaged file:// renderer.
    const copyError = grid.value.lastCopyError();
    notice.value = copyError
      ? `Serialised ${cells.toLocaleString()} cells but the clipboard refused: ${copyError}`
      : `Copied ${cells.toLocaleString()} cells as ${format.toUpperCase()} (${lines.toLocaleString()} lines)`;
  } catch (error) {
    notice.value =
      error instanceof Error && error.message.includes('cancelled')
        ? 'Copy cancelled'
        : 'Copy failed — clipboard unavailable';
  } finally {
    copying.value = null;
    copyProgress.value = 0;
  }
}

/**
 * Cycles the first column asc → desc → off.
 *
 * The grid owns the sort path — `setSort` is what paints the header indicator — and
 * it calls `source.sort()`, which for a live result is a server-side re-query.
 * Never a reorder of the few hundred rows the renderer happens to hold.
 */
async function onToggleSort(): Promise<void> {
  if (!grid.value) return;
  const next: SortSpec | null =
    sort.value === null
      ? { columnIndex: 0, direction: 'asc' }
      : sort.value.direction === 'asc'
        ? { columnIndex: 0, direction: 'desc' }
        : null;

  results.sortError = null;
  try {
    await grid.value.setSort(next);
    sort.value = next;
    // A re-query can change the row count's meaning; pull the source's live values
    // into the reactive mirror the status line reads.
    const id = liveResultId.value;
    if (id !== null) results.syncMeta(id);
  } catch (error) {
    results.sortError = {
      code: 'INTERNAL',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function onFreeze(delta: number): void {
  const columns = activeSource.value?.columns.length ?? SYNTHETIC_COLUMNS;
  frozen.value = Math.max(0, Math.min(columns, frozen.value + delta));
}

function onGoToRow(): void {
  const source = activeSource.value;
  if (!source || source.rowCount <= 0) {
    notice.value = 'Row count is not known yet';
    return;
  }
  const raw = window.prompt(`Go to row (1 – ${source.rowCount.toLocaleString()})`);
  if (!raw) return;
  const row = Number.parseInt(raw, 10);
  if (!Number.isFinite(row)) return;
  grid.value?.scrollToRow(Math.max(0, Math.min(source.rowCount - 1, row - 1)), 'center');
}
</script>

<template>
  <div class="flex h-full flex-col bg-surface">
    <header class="flex items-baseline gap-3 border-b border-line bg-panel px-4 py-2">
      <h1 class="text-sm font-semibold tracking-wide text-fg">Tabby</h1>
      <span class="text-xs text-muted">
        Phase 7 — {{ liveResultId === null ? 'synthetic grid' : 'live result' }}
      </span>
      <span class="ml-auto text-[11px] text-muted">
        {{ headerSummary }}
        <template v-if="versions">
          · Electron {{ versions.electron }} · Chromium {{ versions.chrome }}
        </template>
      </span>
    </header>

    <ConnectionBar />
    <QueryEditor
      :connection-id="connections.activeId"
      :busy="results.running"
      :running-label="runningLabel"
      @run="onRunStatements"
      @explain="onExplain"
      @cancel="onCancel"
    />

    <div
      v-if="results.runError"
      class="flex items-center gap-3 border-b border-line bg-panel px-4 py-1.5 text-[11px] text-warn"
      data-run-error
    >
      <span>{{ results.runError.code }}: {{ results.runError.message }}</span>
    </div>

    <TabBar />

    <ResultStatus v-if="liveResultId !== null" :result-id="liveResultId" @close="onCloseResult" />

    <div class="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2 text-xs">
      <button type="button" class="btn" :disabled="benching" @click="onBench">
        {{ benching ? 'Benching…' : 'Run 600-frame bench' }}
      </button>

      <span class="flex items-center gap-1">
        <span class="text-muted">Copy</span>
        <button
          v-for="format in COPY_FORMATS"
          :key="format"
          type="button"
          class="btn"
          :disabled="copying !== null"
          @click="onCopy(format)"
        >
          {{ copying === format ? `${Math.round(copyProgress * 100)}%` : format.toUpperCase() }}
        </button>
      </span>

      <button type="button" class="btn" @click="onToggleSort">
        Sort col 1: {{ sort ? sort.direction : 'off' }}
      </button>
      <button type="button" class="btn" @click="onGoToRow">Go to row…</button>

      <span class="ml-2 flex items-center gap-1">
        <span class="text-muted">Frozen</span>
        <button type="button" class="btn" @click="onFreeze(-1)">−</button>
        <span class="w-4 text-center text-fg">{{ frozen }}</span>
        <button type="button" class="btn" @click="onFreeze(1)">+</button>
      </span>

      <span v-if="notice" class="ml-auto text-ok">{{ notice }}</span>
    </div>

    <div
      v-if="bench"
      class="flex flex-wrap gap-x-5 gap-y-1 border-b border-line bg-panel px-4 py-2 text-[11px]"
    >
      <span :class="bench.withinBudget ? 'text-ok' : 'text-warn'" class="font-semibold">
        p95 {{ bench.p95.toFixed(2) }}ms / {{ bench.budgetP95Ms.toFixed(1) }}ms budget —
        {{ bench.withinBudget ? 'WITHIN' : 'OVER' }}
      </span>
      <span class="text-muted">p50 {{ bench.p50.toFixed(2) }}ms</span>
      <span class="text-muted">p99 {{ bench.p99.toFixed(2) }}ms</span>
      <span class="text-muted">{{ bench.frames }} frames</span>
      <span :class="bench.dropped === 0 ? 'text-muted' : 'text-warn'">
        {{ bench.dropped }} dropped
      </span>
      <span class="text-muted">{{ bench.sustainedFps.toFixed(1) }} fps sustained</span>
      <span class="text-muted">{{ bench.measureTextCalls.toLocaleString() }} measureText</span>
    </div>

    <div class="flex min-h-0 flex-1">
      <SchemaTree
        class="w-72 shrink-0"
        data-sidebar-tree
        @open="onBrowseRelation"
        @open-top="onTopRows"
        @notice="notice = $event"
      />

      <main class="min-h-0 min-w-0 flex-1">
        <DataGridVue
          v-if="activeSource !== null"
          :key="gridKey"
          :source="activeSource"
          :frozen-column-count="frozen"
          :label="gridLabel"
          @ready="onReady"
          @selection="selection = $event"
        />
        <div
          v-else
          class="flex h-full items-center justify-center px-6 text-center text-xs text-muted"
        >
          This result is no longer available. Close the tab and re-run the query.
        </div>
      </main>

      <TableDetail
        class="w-[22rem] shrink-0 border-l border-line"
        data-sidebar-detail
        :detail="schema.detail"
        :loading="schema.detailLoading"
        :error="detailErrorText"
        @copy-ddl="onCopyDdl"
      />
    </div>

    <footer
      class="flex items-center gap-4 border-t border-line bg-panel px-4 py-1.5 text-[11px] text-muted"
    >
      <span>{{ selectionSummary }}</span>
      <span class="ml-auto">
        arrows / shift+arrows · cmd+arrows to data edge · Page Up/Down · Home/End · cmd+Home/End ·
        Tab · Esc · right-click for the menu · double-click a cell to inspect
      </span>
    </footer>

    <div hidden data-bench-json>{{ benchJson }}</div>
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
}
.btn:hover:not(:disabled) {
  background: rgba(59, 118, 240, 0.25);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
