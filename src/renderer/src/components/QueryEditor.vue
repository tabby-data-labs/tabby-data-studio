<script setup lang="ts">
/**
 * The query editor (PLAN Phase 7).
 *
 * A transparent-text `<textarea>` stacked on a `<pre>` of highlighted HTML, with a
 * gutter of line numbers behind both. This is the standard trick and it has exactly
 * one hard requirement: **the two layers must be laid out identically**, character
 * for character. Font, size, line-height, padding, border, letter-spacing, tab-size
 * and wrapping are therefore declared once in a shared class and never overridden —
 * if they diverge by a pixel the caret visibly separates from the text.
 *
 * `highlight.ts` guarantees the rendered text equals the source text; this component
 * guarantees the geometry matches. Scroll sync is a direct DOM write rather than a
 * reactive value, because binding `scrollTop` through Vue would re-render the whole
 * highlight layer on every scroll frame.
 *
 * Tab is deliberately **not** intercepted. Inserting spaces on Tab is what a code
 * editor does, but it also traps keyboard focus in the pane with no way out, which
 * is an accessibility failure rather than a nicety. Native focus movement wins.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { splitScript, statementsToRun, type SqlStatement } from '@shared/sql-split';
import { highlightToHtml, lineOf, lineOffsets, trailingLineGuard } from '@/sql/highlight';

const props = defineProps<{
  connectionId: string | null;
  busy: boolean;
  /** Non-null while a statement is on the server; drives the Cancel button. */
  runningLabel: string | null;
}>();

const emit = defineEmits<{
  run: [statements: readonly SqlStatement[]];
  explain: [statement: SqlStatement];
  cancel: [];
  history: [];
}>();

/** Pixels, and the single source of truth for the gutter, the rule and the sync. */
const LINE_HEIGHT = 18;

const input = ref<HTMLTextAreaElement | null>(null);
const highlight = ref<HTMLPreElement | null>(null);
const gutter = ref<HTMLDivElement | null>(null);
const currentLine = ref<HTMLDivElement | null>(null);

const sql = ref('');
const caret = ref(0);
const hint = ref<string | null>(null);

const html = computed(() => highlightToHtml(sql.value) + trailingLineGuard(sql.value));
const offsets = computed(() => lineOffsets(sql.value));
const lineCount = computed(() => offsets.value.length);
const activeLine = computed(() => lineOf(sql.value, caret.value));

/**
 * The whole gutter as one text block.
 *
 * Ten thousand `<div>`s would be ten thousand elements for a pasted migration
 * script; one text node costs the same to paint and nothing to diff.
 */
const gutterText = computed(() => {
  let text = '';
  for (let line = 1; line <= lineCount.value; line += 1) {
    text += line === 1 ? String(line) : `\n${line}`;
  }
  return text;
});

const split = computed(() => splitScript(sql.value));
const statementCount = computed(() => split.value.statements.length);

const canRun = computed(() => props.connectionId !== null && !props.busy);

function readCaret(): void {
  const el = input.value;
  caret.value = el === null ? 0 : (el.selectionStart ?? 0);
}

function selection(): { start: number; end: number } | null {
  const el = input.value;
  if (el === null) return null;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  return { start, end };
}

/**
 * Keeps the highlight layer and the gutter pinned to the textarea.
 *
 * A direct DOM write, not a reactive value: this runs on every scroll frame, and
 * routing it through Vue would re-evaluate `html` — the whole document — each time.
 */
function syncScroll(): void {
  const el = input.value;
  if (!el) return;
  if (highlight.value) {
    highlight.value.scrollTop = el.scrollTop;
    highlight.value.scrollLeft = el.scrollLeft;
  }
  if (gutter.value) gutter.value.scrollTop = el.scrollTop;
  if (currentLine.value) {
    currentLine.value.style.transform = `translateY(${activeLine.value * LINE_HEIGHT}px)`;
  }
}

function onInput(): void {
  readCaret();
  syncScroll();
}

function onClick(): void {
  readCaret();
  syncScroll();
}

function titleFor(statement: SqlStatement): string {
  const firstLine = statement.text.split('\n', 1)[0] ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}…` : collapsed;
}

/** Runs the selection, or the statement at the caret when nothing is selected. */
function runHere(): void {
  if (!canRun.value) return;
  const statements = statementsToRun(sql.value, selection());
  if (statements.length === 0) {
    hint.value = 'nothing to run at the cursor';
    return;
  }
  hint.value = null;
  emit('run', statements);
}

/** Runs the whole script, split by the lexer rather than by `;`. */
function runAll(): void {
  if (!canRun.value) return;
  const statements = split.value.statements;
  if (statements.length === 0) {
    hint.value = 'the script is empty';
    return;
  }
  hint.value = null;
  emit('run', statements);
}

/** Explains the statement at the caret, which is the one the user is looking at. */
function explainHere(): void {
  if (!canRun.value) return;
  const [statement] = statementsToRun(sql.value, selection());
  if (!statement) {
    hint.value = 'nothing to explain at the cursor';
    return;
  }
  hint.value = null;
  emit('explain', statement);
}

function onKeydown(event: KeyboardEvent): void {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.key !== 'Enter') return;
  event.preventDefault();
  if (event.shiftKey) runAll();
  else runHere();
}

/** Replaces the editor contents, used by the history list and "Filter to…". */
function setText(text: string): void {
  sql.value = text;
  void nextTick(() => {
    input.value?.focus();
    readCaret();
    syncScroll();
  });
}

watch(
  () => props.connectionId,
  (id) => {
    if (id === null) hint.value = null;
  },
);

onMounted(() => {
  readCaret();
  syncScroll();
});

defineExpose({ setText, titleFor, runHere, runAll, explainHere });
</script>

<template>
  <div class="editor" data-query-editor>
    <div class="bar">
      <button type="button" class="btn" :disabled="!canRun" data-run @click="runHere">
        {{ busy ? 'Running…' : 'Run' }}
      </button>
      <button type="button" class="btn" :disabled="!canRun" data-run-all @click="runAll">
        Run all
      </button>
      <button type="button" class="btn" :disabled="!canRun" data-explain @click="explainHere">
        Explain
      </button>
      <button
        type="button"
        class="btn danger"
        :disabled="runningLabel === null"
        data-cancel
        @click="emit('cancel')"
      >
        Cancel{{ runningLabel === null ? '' : ` ${runningLabel}` }}
      </button>
      <button type="button" class="btn" data-history-toggle @click="emit('history')">
        History
      </button>

      <span class="meta" :data-statement-count="statementCount">
        {{ statementCount }} statement{{ statementCount === 1 ? '' : 's' }} · line
        {{ activeLine + 1 }}
      </span>
      <span v-if="split.error !== null" class="warn" data-lex-error>
        {{ split.error.message }}
      </span>
      <span v-else-if="hint" class="warn">{{ hint }}</span>
      <span v-else-if="connectionId === null" class="warn">open a connection first</span>
      <span v-else class="keys">⌘/Ctrl+↵ run at cursor · ⇧⌘/Ctrl+↵ run all</span>
    </div>

    <div class="body">
      <div ref="gutter" class="gutter" aria-hidden="true">
        <pre class="gutter-text code">{{ gutterText }}</pre>
      </div>

      <div class="pane">
        <div
          ref="currentLine"
          class="current-line"
          :style="{ height: `${LINE_HEIGHT}px` }"
          aria-hidden="true"
        ></div>
        <!--
          `v-html` is the mechanism here, not an oversight, and the rule is turned
          off for this one file in eslint.config.mjs rather than suppressed inline —
          an inline directive reports at the attribute, so it cannot survive
          Prettier splitting the tag across lines. Its only source is
          `highlightToHtml`, which escapes `&`, `<` and `>` in every token kind and
          is asserted to reproduce its input character for character, including an
          injected `<img onerror>`, in tests/unit/sql-highlight.spec.ts. Building the
          spans with createElement instead would mean diffing thousands of vdom nodes
          per keystroke to produce the same bytes.
        -->
        <pre
          ref="highlight"
          class="highlight code"
          aria-hidden="true"
          data-highlight
          v-html="html"
        ></pre>
        <textarea
          ref="input"
          v-model="sql"
          class="input code"
          data-sql-input
          wrap="off"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          aria-label="SQL editor"
          placeholder="select * from fixtures.big order by id limit 100"
          @input="onInput"
          @click="onClick"
          @keyup="onClick"
          @scroll="syncScroll"
          @keydown="onKeydown"
        ></textarea>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--color-line);
  background: var(--color-panel);
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 11px;
}
.btn {
  padding: 3px 9px;
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
.btn.danger:not(:disabled) {
  border-color: var(--color-warn);
  color: var(--color-warn);
}
.meta,
.keys {
  color: var(--color-muted);
  font-size: 10px;
}
.keys {
  margin-left: auto;
}
.warn {
  color: var(--color-warn);
  font-size: 10px;
}

.body {
  display: flex;
  height: 132px;
  min-height: 0;
}
.gutter {
  flex-shrink: 0;
  width: 3.2em;
  overflow: hidden;
  padding: 5px 0;
  border-right: 1px solid var(--color-line);
  background: var(--color-surface);
  text-align: right;
}
.gutter-text {
  margin: 0;
  color: var(--color-muted);
}
.pane {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/*
 * The three stacked layers must be laid out identically or the caret separates
 * from the text. Everything that affects metrics lives in `.code` and nowhere else.
 */
.code {
  margin: 0;
  padding: 5px 8px;
  border: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 18px;
  letter-spacing: 0;
  tab-size: 2;
  white-space: pre;
  word-break: normal;
  overflow-wrap: normal;
}
.current-line {
  position: absolute;
  top: 5px; /* the shared padding, so the rule sits on the text's first line */
  left: 0;
  right: 0;
  background: rgba(59, 118, 240, 0.09);
  pointer-events: none;
}
.highlight {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color: var(--color-fg);
  pointer-events: none;
}
.input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: auto;
  resize: none;
  background: transparent;
  /* Transparent text over the highlighted copy; the caret stays visible. */
  color: transparent;
  caret-color: var(--color-fg);
  outline: none;
}
.input::placeholder {
  color: var(--color-muted);
  opacity: 0.55;
}
.input::selection {
  background: rgba(59, 118, 240, 0.35);
  color: transparent;
}
</style>
