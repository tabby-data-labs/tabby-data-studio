<script setup lang="ts">
/**
 * Thin Vue adapter over the framework-free grid (GRID-SPEC §12).
 *
 * ~60 lines on purpose. No Vue reactivity reaches the grid: it is driven
 * through method calls, because 30k reactive cells would blow the frame budget.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { createDataGrid, type DataGrid } from '@/grid/create-data-grid';
import type { DataSource, GridTheme, SelectionState } from '@/grid/types';

const props = defineProps<{
  source: DataSource;
  theme?: Partial<GridTheme>;
  frozenColumnCount?: number;
  label?: string;
}>();

const emit = defineEmits<{
  ready: [grid: DataGrid];
  selection: [selection: SelectionState];
}>();

const host = ref<HTMLElement | null>(null);
const grid = shallowRef<DataGrid | null>(null);

onMounted(() => {
  if (!host.value) return;
  const instance = createDataGrid({
    host: host.value,
    source: props.source,
    theme: props.theme,
    frozenColumnCount: props.frozenColumnCount,
    a11y: { label: props.label ?? 'Query result' },
    onSelectionChange: (selection) => emit('selection', selection),
  });
  grid.value = instance;
  emit('ready', instance);
});

watch(
  () => props.theme,
  (next) => {
    if (next) grid.value?.updateTheme(next);
  },
  { deep: true },
);

watch(
  () => props.frozenColumnCount,
  (next) => {
    if (next !== undefined) grid.value?.setFrozenColumnCount(next);
  },
);

onBeforeUnmount(() => {
  grid.value?.destroy();
  grid.value = null;
});

defineExpose({ grid });
</script>

<template>
  <div ref="host" class="h-full w-full overflow-hidden" />
</template>
