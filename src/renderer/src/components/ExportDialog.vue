<script setup lang="ts">
/**
 * The export dialog (PLAN Phase 8).
 *
 * Collects the format and its options and hands them to main. It never asks for a
 * path: main opens the OS save dialog itself, so the only way bytes reach the disk
 * is through a destination the user just confirmed. That is why there is no "browse"
 * field here even though the catalogue has a label for one — a renderer-supplied
 * path would be a write-anywhere primitive.
 *
 * Strings come from the i18n catalogue rather than being inline, which is what makes
 * the Phase 8 i18n hook load-bearing instead of decorative.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  EXPORT_ENCODINGS,
  EXPORT_FORMATS,
  EXPORT_LINE_ENDINGS,
  defaultExportOptions,
  formatLabel,
  type ExportFormat,
  type ExportOptions,
} from '@shared/export';
import { t } from '@/i18n';
import { useExportsStore } from '@/stores/exports';

const props = defineProps<{
  /** The live result to export. Null disables the dialog's only action. */
  resultId: string | null;
  /** Quoted INSERT target main derived, or null when the result is not a table. */
  insertTarget: string | null;
}>();

const emit = defineEmits<{
  close: [];
  notice: [text: string];
}>();

const store = useExportsStore();

const format = ref<ExportFormat>('csv');
const options = ref<ExportOptions>(defaultExportOptions('csv'));
const problem = ref<string | null>(null);
const starting = ref(false);

/** Switching format resets to that format's defaults, keeping the dialog honest. */
function chooseFormat(next: ExportFormat): void {
  format.value = next;
  options.value = defaultExportOptions(next);
  problem.value = null;
}

function patch(changes: Partial<ExportOptions>): void {
  options.value = { ...options.value, ...changes };
  problem.value = null;
}

const delimited = computed(() => format.value === 'csv' || format.value === 'tsv');
const isSql = computed(() => format.value === 'sql');

/**
 * The same bounds main's validator enforces, checked before the round trip.
 *
 * A delimiter or NULL text that breaks the record structure produces no error
 * anywhere — only a file that reads back as something else — so refusing it in the
 * UI is not duplicating main, it is the only place the user can be told.
 *
 * Each message is one catalogue entry. Building them by concatenating a label onto
 * a reason would put English word order in the code, which is the thing the i18n
 * hook exists to keep out.
 */
function validate(current: ExportOptions): string | null {
  if (current.delimiter.length !== 1) return t('export.delimiterOneChar');
  if (['\r', '\n', '"', '\u0000'].includes(current.delimiter)) {
    return t('export.delimiterForbidden');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(current.nullText)) return t('export.nullTextControl');
  if (current.nullText.length > 32) return t('export.nullTextLong');
  if (!Number.isInteger(current.rowsPerInsert) || current.rowsPerInsert < 1) {
    return t('export.batchAtLeastOne');
  }
  return null;
}

async function onStart(): Promise<void> {
  if (props.resultId === null || starting.value) return;
  const invalid = validate(options.value);
  if (invalid !== null) {
    problem.value = invalid;
    return;
  }

  starting.value = true;
  try {
    const result = await store.start(props.resultId, options.value);
    if (!result.ok) {
      problem.value = `${result.error.code}: ${result.error.message}`;
      return;
    }
    if (result.value === null) {
      // The save dialog was dismissed. Nothing to report and nothing to close over.
      emit('notice', '');
      return;
    }
    emit('notice', t('export.started', { file: result.value.fileName }));
    emit('close');
  } finally {
    starting.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

/** The default INSERT target, shown when the result is not a table scan. */
const PLACEHOLDER_TARGET = '"public"."exported"';

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="dialog" role="dialog" :aria-label="t('export.title')" data-export-dialog>
    <header class="head">
      <h2 class="title">{{ t('export.title') }}</h2>
      <button
        type="button"
        class="btn"
        data-export-close
        :aria-label="t('common.close')"
        @click="emit('close')"
      >
        ✕
      </button>
    </header>

    <div class="body">
      <fieldset class="field">
        <legend>{{ t('export.format') }}</legend>
        <div class="formats">
          <label v-for="candidate in EXPORT_FORMATS" :key="candidate" class="choice">
            <input
              type="radio"
              name="export-format"
              data-export-format
              :value="candidate"
              :checked="format === candidate"
              @change="chooseFormat(candidate)"
            />
            <span class="name">{{ candidate.toUpperCase() }}</span>
            <span class="hint">{{ formatLabel(candidate) }}</span>
          </label>
        </div>
      </fieldset>

      <div class="grid">
        <label v-if="format === 'csv'" class="field">
          <span>{{ t('export.delimiter') }}</span>
          <input
            class="text narrow"
            type="text"
            data-export-delimiter
            maxlength="1"
            :value="options.delimiter"
            :aria-label="t('export.delimiter')"
            @input="patch({ delimiter: ($event.target as HTMLInputElement).value })"
          />
        </label>

        <label v-if="delimited" class="field">
          <span>{{ t('export.nullText') }}</span>
          <input
            class="text"
            type="text"
            data-export-null-text
            maxlength="32"
            :value="options.nullText"
            placeholder="(empty)"
            :aria-label="t('export.nullText')"
            @input="patch({ nullText: ($event.target as HTMLInputElement).value })"
          />
        </label>

        <label class="field">
          <span>{{ t('export.encoding') }}</span>
          <select
            class="text"
            data-export-encoding
            :value="options.encoding"
            :aria-label="t('export.encoding')"
            @change="patch({ encoding: ($event.target as HTMLSelectElement).value as never })"
          >
            <option v-for="encoding in EXPORT_ENCODINGS" :key="encoding" :value="encoding">
              {{ encoding }}
            </option>
          </select>
        </label>

        <label class="field">
          <span>{{ t('export.lineEnding') }}</span>
          <select
            class="text"
            data-export-line-ending
            :value="options.lineEnding"
            :aria-label="t('export.lineEnding')"
            @change="patch({ lineEnding: ($event.target as HTMLSelectElement).value as never })"
          >
            <option v-for="ending in EXPORT_LINE_ENDINGS" :key="ending" :value="ending">
              {{ ending === 'crlf' ? 'CRLF (Windows, RFC 4180)' : 'LF (Unix)' }}
            </option>
          </select>
        </label>

        <label v-if="isSql" class="field">
          <span>{{ t('export.rowsPerInsert') }}</span>
          <input
            class="text narrow"
            type="number"
            min="1"
            max="10000"
            data-export-batch
            :value="options.rowsPerInsert"
            :aria-label="t('export.rowsPerInsert')"
            @input="patch({ rowsPerInsert: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
      </div>

      <div class="toggles">
        <label v-if="delimited" class="check">
          <input
            type="checkbox"
            data-export-header
            :checked="options.includeHeader"
            @change="patch({ includeHeader: ($event.target as HTMLInputElement).checked })"
          />
          {{ t('export.includeHeader') }}
        </label>

        <label v-if="!isSql" class="check">
          <input
            type="checkbox"
            data-export-bom
            :checked="options.writeBom"
            @change="patch({ writeBom: ($event.target as HTMLInputElement).checked })"
          />
          {{ t('export.bom') }}
        </label>
      </div>

      <p v-if="isSql" class="note" data-export-target>
        <template v-if="insertTarget">
          {{ t('export.targetIs', { target: insertTarget }) }}
        </template>
        <template v-else>
          {{ t('export.targetDefault', { target: PLACEHOLDER_TARGET }) }}
        </template>
      </p>

      <p v-if="options.encoding === 'latin1'" class="warn" data-export-latin1-warning>
        {{ t('export.latin1Warning') }}
      </p>
      <p
        v-if="delimited && options.nullText === ''"
        class="warn"
        data-export-null-collision-warning
      >
        {{ t('export.nullCollision') }}
      </p>

      <p v-if="problem" class="warn" data-export-problem>{{ problem }}</p>
      <p v-if="store.error" class="warn" data-export-error>
        {{ store.error.code }}: {{ store.error.message }}
      </p>
    </div>

    <footer class="foot">
      <span class="note">{{ t('export.streaming') }}</span>
      <button type="button" class="btn" data-export-dismiss @click="emit('close')">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="btn primary"
        data-export-start
        :disabled="resultId === null || starting"
        @click="onStart"
      >
        {{ starting ? '…' : t('export.start') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
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
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-line);
}
.title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-fg);
}
.head .btn {
  margin-left: auto;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  overflow-y: auto;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--color-muted);
}
.field > span,
legend {
  color: var(--color-muted);
  font-size: 10px;
  padding: 0;
}
.formats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.choice {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 3px 7px;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  cursor: pointer;
}
.choice:has(input:checked) {
  border-color: var(--color-accent);
  background: rgba(59, 118, 240, 0.16);
}
.choice .name {
  color: var(--color-fg);
  font-weight: 600;
}
.choice .hint {
  color: var(--color-muted);
  font-size: 9px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 8px;
}
.text {
  padding: 3px 6px;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  background: var(--color-surface);
  color: var(--color-fg);
  font: inherit;
}
.text:focus {
  outline: 1px solid var(--color-accent);
}
.text.narrow {
  width: 5rem;
}

.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.check {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--color-fg);
  cursor: pointer;
}

.note,
.warn {
  margin: 0;
  font-size: 10px;
  line-height: 1.4;
}
.note {
  color: var(--color-muted);
}
.warn {
  color: var(--color-warn);
}
code {
  font-family: var(--font-mono);
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--color-line);
}
.foot .note {
  margin-right: auto;
  max-width: 22rem;
}

.btn {
  padding: 3px 10px;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  background: rgba(28, 58, 94, 0.25);
  color: var(--color-fg);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  background: rgba(59, 118, 240, 0.25);
}
.btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.btn.primary:not(:disabled) {
  border-color: var(--color-accent);
  background: rgba(59, 118, 240, 0.35);
}
</style>
