<script setup lang="ts">
/**
 * The schema tree's context menu (PLAN Phase 6).
 *
 * Deliberately plain DOM rather than a canvas overlay: unlike the grid's menu it
 * sits over a list of text rows, so it needs no coordination with a paint loop,
 * and being in the DOM means it gets focus, hover and screen-reader semantics for
 * free.
 *
 * Items are supplied by the caller as `{ id, label }` — this component owns
 * placement and dismissal, never meaning.
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';

interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
}

const props = defineProps<{
  x: number;
  y: number;
  items: readonly MenuItem[];
}>();

const emit = defineEmits<{
  select: [id: string];
  close: [];
}>();

function choose(id: string): void {
  emit('select', id);
}

/** Enough room for the longest label plus the border, without measuring twice. */
const MENU_WIDTH = 240;
const MENU_ROW = 26;

const style = computed(() => {
  const height = props.items.length * MENU_ROW + 8;
  const maxX = typeof window === 'undefined' ? props.x : window.innerWidth - MENU_WIDTH - 4;
  const maxY = typeof window === 'undefined' ? props.y : window.innerHeight - height - 4;
  return {
    left: `${Math.max(4, Math.min(props.x, maxX))}px`,
    top: `${Math.max(4, Math.min(props.y, maxY))}px`,
    width: `${MENU_WIDTH}px`,
  };
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
  }
}

// Capture phase, so a click on a menu item is seen here before the tree's own
// click handler can move the selection out from under it.
function onDocumentPointerDown(): void {
  emit('close');
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <div class="menu" :style="style" role="menu" data-tree-menu @pointerdown.stop>
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      role="menuitem"
      class="item"
      :disabled="item.disabled === true"
      @pointerdown.stop
      @click.stop="choose(item.id)"
    >
      {{ item.label }}
    </button>
  </div>
</template>

<style scoped>
.menu {
  position: fixed;
  z-index: 50;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--color-line);
  border-radius: 5px;
  background: var(--color-panel);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.55);
}
.item {
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--color-fg);
  font: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item:hover:not(:disabled) {
  background: rgba(59, 118, 240, 0.28);
}
.item:disabled {
  color: var(--color-muted);
  opacity: 0.5;
  cursor: default;
}
</style>
