/**
 * Query history: the JSONL wire format and the retention rules (PLAN Phase 7).
 *
 * This lives in `src/shared` rather than in main for one reason — the renderer has
 * to render entries and main has to write them, and a format defined twice is a
 * format that drifts. It is logic only: no `node:fs`, no `node:path`, no Electron,
 * which is what the ESLint rule on `src/shared/**` enforces.
 *
 * **Privacy.** PLAN's note is the design constraint here: history may contain
 * literals that are secrets (`where token = '…'`), so the file never leaves
 * `userData`, is never synced, is bounded to a few megabytes by rotation, and can
 * be cleared entry by entry or wholesale. Nothing in this module redacts, because
 * a half-redacted statement is worse than an honest one — the user is told the
 * file exists and can delete it.
 *
 * **Durability.** A corrupt line costs that line and nothing more, mirroring the
 * stance `SettingsStore` takes with `settings.json`: losing every remembered
 * query over one truncated write is the worse outcome. Nothing here throws on bad
 * input, because it runs at startup where there is no UI to show a failure in.
 *
 * **Every run is one record.** Repeats are not collapsed. That is what psql,
 * DBeaver and DataGrip all do, and it is the honest reading of a log: the fourth
 * attempt that finally succeeded is a different event from the three that failed,
 * and hiding three of them behind one row would be a small lie with a real cost.
 * The bounds below are what keep the file honest about size, not deduplication.
 */

/** The live file. Rotations are numbered siblings of it — see `historyFileName`. */
export const HISTORY_FILE_BASE = 'history.jsonl';

export type HistoryStatus = 'ok' | 'failed' | 'cancelled';

export interface HistoryEntry {
  /** Stable id, generated in main. Names the entry for a single-entry delete. */
  readonly id: string;
  /**
   * The statement text as the user ran it — possibly a prefix, see `truncated`.
   * Stored verbatim rather than collapsed so re-running reproduces the query.
   */
  readonly sql: string;
  /**
   * True when `sql` was cut to fit `maxEntrySqlLength`. The UI must not offer to
   * re-run one: a prefix of a statement is a different statement.
   */
  readonly truncated: boolean;
  readonly connectionId: string;
  /**
   * Display label captured at run time. Deliberately denormalised: a connection
   * can be renamed or deleted afterwards, and the history of what the user ran
   * against "prod replica" should still say so.
   */
  readonly connectionLabel: string;
  /** Epoch milliseconds. */
  readonly ranAt: number;
  /** `-1` when the run never settled (cancelled, or the connection died). */
  readonly elapsedMs: number;
  /** `-1` when unknown — a cursor reports an exact count only once it ends. */
  readonly rowCount: number;
  readonly status: HistoryStatus;
}

/**
 * Hard bounds on the whole log.
 *
 * These are constants, not settings. The privacy note is why: a user-configurable
 * "keep history forever" turns a bounded local file into an unbounded record of
 * every literal anyone ever typed, which is the exact risk the note names.
 */
export const HISTORY_LIMITS = {
  /** One statement. A real migration script is kilobytes; this is generous. */
  maxEntrySqlLength: 20_000,
  /** Bytes per file before it is rotated out. */
  maxFileBytes: 1024 * 1024,
  /** Files retained, counting the live one. 3 × 1 MiB = 3 MiB of history, ever. */
  maxFiles: 3,
  /** Entries one `history:list` call may return. */
  maxEntriesReturned: 500,
} as const;

export interface RotationStep {
  readonly from: string;
  /** `null` means delete rather than rename. */
  readonly to: string | null;
}

export interface Truncation {
  readonly text: string;
  readonly truncated: boolean;
}

export interface ParsedHistory {
  readonly entries: readonly HistoryEntry[];
  /** Lines that could not be decoded. Surfaced so a corrupt file is not silent. */
  readonly skipped: number;
}

// ── Presentation ─────────────────────────────────────────────────────────────

/**
 * One line of SQL, for a list row or a tab title.
 *
 * Whitespace inside a string literal is collapsed too. Doing that correctly needs
 * the lexer, and a preview is not worth the coupling — the full statement is what
 * gets restored into the editor, not this.
 */
export function collapseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Cuts a statement to `max` **code points**.
 *
 * Counting code points rather than UTF-16 units is what keeps a truncation from
 * ending on a lone surrogate: that is valid JSON, unrenderable text, and would
 * look like corruption in an otherwise good entry.
 */
export function truncateSql(
  sql: string,
  max: number = HISTORY_LIMITS.maxEntrySqlLength,
): Truncation {
  if (max <= 0) return { text: '', truncated: sql.length > 0 };
  // The common case, and the cheap one: UTF-16 length is an upper bound on the
  // code-point count, so anything that fits certainly fits.
  if (sql.length <= max) return { text: sql, truncated: false };

  const kept: string[] = [];
  for (const codePoint of sql) {
    if (kept.length >= max) break;
    kept.push(codePoint);
  }
  const text = kept.join('');
  return { text, truncated: text !== sql };
}

// ── File naming and rotation ─────────────────────────────────────────────────

/**
 * `null` is the live file; `0` is the first rotation, and so on.
 *
 * Throws rather than inventing a name for a fractional or negative index, because
 * the caller derived that index from the retention config and a silent fallback
 * would write somewhere the rotation logic does not know about.
 */
export function historyFileName(index: number | null): string {
  if (index === null) return HISTORY_FILE_BASE;
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`history file index must be a non-negative integer, got ${index}`);
  }
  return `history.${index + 1}.jsonl`;
}

/**
 * Splits a path without `node:path`, which `src/shared` may not import.
 * The returned prefix keeps its separator, so joining is plain concatenation and
 * a rotated name can never escape the directory the live file lives in.
 */
function splitPath(path: string): { dir: string; base: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0
    ? { dir: '', base: path }
    : { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}

function assertLivePath(livePath: string): { dir: string } {
  const { dir, base } = splitPath(livePath);
  if (base !== HISTORY_FILE_BASE) {
    throw new RangeError(`expected a path ending in ${HISTORY_FILE_BASE}, got "${base}"`);
  }
  return { dir };
}

/**
 * The renames and deletes that rotate the log, **oldest slot first**.
 *
 * Order is the whole point: renaming `history.1` onto `history.2` before deleting
 * the old `history.2` would destroy a file the caller has not read yet. Applying
 * the returned list front to back is always safe.
 *
 * `maxFiles === 1` means "keep no history across rotations" and drops the live
 * file outright; `0` means the store should not be writing at all, and returns no
 * steps rather than throwing so a caller that disables retention cannot crash.
 */
export function rotationSteps(livePath: string, maxFiles: number): readonly RotationStep[] {
  const { dir } = assertLivePath(livePath);
  if (maxFiles <= 0) return [];
  if (maxFiles === 1) return [{ from: livePath, to: null }];

  const nameOf = (slot: number): string => `${dir}${historyFileName(slot - 1)}`;
  const steps: RotationStep[] = [{ from: nameOf(maxFiles - 1), to: null }];
  for (let slot = maxFiles - 2; slot >= 1; slot--) {
    steps.push({ from: nameOf(slot), to: nameOf(slot + 1) });
  }
  steps.push({ from: livePath, to: nameOf(1) });
  return steps;
}

/**
 * Whether appending `appendBytes` to a file of `sizeBytes` must rotate first.
 *
 * The `+ 1` is the newline that terminates the record — a file that lands exactly
 * on the cap has already exceeded it once the separator is counted. Degrades
 * rather than throws on a size that could not be stat'd: `NaN` means "unknown",
 * and rotating on unknown would discard a file the cap never applied to.
 */
export function shouldRotate(sizeBytes: number, appendBytes: number): boolean {
  if (sizeBytes === Number.POSITIVE_INFINITY) return true;
  const size = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
  if (!Number.isFinite(appendBytes) || appendBytes < 0) return false;
  return size + appendBytes + 1 > HISTORY_LIMITS.maxFileBytes;
}

// ── Codec ────────────────────────────────────────────────────────────────────

/**
 * One JSONL record. Explicit key order, no trailing newline: the separator is the
 * store's business, and a record that carried its own would double up.
 */
export function encodeEntry(entry: HistoryEntry): string {
  return JSON.stringify({
    id: entry.id,
    ranAt: entry.ranAt,
    connectionId: entry.connectionId,
    connectionLabel: entry.connectionLabel,
    status: entry.status,
    elapsedMs: entry.elapsedMs,
    rowCount: entry.rowCount,
    truncated: entry.truncated,
    sql: entry.sql,
  });
}

function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Decodes one line, or returns `null`.
 *
 * Never throws, and refuses rather than repairs: an entry missing its `id`, its
 * `sql` or a parseable `ranAt` is not an entry. Optional fields fall back to their
 * "unknown" values so a log written by an older Tabby still reads.
 *
 * A NUL byte in `sql` is rejected outright. The IPC validator refuses one on the
 * way in, so this is defence for a hand-edited file — and for the fact that a NUL
 * would truncate the statement server-side, splitting one query into two.
 */
export function decodeLine(line: string): HistoryEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const { id, sql, connectionId, ranAt, status } = record;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof sql !== 'string' || sql.includes('\u0000')) return null;
  if (typeof connectionId !== 'string') return null;
  if (typeof ranAt !== 'number' || !Number.isFinite(ranAt)) return null;
  if (status !== 'ok' && status !== 'failed' && status !== 'cancelled') return null;

  // Re-truncated on the way in: a hand-edited file, or one written before the cap
  // was lowered, must not put a megabyte of text into a list row.
  const { text, truncated } = truncateSql(sql);

  return {
    id,
    sql: text,
    truncated: truncated || record['truncated'] === true,
    connectionId,
    connectionLabel: typeof record['connectionLabel'] === 'string' ? record['connectionLabel'] : '',
    ranAt,
    elapsedMs: optionalNumber(record['elapsedMs'], -1),
    rowCount: optionalNumber(record['rowCount'], -1),
    status,
  };
}

/**
 * Parses the log, newest first.
 *
 * `texts` is the file contents in **newest-file-first** order — the live file, then
 * `history.1.jsonl`, and so on. Within a file, records are append order. The result
 * is sorted by `ranAt` rather than trusted to that order, because a clock change or
 * a hand-edited file breaks it, and the timestamp is the only field that actually
 * says when something ran.
 *
 * Blank lines are not corruption and are not counted as skipped.
 */
export function parseHistory(
  texts: readonly string[],
  limit: number = HISTORY_LIMITS.maxEntriesReturned,
): ParsedHistory {
  if (!Number.isFinite(limit) || limit <= 0) return { entries: [], skipped: 0 };

  const oldestFirst: HistoryEntry[] = [];
  let skipped = 0;

  for (const text of texts) {
    // Split on LF only; `decodeLine` trims, so a CRLF file leaves its `\r` there.
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const entry = decodeLine(line);
      if (entry === null) skipped += 1;
      else oldestFirst.push(entry);
    }
  }

  // `Array.prototype.sort` is stable, so entries sharing a timestamp keep their
  // append order — and reversing then puts the later-appended one first.
  oldestFirst.sort((left, right) => left.ranAt - right.ranAt);
  return { entries: oldestFirst.reverse().slice(0, limit), skipped };
}
