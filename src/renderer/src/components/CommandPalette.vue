<script setup lang="ts">
/**
 * The command palette (PLAN Phase 8).
 *
 * Ranking is `fuzzyRank` over the command titles, so an empty query lists every
 * command in registration order and a typed one reorders by match quality. The
 * matcher is a DP over the label, not a regex built from the query, which matters
 * because the query is untrusted keystroke-by-keystroke input.
 *
 * Matched characters are rendered as segments rather than by injecting HTML: the
 * indexes can land on the high surrogate of an astral character, and a `v-html`
 * highlight would need its own escaping pass to be safe.
 *
 * Keyboard handling stops propagation on the keys it consumes. The grid also binds
 * arrows and Home/End, and a palette that let those through would scroll the result
 * underneath itself while the user was choosing a command.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fuzzyRank } from '@/palette/fuzzy';
import { highlightSegments } from '@/palette/segments';
import type { PaletteCommand } from '@/palette/command';
import { t } from '@/i18n';

const props = defineProps<{
  commands: readonly PaletteCommand[];
}>();

const emit = defineEmits<{ close: [] }>();

const query = ref('');
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLUListElement | null>(null);

const ranked = computed(() => fuzzyRank(query.value, props.commands, (command) => command.title));

/** Row view models, so the template does no work per keystroke beyond rendering. */
const rows = computed(() =>
  ranked.value.map((entry, index) => ({
    index,
    command: entry.item,
    segments: highlightSegments(entry.item.title, entry.match.matchedIndexes),
    /** Shown only on the first row of a run, which is what makes it a heading. */
    showGroup:
      entry.item.group !== undefined &&
      (index === 0 || ranked.value[index - 1]?.item.group !== entry.item.group),
  })),
);

function move(delta: number): void {
  const count = rows.value.length;
  if (count === 0) return;
  active.value = (active.value + delta + count) % count;
}

function runAt(index: number): void {
  const row = rows.value[index];
  if (!row) return;
  // Closed before running, so a command that opens another overlay — the export
  // dialog, history — is not immediately covered by this one.
  emit('close');
  row.command.run();
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      event.stopPropagation();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      event.stopPropagation();
      move(-1);
      break;
    case 'Home':
      event.preventDefault();
      event.stopPropagation();
      active.value = 0;
      break;
    case 'End':
      event.preventDefault();
      event.stopPropagation();
      active.value = Math.max(0, rows.value.length - 1);
      break;
    case 'Enter':
      event.preventDefault();
      event.stopPropagation();
      runAt(active.value);
      break;
    case 'Escape':
      event.preventDefault();
      event.stopPropagation();
      emit('close');
      break;
    default:
      break;
  }
}

/** The query changes the list length, so the selection has to stay inside it. */
watch(query, () => {
  active.value = 0;
});

watch(active, () => {
  void nextTick(() => {
    const element = list.value?.querySelector('[data-active="true"]');
    element?.scrollIntoView({ block: 'nearest' });
  });
});

onMounted(() => {
  input.value?.focus();
  // A palette mounted over a grid that also wants key events: the document
  // listener is what makes Escape work when focus has moved to a row.
  document.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <div class="palette" role="dialog" :aria-label="t('palette.label')" data-command-palette>
    <input
      ref="input"
      v-model="query"
      class="query"
      type="text"
      role="combobox"
      aria-autocomplete="list"
      aria-controls="palette-list"
      :aria-activedescendant="rows.length === 0 ? undefined : `palette-row-${active}`"
      :aria-expanded="rows.length > 0"
      :aria-label="t('palette.label')"
      :placeholder="t('palette.placeholder')"
      data-palette-input
      spellcheck="false"
      autocomplete="off"
      @keydown="onKeydown"
    />

    <p v-if="rows.length === 0 && query.trim() !== ''" class="empty" data-palette-empty>
      {{ t('palette.empty', { query }) }}
    </p>

    <ul v-else id="palette-list" ref="list" class="list" role="listbox" data-palette-list>
      <li
        v-for="row in rows"
        :id="`palette-row-${row.index}`"
        :key="row.command.id"
        role="option"
        :aria-selected="row.index === active"
        :data-active="row.index === active"
        :data-palette-row="row.command.id"
        class="row"
        @mouseenter="active = row.index"
        @click="runAt(row.index)"
      >
        <span v-if="row.showGroup" class="group">{{ row.command.group }}</span>
        <span class="title">
          <template v-for="(segment, segmentIndex) in row.segments" :key="segmentIndex">
            <mark v-if="segment.matched" class="hit">{{ segment.text }}</mark>
            <template v-else>{{ segment.text }}</template>
          </template>
        </span>
        <span v-if="row.command.hint" class="hint">{{ row.command.hint }}</span>
      </li>
    </ul>

    <footer class="foot">{{ t('palette.hint') }}</footer>
  </div>
</template>

<style scoped>
.palette {
  display: flex;
  flex-direction: column;
  max-height: 100%;
  border: 1px solid var(--color-line);
  border-radius: 6px;
  background: var(--color-panel);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
  font-size: 11px;
  overflow: hidden;
}
.query {
  padding: 8px 10px;
  border: 0;
  border-bottom: 1px solid var(--color-line);
  background: var(--color-surface);
  color: var(--color-fg);
  font: inherit;
  font-size: 12px;
}
.query:focus {
  outline: none;
  box-shadow: inset 0 -2px 0 var(--color-accent);
}

.empty {
  margin: 0;
  padding: 14px 10px;
  color: var(--color-muted);
  text-align: center;
}

.list {
  margin: 0;
  padding: 2px 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}
.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 10px;
  cursor: pointer;
}
.row[data-active='true'] {
  background: rgba(59, 118, 240, 0.22);
}
.group {
  color: var(--color-muted);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  min-width: 5.5rem;
}
.title {
  color: var(--color-fg);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit {
  background: transparent;
  color: var(--color-accent);
  font-weight: 700;
}
.hint {
  color: var(--color-muted);
  font-size: 9px;
  white-space: nowrap;
}

.foot {
  padding: 4px 10px;
  border-top: 1px solid var(--color-line);
  color: var(--color-muted);
  font-size: 9px;
}
</style>
