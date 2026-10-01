<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';
import DataGridVue from '@/components/DataGridVue.vue';
import TabBar from '@/components/TabBar.vue';
import { runScrollBench, type BenchResult } from '@/grid/bench';
import type { DataGrid } from '@/grid/create-data-grid';
import type { ClipboardFormat } from '@/grid/clipboard';
import { FakeDataSource } from '@/grid/fake-source';
import { boundingBox, selectedCellCount } from '@/grid/selection';
import type { SelectionState, SortSpec } from '@/grid/types';
import { useTabsStore } from '@/stores/tabs';

const ROW_COUNT = 1_000_000;
const COLUMN_COUNT = 30;

const source = new FakeDataSource({
  rowCount: ROW_COUNT,
  columnCount: COLUMN_COUNT,
  seed: 20260923,
});

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
const tabs = useTabsStore();

onMounted(() => {
  if (window.tabby) versions.value = { ...window.tabby.versions };

  // Seed the shell so the tab strip is demonstrable before Phase 4 wires real
  // result tabs to queries. One editor and one result, matching the two kinds.
  tabs.openQuery(null);
  tabs.openResult({
    resultId: 'synthetic',
    title: 'synthetic 1M rows',
    connectionId: null,
  });
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
  if (!grid.value || benching.value) return;
  benching.value = true;
  notice.value = null;
  try {
    bench.value = await runScrollBench(grid.value, {
      frames: 600,
      rowsPerFrame: 40,
      rowCount: ROW_COUNT,
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

async function onToggleSort(): Promise<void> {
  if (!grid.value) return;
  const next: SortSpec | null =
    sort.value === null
      ? { columnIndex: 1, direction: 'asc' }
      : sort.value.direction === 'asc'
        ? { columnIndex: 1, direction: 'desc' }
        : null;
  sort.value = next;
  await grid.value.setSort(next);
}

function onFreeze(delta: number): void {
  frozen.value = Math.max(0, Math.min(COLUMN_COUNT, frozen.value + delta));
}

function onGoToRow(): void {
  const raw = window.prompt(`Go to row (1 – ${ROW_COUNT.toLocaleString()})`);
  if (!raw) return;
  const row = Number.parseInt(raw, 10);
  if (!Number.isFinite(row)) return;
  grid.value?.scrollToRow(Math.max(0, Math.min(ROW_COUNT - 1, row - 1)), 'center');
}
</script>

<template>
  <div class="flex h-full flex-col bg-surface">
    <header class="flex items-baseline gap-3 border-b border-line bg-panel px-4 py-2">
      <h1 class="text-sm font-semibold tracking-wide text-fg">Tabby</h1>
      <span class="text-xs text-muted">Phase 1 — canvas data grid</span>
      <span class="ml-auto text-[11px] text-muted">
        {{ ROW_COUNT.toLocaleString() }} rows × {{ COLUMN_COUNT }} cols · synthetic
        <template v-if="versions">
          · Electron {{ versions.electron }} · Chromium {{ versions.chrome }}
        </template>
      </span>
    </header>

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
        Sort col 2: {{ sort ? sort.direction : 'off' }}
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

    <TabBar />

    <main class="min-h-0 flex-1">
      <DataGridVue
        :source="source"
        :frozen-column-count="frozen"
        label="Synthetic query result"
        @ready="onReady"
        @selection="selection = $event"
      />
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
