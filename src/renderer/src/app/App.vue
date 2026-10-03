<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import ConnectionBar from '@/components/ConnectionBar.vue';
import DataGridVue from '@/components/DataGridVue.vue';
import QueryBar from '@/components/QueryBar.vue';
import ResultStatus from '@/components/ResultStatus.vue';
import TabBar from '@/components/TabBar.vue';
import { runScrollBench, type BenchResult } from '@/grid/bench';
import type { DataGrid } from '@/grid/create-data-grid';
import type { ClipboardFormat } from '@/grid/clipboard';
import { FakeDataSource } from '@/grid/fake-source';
import { boundingBox, selectedCellCount } from '@/grid/selection';
import type { DataSource, SelectionState, SortSpec } from '@/grid/types';
import { useConnectionsStore } from '@/stores/connections';
import { useResultsStore, type RunInput } from '@/stores/results';
import { useTabsStore } from '@/stores/tabs';

const SYNTHETIC_ROWS = 1_000_000;
const SYNTHETIC_COLUMNS = 30;
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
  await connections.load();
});

onBeforeUnmount(() => {
  results.unsubscribe();
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

function onCloseResult(resultId: string): void {
  const tab = tabs.byResultId(resultId);
  if (tab) tabs.close(tab.id);
}

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
        Phase 5 — {{ liveResultId === null ? 'synthetic grid' : 'live result' }}
      </span>
      <span class="ml-auto text-[11px] text-muted">
        {{ headerSummary }}
        <template v-if="versions">
          · Electron {{ versions.electron }} · Chromium {{ versions.chrome }}
        </template>
      </span>
    </header>

    <ConnectionBar />
    <QueryBar :connection-id="connections.activeId" :busy="results.running" @run="onRun" />

    <div
      v-if="results.runError"
      class="flex items-center gap-3 border-b border-line bg-panel px-4 py-1.5 text-[11px] text-warn"
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

    <main class="min-h-0 flex-1">
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
