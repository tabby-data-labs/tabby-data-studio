/**
 * The English message catalogue (PLAN Phase 8).
 *
 * `as const` is load-bearing: it is what narrows `MessageKey` to a union of
 * string literals, so `t()` rejects an unknown key at compile time and there is
 * no runtime path that can hand it one.
 *
 * Keys are addressed by string, never built by concatenation — a template-built
 * key escapes both the compiler and `scripts/check-i18n.mjs`. Pluralised
 * messages come as a `<base>.one` / `<base>.other` pair and are selected by
 * `tPlural()`.
 */
export const en = {
  'app.name': 'Tabby',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.clear': 'Clear all',
  'theme.label': 'Theme',
  'theme.dark': 'Dark',
  'theme.light': 'Light',
  'history.title': 'Query history',
  'history.empty': 'Nothing has been run yet. Statements you run from the editor are listed here.',
  'history.filterPlaceholder': 'Filter by statement or connection…',
  'history.privacy':
    'Stored only on this machine, never synced. Statements may contain literals that are secrets.',
  'history.shown': '{count} shown',
  'history.cleared.one': 'Cleared {count} history entry',
  'history.cleared.other': 'Cleared {count} history entries',
  'history.truncated': 'That entry was too long to store in full — it is shown, not runnable',
  'history.loadNotice': 'Statement loaded from history — press Run to execute it',
  'palette.placeholder': 'Type a command…',
  'palette.empty': 'No command matches “{query}”',
  'palette.hint': '↑↓ to move · ↵ to run · esc to close',
  'palette.label': 'Command palette',
  'export.title': 'Export result',
  'export.format': 'Format',
  'export.start': 'Export',
  'export.includeHeader': 'Include header row',
  'export.delimiter': 'Delimiter',
  'export.nullText': 'NULL text',
  'export.encoding': 'Encoding',
  'export.lineEnding': 'Line ending',
  'export.rowsPerInsert': 'Rows per INSERT',
  'export.bom': 'Byte-order mark',
  'export.streaming': 'Rows stream from main straight to disk; none pass through this window.',
  'export.started': 'Exporting {file}',
  'export.targetIs': 'INSERT target: {target}',
  'export.targetDefault':
    'This result is not a table scan, so the statements will target {target}. Rename it before running the file.',
  'export.latin1Warning':
    'latin1 cannot represent characters above U+00FF; they will be written as ?.',
  'export.nullCollision':
    'With an empty NULL text, a NULL and an empty string produce identical bytes. That is a limit of delimited formats, not of this export.',
  'export.delimiterOneChar': 'Delimiter must be exactly one character',
  'export.delimiterForbidden': 'Delimiter cannot be a line break, a quote or a NUL byte',
  'export.nullTextControl': 'NULL text cannot contain control characters',
  'export.nullTextLong': 'NULL text must be at most 32 characters',
  'export.batchAtLeastOne': 'Rows per INSERT must be at least 1',
  'export.progress': '{rows} rows written',
  'export.done': 'Wrote {rows} rows to {file}',
  'export.failed': 'Export failed: {reason}',
  'export.cancelled': 'Export cancelled',
  'export.cancelAction': 'Cancel export',
  'export.dismiss': 'Dismiss',
} as const;

export type MessageKey = keyof typeof en;
