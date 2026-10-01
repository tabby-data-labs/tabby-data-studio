<script setup lang="ts">
/**
 * Tab strip for query editors and result sets.
 *
 * Thin by design: all the close/activate ordering rules live in the tested
 * store, and this component only renders them and forwards intent.
 */
import { useTabsStore } from '@/stores/tabs';

const tabs = useTabsStore();

function onAuxClick(id: string, event: MouseEvent): void {
  // Middle-click closes, as in every browser and editor.
  if (event.button === 1) {
    event.preventDefault();
    tabs.close(id);
  }
}
</script>

<template>
  <div class="flex items-stretch gap-1 overflow-x-auto border-b border-line bg-surface px-2 pt-1.5">
    <button
      v-for="tab in tabs.all"
      :key="tab.id"
      type="button"
      class="tab group"
      :class="tab.id === tabs.activeId ? 'tab-active' : 'tab-idle'"
      :aria-selected="tab.id === tabs.activeId"
      role="tab"
      @click="tabs.select(tab.id)"
      @auxclick="onAuxClick(tab.id, $event)"
    >
      <span class="shrink-0 text-[10px]" :class="tab.kind === 'result' ? 'text-ok' : 'text-muted'">
        {{ tab.kind === 'result' ? '▦' : '✎' }}
      </span>
      <span class="max-w-[180px] truncate">{{ tab.title }}</span>
      <span
        class="close shrink-0"
        role="button"
        tabindex="0"
        aria-label="Close tab"
        @click.stop="tabs.close(tab.id)"
        @keydown.enter.stop.prevent="tabs.close(tab.id)"
      >
        ✕
      </span>
    </button>

    <button type="button" class="new-tab shrink-0" @click="tabs.openQuery(null)">+ Query</button>

    <span v-if="tabs.count === 0" class="self-center pl-2 text-[11px] text-muted">No tabs</span>
  </div>
</template>

<style scoped>
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--color-line);
  border-bottom: none;
  border-radius: 5px 5px 0 0;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.tab-active {
  background: var(--color-panel);
  color: var(--color-fg);
}
.tab-idle {
  background: transparent;
  color: var(--color-muted);
}
.tab-idle:hover {
  background: rgba(28, 58, 94, 0.35);
}
.close {
  opacity: 0;
  padding: 0 2px;
  border-radius: 3px;
  font-size: 9px;
  line-height: 1.4;
}
.tab:hover .close,
.close:focus-visible {
  opacity: 1;
}
.close:hover {
  background: rgba(59, 118, 240, 0.35);
}
.new-tab {
  align-self: center;
  padding: 3px 8px;
  border: 1px dashed var(--color-line);
  border-radius: 4px;
  font-size: 11px;
  color: var(--color-muted);
  background: transparent;
  cursor: pointer;
}
.new-tab:hover {
  color: var(--color-fg);
  border-color: var(--color-accent);
}
</style>
