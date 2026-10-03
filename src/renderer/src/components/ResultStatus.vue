<script setup lang="ts">
/**
 * The status line under a live result: how many rows, how long it took, and —
 * when something has gone wrong — what the user can do about it.
 *
 * Three distinct conditions get three distinct treatments, because collapsing
 * them is how a viewer ends up showing a spinner forever:
 *
 *  - **terminal** — the result is gone (evicted, cancelled, connection lost, or
 *    the server closed the cursor). No retry can fix it; the only action is to
 *    re-run, so the button says that and the grid stops asking.
 *  - **failed ranges** — some blocks could not be fetched but the result is still
 *    alive. `RemoteDataSource` has them in backoff, so an explicit Retry is what
 *    clears it; the grid will not re-ask on its own until the backoff expires.
 *  - **loading** — placeholders on the canvas, which the grid already draws.
 */
import { computed } from 'vue';
import { useResultsStore } from '@/stores/results';

const props = defineProps<{ resultId: string | null }>();

const emit = defineEmits<{ close: [resultId: string] }>();

const results = useResultsStore();

const state = computed(() => (props.resultId === null ? null : results.stateOf(props.resultId)));

const rowCountText = computed(() => {
  const current = state.value;
  if (!current) return '';
  const { rowCount, rowCountIsEstimate } = current.meta;
  if (rowCount < 0) return 'row count unknown';
  return `${rowCountIsEstimate ? '~' : ''}${rowCount.toLocaleString()} rows`;
});

const terminal = computed(() => state.value?.source.terminal ?? null);
const terminalMessage = computed(() => {
  if (props.resultId === null || terminal.value === null) return null;
  return results.sourceOf(props.resultId)?.terminalMessage ?? null;
});
const failedRanges = computed(() => state.value?.source.failedRanges ?? 0);
const lastError = computed(() => state.value?.source.lastError ?? null);
</script>

<template>
  <div
    v-if="state"
    class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel px-4 py-1.5 text-[11px]"
  >
    <span class="font-semibold text-fg">{{ rowCountText }}</span>
    <span class="text-muted">{{ state.meta.columns.length }} columns</span>
    <span class="text-muted">{{ state.meta.elapsedMs }}ms to first rows</span>

    <template v-if="terminal !== null">
      <span class="text-warn">{{ terminalMessage }}</span>
      <button v-if="resultId !== null" type="button" class="btn" @click="emit('close', resultId)">
        Close result
      </button>
    </template>

    <template v-else-if="failedRanges > 0">
      <span class="text-warn">
        {{ failedRanges }} range{{ failedRanges === 1 ? '' : 's' }} failed to load
        <template v-if="lastError"> — {{ lastError.code }}: {{ lastError.message }}</template>
      </span>
      <button v-if="resultId !== null" type="button" class="btn" @click="results.retry(resultId)">
        Retry
      </button>
    </template>

    <span v-if="results.sortError" class="text-warn">
      sort failed: {{ results.sortError.message }}
    </span>
  </div>
</template>

<style scoped>
.btn {
  border: 1px solid var(--color-line);
  border-radius: 4px;
  padding: 2px 7px;
  color: var(--color-fg);
  background: rgba(28, 58, 94, 0.25);
  cursor: pointer;
}
.btn:hover {
  background: rgba(59, 118, 240, 0.25);
}
</style>
