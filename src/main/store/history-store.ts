/**
 * The query-history file (PLAN Phase 7): append, rotate, list, delete one, clear.
 *
 * Sits beside `settings-store.ts` and follows the same two rules — writes land on
 * disk before the call returns, and a broken file costs the user data rather than
 * the application. It differs in one important way: **history is a side effect of
 * something the user already asked for**, so a failure here must never surface as a
 * failed query. `add` returns a tagged error and sets `loadWarning`; it does not
 * throw, and the caller is expected to carry on.
 *
 * Storage is JSON Lines in `userData`, rotated at `HISTORY_LIMITS.maxFileBytes`
 * into numbered siblings, of which at most `maxFiles` are kept. PLAN's privacy note
 * is the reason the bound is a constant rather than a setting: an unbounded local
 * file of every literal a user ever typed, some of which are secrets, is the risk
 * the note names, and "configure it to be forever" is not a mitigation.
 *
 * `clear` and `delete` unlink the files. That removes them from the filesystem, not
 * from the disk platter or the SSD's wear-levelling table — the same guarantee a
 * browser gives when you clear its history, and the one this note is claiming.
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { err, ok, scrub, type Result } from '../../shared/errors';
import {
  HISTORY_FILE_BASE,
  HISTORY_LIMITS,
  decodeLine,
  encodeEntry,
  historyFileName,
  parseHistory,
  rotationSteps,
  shouldRotate,
  truncateSql,
  type HistoryEntry,
  type HistoryStatus,
} from '../../shared/history';
import type { HistoryListResponse } from '../../shared/ipc-contract';
import { logError, logWarn } from '../log';

const SCOPE = 'history';

/** `parseHistory`'s "give me everything", used where a count is wanted, not a page. */
const ALL = Number.MAX_SAFE_INTEGER;

/** The sentinel the shared types use for "this run never produced a number". */
const UNKNOWN = -1;

export interface HistoryAddInput {
  readonly sql: string;
  readonly connectionId: string;
  readonly connectionLabel: string;
  readonly status: HistoryStatus;
  readonly elapsedMs: number;
  readonly rowCount: number;
}

export interface HistoryStoreOptions {
  readonly dir: string;
  /** Injectable for tests; defaults to `randomUUID` and `Date.now`. */
  readonly newId?: () => string;
  readonly now?: () => number;
}

export class HistoryStore {
  private readonly dir: string;
  private readonly livePath: string;
  private readonly newId: () => string;
  private readonly now: () => number;
  private warning: string | null = null;

  constructor(options: HistoryStoreOptions) {
    this.dir = options.dir;
    this.livePath = join(options.dir, HISTORY_FILE_BASE);
    this.newId = options.newId ?? ((): string => randomUUID());
    this.now = options.now ?? ((): number => Date.now());
  }

  /** Non-null once a read or write has failed. Surfaced on every `list` response. */
  get loadWarning(): string | null {
    return this.warning;
  }

  // ── write ──────────────────────────────────────────────────────────────────

  /**
   * Appends one record and returns what was stored.
   *
   * The statement is truncated and stripped of NUL before it is written, so the
   * file can never hold a record the reader would reject. Refusing an empty
   * statement is not tidiness: a blank line in a JSONL file is meaningless, and
   * "Run" on nothing should not create history.
   */
  add(input: HistoryAddInput): Result<HistoryEntry> {
    const { text, truncated } = truncateSql(input.sql.replaceAll('\u0000', ''));
    if (text.trim() === '') {
      return err<HistoryEntry>({
        code: 'VALIDATION_FAILED',
        field: 'sql',
        message: 'there is no statement to remember',
      });
    }

    const entry: HistoryEntry = {
      id: this.newId(),
      sql: text,
      truncated,
      connectionId: input.connectionId,
      connectionLabel: input.connectionLabel,
      ranAt: this.now(),
      elapsedMs: countOr(input.elapsedMs),
      rowCount: countOr(input.rowCount),
      status: input.status,
    };

    try {
      this.append(encodeEntry(entry));
      return ok(entry);
    } catch (error) {
      // Recorded and reported, never rethrown: the query this describes has
      // already finished, and its outcome is not the history file's to change.
      this.warning = `could not write query history: ${scrub(String(error))}`;
      logError(SCOPE, error);
      return err<HistoryEntry>({
        code: 'INTERNAL',
        message: 'the query history could not be written',
      });
    }
  }

  private append(line: string): void {
    mkdirSync(this.dir, { recursive: true });
    const bytes = Buffer.byteLength(line, 'utf8');
    if (shouldRotate(this.sizeOf(this.livePath), bytes)) this.rotate();
    appendFileSync(this.livePath, `${line}\n`, 'utf8');
  }

  private rotate(): void {
    for (const step of rotationSteps(this.livePath, HISTORY_LIMITS.maxFiles)) {
      if (step.to === null) {
        // `recursive` so a directory squatting on the slot — corrupt state, but
        // state we found — cannot wedge every subsequent write.
        rmSync(step.from, { force: true, recursive: true });
      } else if (existsSync(step.from)) {
        renameSync(step.from, step.to);
      }
    }
  }

  private sizeOf(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      // No file yet is the normal case for the very first record.
      return 0;
    }
  }

  // ── read ───────────────────────────────────────────────────────────────────

  /** Newest first, across the live file and every rotation still on disk. */
  list(limit: number = HISTORY_LIMITS.maxEntriesReturned): HistoryListResponse {
    const parsed = parseHistory(this.readAll(), limit);
    return { ...parsed, warning: this.warning };
  }

  /** File contents newest-first, skipping any path that cannot be read. */
  private readAll(): string[] {
    const texts: string[] = [];
    for (const path of this.paths()) {
      const text = this.read(path);
      if (text !== null) texts.push(text);
    }
    return texts;
  }

  private read(path: string): string | null {
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      // One unreadable rotation must not cost the entries in the others — but it
      // must not be silent either. A whole file of history going missing with no
      // signal is the same failure SettingsStore's `loadWarning` exists to prevent.
      const message = `could not read ${basename(path)}: ${scrub(String(error))}`;
      this.warning = message;
      logWarn(SCOPE, message);
      return null;
    }
  }

  /** Every path this store owns, newest first. */
  private paths(): string[] {
    const paths = [this.livePath];
    for (let slot = 1; slot < HISTORY_LIMITS.maxFiles; slot += 1) {
      paths.push(join(this.dir, historyFileName(slot - 1)));
    }
    return paths;
  }

  // ── removal ────────────────────────────────────────────────────────────────

  /**
   * Removes one record, rewriting the file that held it.
   *
   * A rewrite rather than an in-place edit because JSONL has no fixed-width
   * records. The write goes to a sibling temp file and is renamed, matching
   * `SettingsStore`: a crash halfway through must not leave a truncated log.
   */
  delete(id: string): Result<void> {
    for (const path of this.paths()) {
      const text = this.read(path);
      if (text === null) continue;

      const kept: string[] = [];
      let removed = false;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const entry = decodeLine(line);
        // A line that will not decode is dropped rather than preserved: it is not
        // a record, and copying it forward would keep a corrupt file corrupt.
        if (entry === null) continue;
        if (!removed && entry.id === id) {
          removed = true;
          continue;
        }
        kept.push(line);
      }
      if (!removed) continue;

      try {
        this.rewrite(path, kept);
        return ok(undefined);
      } catch (error) {
        this.warning = `could not rewrite query history: ${scrub(String(error))}`;
        logError(SCOPE, error);
        return err<void>({ code: 'INTERNAL', message: 'the query history could not be updated' });
      }
    }

    return err<void>({ code: 'NOT_FOUND', message: `no history entry with id ${id}` });
  }

  /**
   * Removes every record and every file, and reports how many were removed.
   *
   * This is the action PLAN's privacy note asks for. It is a no-op that still
   * succeeds when there is nothing to clear, because "clear history" on an empty
   * history is what the user asked for and not an error.
   */
  clear(): Result<number> {
    const { entries } = parseHistory(this.readAll(), ALL);
    try {
      for (const path of this.paths()) rmSync(path, { force: true });
      this.warning = null;
      return ok(entries.length);
    } catch (error) {
      this.warning = `could not clear query history: ${scrub(String(error))}`;
      logError(SCOPE, error);
      return err<number>({ code: 'INTERNAL', message: 'the query history could not be cleared' });
    }
  }

  private rewrite(path: string, lines: readonly string[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
    renameSync(tmp, path);
  }
}

function countOr(value: number): number {
  return Number.isFinite(value) ? value : UNKNOWN;
}
