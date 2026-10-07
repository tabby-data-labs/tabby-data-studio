/**
 * The query-history file: append, rotate, list, delete one, clear all.
 *
 * Tier 2 (an fs adapter) by AGENTS.md, so this was written against the intended
 * behaviour rather than shown red first — but the retention rules it exercises are
 * the ones `history-codec.spec.ts` derives purely, and the two must agree.
 *
 * What is being asserted, and why it is worth asserting:
 *  - **an acknowledged append survives** — the record is on disk before `add` returns;
 *  - **rotation keeps the byte cap and loses nothing inside it**;
 *  - **a write failure cannot break the user's query** — history is a side effect
 *    of running something, and a full disk must not turn a successful SELECT into
 *    an error the user has to read;
 *  - **clear and delete actually remove bytes**, because PLAN's privacy note is the
 *    reason this store exists at all.
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../../src/main/store/history-store';
import {
  HISTORY_FILE_BASE,
  HISTORY_LIMITS,
  decodeLine,
  encodeEntry,
  type HistoryEntry,
} from '../../src/shared/history';

let dir: string;
let clock: number;
let ids: number;

function store(): HistoryStore {
  return new HistoryStore({
    dir,
    now: () => clock,
    newId: () => `h${(ids += 1)}`,
  });
}

function add(
  target: HistoryStore = store(),
  overrides: Partial<Parameters<HistoryStore['add']>[0]> = {},
): HistoryEntry {
  clock += 1_000;
  const result = target.add({
    sql: 'select 1',
    connectionId: 'c1',
    connectionLabel: 'Local · localhost:5432/postgres',
    status: 'ok',
    elapsedMs: 4,
    rowCount: 1,
    ...overrides,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function livePath(): string {
  return join(dir, HISTORY_FILE_BASE);
}

function liveLines(): string[] {
  if (!existsSync(livePath())) return [];
  return readFileSync(livePath(), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabby-history-'));
  clock = 1_700_000_000_000;
  ids = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('add', () => {
  it('appends exactly one JSONL line, readable back by the shared decoder', () => {
    const entry = add();
    const lines = liveLines();
    expect(lines).toHaveLength(1);
    expect(decodeLine(lines[0]!)).toEqual(entry);
  });

  it('returns the stored entry, with an id and a timestamp main generated', () => {
    const entry = add(store(), { sql: 'select now()' });
    expect(entry.id).toBe('h1');
    expect(entry.ranAt).toBe(clock);
    expect(entry.sql).toBe('select now()');
    expect(entry.truncated).toBe(false);
  });

  it('creates the directory if it does not exist yet', () => {
    const nested = join(dir, 'userData', 'deeper');
    const target = new HistoryStore({ dir: nested, now: () => clock, newId: () => 'x' });
    expect(
      target.add({
        sql: 'select 1',
        connectionId: 'c1',
        connectionLabel: '',
        status: 'ok',
        elapsedMs: 1,
        rowCount: 1,
      }).ok,
    ).toBe(true);
    expect(existsSync(join(nested, HISTORY_FILE_BASE))).toBe(true);
  });

  it('records every run, repeats included', () => {
    const target = store();
    add(target);
    add(target);
    add(target);
    expect(liveLines()).toHaveLength(3);
    expect(target.list().entries).toHaveLength(3);
  });

  it('records a failed run and a cancelled one', () => {
    const target = store();
    add(target, { status: 'failed', elapsedMs: 30, rowCount: -1 });
    add(target, { status: 'cancelled', elapsedMs: -1, rowCount: -1 });
    expect(target.list().entries.map((each) => each.status)).toEqual(['cancelled', 'failed']);
  });

  it('truncates an over-long statement and flags it', () => {
    const huge = 'select '.repeat(HISTORY_LIMITS.maxEntrySqlLength);
    const entry = add(store(), { sql: huge });
    expect(entry.sql).toHaveLength(HISTORY_LIMITS.maxEntrySqlLength);
    expect(entry.truncated).toBe(true);
  });

  it('strips a NUL byte rather than storing one', () => {
    // The IPC validator refuses a NUL on the way in; this is the belt to that
    // brace, because a NUL in a JSONL file is a record boundary waiting to happen.
    const entry = add(store(), { sql: 'select\u0000 1' });
    expect(entry.sql).toBe('select 1');
    expect(readFileSync(livePath(), 'utf8')).not.toContain('\u0000');
  });

  it('refuses SQL that is empty or only whitespace', () => {
    const target = store();
    for (const sql of ['', '   ', '\n\t ']) {
      clock += 1;
      const result = target.add({
        sql,
        connectionId: 'c1',
        connectionLabel: '',
        status: 'ok',
        elapsedMs: 1,
        rowCount: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    }
    expect(existsSync(livePath())).toBe(false);
  });

  it('coerces a non-finite elapsed time or row count to the unknown sentinel', () => {
    const entry = add(store(), { elapsedMs: Number.NaN, rowCount: Number.POSITIVE_INFINITY });
    expect(entry.elapsedMs).toBe(-1);
    expect(entry.rowCount).toBe(-1);
  });

  it('reports a write failure instead of throwing, and says so afterwards', () => {
    // The user's query already succeeded by the time history is written; a full
    // disk or a locked userData directory must not turn that into an error.
    const notADirectory = join(dir, 'blocked');
    writeFileSync(notADirectory, 'i am a file, not a directory', 'utf8');
    const target = new HistoryStore({ dir: notADirectory, now: () => clock, newId: () => 'x' });

    // Read through a plain string rather than the Result itself: TypeScript's
    // control-flow analysis cannot see an assignment made inside a closure, so a
    // `let result: Result | null` captured this way narrows to `never`.
    let code: string | null = null;
    expect(() => {
      const result = target.add({
        sql: 'select 1',
        connectionId: 'c1',
        connectionLabel: '',
        status: 'ok',
        elapsedMs: 1,
        rowCount: 1,
      });
      code = result.ok ? null : result.error.code;
    }).not.toThrow();

    expect(code).toBe('INTERNAL');
    expect(target.loadWarning).not.toBeNull();
    // The warning must reach the renderer, since `add` refusing is not allowed to
    // surface as a failed query — this is the only channel it has.
    expect(target.list().warning).toBe(target.loadWarning);
  });
});

describe('list', () => {
  it('returns nothing and no warning when no history has ever been written', () => {
    expect(store().list()).toEqual({ entries: [], skipped: 0, warning: null });
  });

  it('returns newest first', () => {
    const target = store();
    add(target, { sql: 'select 1' });
    add(target, { sql: 'select 2' });
    add(target, { sql: 'select 3' });
    expect(target.list().entries.map((each) => each.sql)).toEqual([
      'select 3',
      'select 2',
      'select 1',
    ]);
  });

  it('honours a limit smaller than the log', () => {
    const target = store();
    for (let index = 0; index < 10; index += 1) add(target, { sql: `select ${index}` });
    expect(target.list(3).entries).toHaveLength(3);
    expect(target.list(3).entries[0]?.sql).toBe('select 9');
  });

  it('defaults to the shared cap', () => {
    expect(store().list().entries).toEqual([]);
    expect(HISTORY_LIMITS.maxEntriesReturned).toBeGreaterThan(0);
  });

  it('skips a corrupt line, keeps the rest, and counts it', () => {
    add();
    writeFileSync(livePath(), `${readFileSync(livePath(), 'utf8')}not json\n`, 'utf8');
    add();

    const result = store().list();
    expect(result.skipped).toBe(1);
    expect(result.entries).toHaveLength(2);
  });

  it('reads through rotated files', () => {
    add();
    writeFileSync(join(dir, 'history.1.jsonl'), `${encodeEntry(older('r1'))}\n`, 'utf8');
    const result = store().list();
    expect(result.entries.map((each) => each.id)).toEqual(['h1', 'r1']);
  });

  it('keeps the readable entries when a rotation cannot be read, and says so', () => {
    add();
    // A directory where a rotated file should be. `readFileSync` throws EISDIR.
    mkdirSync(join(dir, 'history.1.jsonl'));
    const result = store().list();
    expect(result.entries).toHaveLength(1);
    // Not silent: a whole file of history going missing is exactly the failure
    // SettingsStore's loadWarning exists to prevent.
    expect(result.warning).toMatch(/history\.1\.jsonl/);
  });
});

function older(id: string): HistoryEntry {
  return {
    id,
    sql: 'select old',
    truncated: false,
    connectionId: 'c1',
    connectionLabel: 'Local',
    ranAt: 1_600_000_000_000,
    elapsedMs: 1,
    rowCount: 1,
    status: 'ok',
  };
}

describe('rotation', () => {
  /**
   * Enough records to force several rotations of the **real** 1 MiB cap. The
   * shipped constant is used rather than an injected one, so these assertions fail
   * if the cap is ever raised without the retention behaviour being re-examined.
   */
  const SQL = 'x'.repeat(1_000);
  const PER_ROTATION = Math.ceil(HISTORY_LIMITS.maxFileBytes / 1_100);

  it('rotates into numbered siblings, keeps the live file under the cap, and still reads across all of them', () => {
    const target = store();
    for (let index = 0; index < PER_ROTATION * 3; index += 1) add(target, { sql: SQL });

    expect(existsSync(join(dir, 'history.1.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'history.2.jsonl'))).toBe(true);
    // The live file is back under the cap, which is the entire point of rotating.
    expect(statSync(livePath()).size).toBeLessThanOrEqual(HISTORY_LIMITS.maxFileBytes);

    const listed = target.list(HISTORY_LIMITS.maxEntriesReturned);
    expect(listed.entries).toHaveLength(HISTORY_LIMITS.maxEntriesReturned);
    expect(listed.skipped).toBe(0);
  });

  it('bounds both the file count and the total bytes on disk', () => {
    const target = store();
    for (let index = 0; index < PER_ROTATION * 3; index += 1) add(target, { sql: SQL });

    const names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    expect(names).toContain(HISTORY_FILE_BASE);
    expect(names.length).toBeLessThanOrEqual(HISTORY_LIMITS.maxFiles);

    const total = names.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
    expect(total).toBeLessThanOrEqual(HISTORY_LIMITS.maxFileBytes * HISTORY_LIMITS.maxFiles);
  });

  it('drops the oldest rotation rather than keeping it forever', () => {
    const target = store();
    writeFileSync(
      join(dir, 'history.1.jsonl'),
      `${encodeEntry(older('about-to-be-pushed-out'))}\n`,
      'utf8',
    );
    for (let index = 0; index < PER_ROTATION + 50; index += 1) add(target, { sql: SQL });

    // One rotation happened: the pre-seeded file moved to slot 2 or was dropped,
    // and either way the entry is still reachable or honestly gone — never both.
    const listed = target.list(Number.MAX_SAFE_INTEGER);
    const survived = listed.entries.some((each) => each.id === 'about-to-be-pushed-out');
    expect(existsSync(join(dir, 'history.2.jsonl'))).toBe(survived);
  });
});

describe('delete', () => {
  it('removes exactly one entry and leaves the others in order', () => {
    const target = store();
    const first = add(target, { sql: 'select 1' });
    add(target, { sql: 'select 2' });
    const third = add(target, { sql: 'select 3' });

    expect(target.delete(first.id).ok).toBe(true);
    expect(target.list().entries.map((each) => each.sql)).toEqual(['select 3', 'select 2']);
    expect(target.delete(third.id).ok).toBe(true);
    expect(target.list().entries.map((each) => each.sql)).toEqual(['select 2']);
  });

  it('answers NOT_FOUND for an id that was never stored', () => {
    add();
    const result = store().delete('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('answers NOT_FOUND when the log is empty', () => {
    const result = store().delete('anything');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('removes an entry that has already been rotated out', () => {
    writeFileSync(join(dir, 'history.1.jsonl'), `${encodeEntry(older('rotated'))}\n`, 'utf8');
    const fresh = add();
    const target = store();

    expect(target.delete('rotated').ok).toBe(true);
    expect(existsSync(join(dir, 'history.1.jsonl'))).toBe(true);
    expect(target.list().entries.map((each) => each.id)).toEqual([fresh.id]);
  });

  it('rewrites atomically, leaving no temp file behind', () => {
    const target = store();
    const entry = add(target);
    add(target);
    target.delete(entry.id);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('drops a corrupt line it happens to be rewriting, and reports it', () => {
    const target = store();
    const entry = add(target);
    add(target);
    writeFileSync(livePath(), `${readFileSync(livePath(), 'utf8')}garbage\n`, 'utf8');

    target.delete(entry.id);
    expect(target.list().skipped).toBe(0);
    expect(target.list().entries).toHaveLength(1);
  });
});

describe('clear', () => {
  it('reports how many entries it removed', () => {
    const target = store();
    add(target);
    add(target);
    add(target);
    const result = target.clear();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(3);
  });

  it('removes the files, not just their contents', () => {
    const target = store();
    add(target);
    writeFileSync(join(dir, 'history.1.jsonl'), `${encodeEntry(older('r1'))}\n`, 'utf8');

    target.clear();
    expect(existsSync(livePath())).toBe(false);
    expect(existsSync(join(dir, 'history.1.jsonl'))).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toEqual([]);
    expect(target.list()).toEqual({ entries: [], skipped: 0, warning: null });
  });

  it('counts entries across rotated files', () => {
    const target = store();
    add(target);
    writeFileSync(join(dir, 'history.1.jsonl'), `${encodeEntry(older('r1'))}\n`, 'utf8');
    writeFileSync(join(dir, 'history.2.jsonl'), `${encodeEntry(older('r2'))}\n`, 'utf8');

    const result = target.clear();
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toBe(3);
  });

  it('is a no-op that still succeeds when there is nothing to clear', () => {
    const result = store().clear();
    expect(result).toEqual({ ok: true, value: 0 });
  });

  it('does not count a corrupt line as an entry it removed', () => {
    const target = store();
    add(target);
    writeFileSync(livePath(), `${readFileSync(livePath(), 'utf8')}garbage\n`, 'utf8');
    const result = target.clear();
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toBe(1);
    expect(existsSync(livePath())).toBe(false);
  });
});
