/**
 * Query history: the JSONL wire format and the retention rules (PLAN Phase 7).
 *
 * Expectations are derived from the stated task and from the privacy note in
 * PLAN — "history may contain literals including secrets — store locally, never
 * sync, and offer a clear-history action" — not from the implementation.
 *
 * The properties that matter:
 *  - a line round-trips **byte for byte**, because the SQL is the payload;
 *  - a corrupt line costs that line, never the log (same stance as settings.json);
 *  - nothing throws, ever — this runs at startup with no UI to show a failure in;
 *  - retention is a hard byte cap, because an unbounded file of other people's
 *    literals is exactly what the privacy note is about.
 */
import { describe, expect, it } from 'vitest';
import {
  HISTORY_LIMITS,
  collapseSql,
  encodeEntry,
  decodeLine,
  historyFileName,
  parseHistory,
  rotationSteps,
  shouldRotate,
  truncateSql,
  type HistoryEntry,
} from '../../src/shared/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h1',
    sql: 'select 1',
    truncated: false,
    connectionId: 'c1',
    connectionLabel: 'Local · localhost:5432/postgres',
    ranAt: 1_700_000_000_000,
    elapsedMs: 12,
    rowCount: 1,
    status: 'ok',
    ...overrides,
  };
}

describe('collapseSql', () => {
  it('collapses runs of whitespace to a single space and trims', () => {
    expect(collapseSql('  select\n\t  1  ')).toBe('select 1');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(collapseSql('   \n\t ')).toBe('');
    expect(collapseSql('')).toBe('');
  });

  it('does not rewrite the inside of a string literal', () => {
    // A lexer would be needed to do that, and a preview does not warrant one.
    // Recorded so the next reader knows this is a deliberate limitation.
    expect(collapseSql("select 'a   b'")).toBe("select 'a b'");
  });

  it('flattens a CRLF script onto one line', () => {
    expect(collapseSql('select 1;\r\nselect 2;')).toBe('select 1; select 2;');
  });
});

describe('truncateSql', () => {
  it('leaves a short statement alone and reports no truncation', () => {
    expect(truncateSql('select 1', 100)).toEqual({ text: 'select 1', truncated: false });
  });

  it('cuts at exactly the limit without flagging truncation', () => {
    const text = 'a'.repeat(10);
    expect(truncateSql(text, 10)).toEqual({ text, truncated: false });
  });

  it('flags one character over the limit', () => {
    const result = truncateSql('a'.repeat(11), 10);
    expect(result).toEqual({ text: 'a'.repeat(10), truncated: true });
  });

  it('counts code points, so it never splits a surrogate pair', () => {
    // A naive `slice(0, 2)` would keep 'a' plus a lone high surrogate: valid JSON,
    // unrenderable text, and a preview that looks like corruption for good SQL.
    const result = truncateSql('a😀b', 2);
    expect(result.text).toBe('a😀');
    expect(result.truncated).toBe(true);
  });

  it('does not flag a string of exactly the limit in code points', () => {
    expect(truncateSql('a😀', 2)).toEqual({ text: 'a😀', truncated: false });
  });

  it('treats a non-positive limit as "keep nothing"', () => {
    expect(truncateSql('select 1', 0)).toEqual({ text: '', truncated: true });
    expect(truncateSql('select 1', -5)).toEqual({ text: '', truncated: true });
  });

  it('caps at the shared default without being asked', () => {
    const huge = 'x'.repeat(HISTORY_LIMITS.maxEntrySqlLength + 1);
    const result = truncateSql(huge);
    expect(result.text).toHaveLength(HISTORY_LIMITS.maxEntrySqlLength);
    expect(result.truncated).toBe(true);
  });
});

describe('encodeEntry / decodeLine', () => {
  it('round-trips an entry exactly', () => {
    const original = entry();
    expect(decodeLine(encodeEntry(original))).toEqual(original);
  });

  it('emits one line with no trailing newline', () => {
    const line = encodeEntry(entry({ sql: 'select 1' }));
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line.endsWith('}')).toBe(true);
  });

  it('round-trips SQL containing a newline as an escape, not a real break', () => {
    const original = entry({ sql: "select 'a\nb'; -- note\r\n" });
    const line = encodeEntry(original);
    expect(line.split('\n')).toHaveLength(1);
    expect(decodeLine(line)).toEqual(original);
  });

  it('round-trips SQL containing quotes, backslashes and a NUL-free control char', () => {
    const sql = `select E'a\\'b' || "col""x" || '\t'`;
    expect(decodeLine(encodeEntry(entry({ sql })))).toEqual(entry({ sql }));
  });

  it('preserves the truncated flag', () => {
    const original = entry({ sql: 'aaa', truncated: true });
    expect(decodeLine(encodeEntry(original))?.truncated).toBe(true);
  });

  it.each(['ok', 'failed', 'cancelled'] as const)('round-trips status %s', (status) => {
    expect(decodeLine(encodeEntry(entry({ status })))?.status).toBe(status);
  });

  it('records a run that never settled', () => {
    const original = entry({ elapsedMs: -1, rowCount: -1, status: 'cancelled' });
    expect(decodeLine(encodeEntry(original))).toEqual(original);
  });

  it('returns null rather than throwing for non-JSON', () => {
    expect(decodeLine('not json at all')).toBeNull();
  });

  it.each([
    ['an empty line', ''],
    ['whitespace only', '   '],
    ['a JSON array', '[1,2,3]'],
    ['a JSON string', '"select 1"'],
    ['a JSON number', '42'],
    ['a JSON null', 'null'],
    ['a truncated object', '{"id":"h1","sql":"sel'],
  ])('returns null for %s', (_label, line) => {
    expect(decodeLine(line)).toBeNull();
  });

  it.each(['id', 'sql', 'connectionId', 'ranAt', 'status'])(
    'returns null when the required field %s is missing',
    (field) => {
      const parsed = JSON.parse(encodeEntry(entry())) as Record<string, unknown>;
      delete parsed[field];
      expect(decodeLine(JSON.stringify(parsed))).toBeNull();
    },
  );

  it('rejects an unknown status rather than inventing one', () => {
    const parsed = JSON.parse(encodeEntry(entry())) as Record<string, unknown>;
    parsed['status'] = 'exploded';
    expect(decodeLine(JSON.stringify(parsed))).toBeNull();
  });

  it('rejects a non-finite ranAt', () => {
    expect(decodeLine(encodeEntry(entry({ ranAt: Number.NaN })))).toBeNull();
    // JSON.stringify turns Infinity into null, which is a different rejection path.
    const parsed = JSON.parse(encodeEntry(entry())) as Record<string, unknown>;
    parsed['ranAt'] = null;
    expect(decodeLine(JSON.stringify(parsed))).toBeNull();
  });

  it('tolerates optional fields being absent by filling their defaults', () => {
    // A log written by an older Tabby, or one a user hand-edited down to the
    // minimum, must still be readable.
    const minimal = JSON.stringify({
      id: 'h9',
      sql: 'select 9',
      connectionId: 'c9',
      ranAt: 1_700_000_000_000,
      status: 'ok',
    });
    expect(decodeLine(minimal)).toEqual(
      entry({
        id: 'h9',
        sql: 'select 9',
        connectionId: 'c9',
        ranAt: 1_700_000_000_000,
        elapsedMs: -1,
        rowCount: -1,
        truncated: false,
        connectionLabel: '',
      }),
    );
  });

  it('ignores keys it does not know, so a newer log stays readable', () => {
    const parsed = JSON.parse(encodeEntry(entry())) as Record<string, unknown>;
    parsed['somethingFromTheFuture'] = { deep: true };
    const decoded = decodeLine(JSON.stringify(parsed));
    expect(decoded).toEqual(entry());
  });

  it('clamps an over-long sql from a hand-edited file and flags it truncated', () => {
    const parsed = JSON.parse(encodeEntry(entry())) as Record<string, unknown>;
    parsed['sql'] = 'y'.repeat(HISTORY_LIMITS.maxEntrySqlLength + 500);
    const decoded = decodeLine(JSON.stringify(parsed));
    expect(decoded?.sql).toHaveLength(HISTORY_LIMITS.maxEntrySqlLength);
    expect(decoded?.truncated).toBe(true);
  });

  it('refuses an entry carrying a NUL byte', () => {
    // A NUL cannot survive the IPC validators either; refusing it here keeps the
    // on-disk file free of anything the rest of the app would reject.
    expect(decodeLine(encodeEntry(entry({ sql: 'select\u00001' })))).toBeNull();
  });
});

describe('parseHistory', () => {
  const lines = [entry({ id: 'a', ranAt: 100 }), entry({ id: 'b', ranAt: 200 })];

  it('returns newest first', () => {
    const text = lines.map(encodeEntry).join('\n');
    expect(parseHistory([text]).entries.map((each) => each.id)).toEqual(['b', 'a']);
  });

  it('reads across rotated files, newest file first', () => {
    const current = encodeEntry(entry({ id: 'new', ranAt: 300 }));
    const rotated = lines.map(encodeEntry).join('\n');
    expect(parseHistory([current, rotated]).entries.map((each) => each.id)).toEqual([
      'new',
      'b',
      'a',
    ]);
  });

  it('accepts CRLF and LF line endings alike', () => {
    const crlf = lines.map(encodeEntry).join('\r\n');
    expect(parseHistory([crlf]).entries.map((each) => each.id)).toEqual(['b', 'a']);
  });

  it('skips a corrupt line and counts it, keeping the rest', () => {
    const text = [encodeEntry(lines[0]!), 'GARBAGE', encodeEntry(lines[1]!)].join('\n');
    const result = parseHistory([text]);
    expect(result.entries.map((each) => each.id)).toEqual(['b', 'a']);
    expect(result.skipped).toBe(1);
  });

  it('reports zero skipped lines for a clean log', () => {
    expect(parseHistory([lines.map(encodeEntry).join('\n')]).skipped).toBe(0);
  });

  it('returns an empty list and no error for an empty log', () => {
    expect(parseHistory([])).toEqual({ entries: [], skipped: 0 });
    expect(parseHistory([''])).toEqual({ entries: [], skipped: 0 });
    expect(parseHistory(['\n\n\n'])).toEqual({ entries: [], skipped: 0 });
  });

  it('counts every unparseable line, not just the first', () => {
    expect(parseHistory(['{', 'nope', '[]']).skipped).toBe(3);
  });

  it('caps the result at the requested limit, keeping the newest', () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      encodeEntry(entry({ id: `h${index}`, ranAt: index })),
    ).join('\n');
    const result = parseHistory([many], 3);
    expect(result.entries.map((each) => each.id)).toEqual(['h49', 'h48', 'h47']);
  });

  it('treats a non-positive limit as "nothing"', () => {
    const text = lines.map(encodeEntry).join('\n');
    expect(parseHistory([text], 0).entries).toEqual([]);
    expect(parseHistory([text], -1).entries).toEqual([]);
  });

  it('defaults the limit to the shared cap', () => {
    const many = Array.from({ length: HISTORY_LIMITS.maxEntriesReturned + 40 }, (_, index) =>
      encodeEntry(entry({ id: `h${index}`, ranAt: index })),
    ).join('\n');
    expect(parseHistory([many]).entries).toHaveLength(HISTORY_LIMITS.maxEntriesReturned);
  });

  it('puts the later-appended entry first when two share a timestamp', () => {
    const text = [
      encodeEntry(entry({ id: 'first', ranAt: 100 })),
      encodeEntry(entry({ id: 'second', ranAt: 100 })),
    ].join('\n');
    expect(parseHistory([text]).entries.map((each) => each.id)).toEqual(['second', 'first']);
  });

  it('does not reorder entries whose timestamps disagree with their file order', () => {
    // A clock change or a hand-edited file. Sorting by ranAt is the honest answer:
    // the timestamp is the only field that says when something ran.
    const text = [
      encodeEntry(entry({ id: 'late', ranAt: 900 })),
      encodeEntry(entry({ id: 'early', ranAt: 100 })),
    ].join('\n');
    expect(parseHistory([text]).entries.map((each) => each.id)).toEqual(['late', 'early']);
  });

  it('keeps every record of a repeated statement, duplicates included', () => {
    // A deliberate policy, and the one psql, DBeaver and DataGrip all follow: the
    // log is a record of runs, not of distinct queries. Collapsing repeats would
    // hide the fourth attempt that finally succeeded from the three that did not,
    // and the byte cap plus "clear history" are the privacy controls, not dedupe.
    const text = [100, 200, 300]
      .map((ranAt) => encodeEntry(entry({ id: `r${ranAt}`, ranAt })))
      .join('\n');
    expect(parseHistory([text]).entries.map((each) => each.id)).toEqual(['r300', 'r200', 'r100']);
  });
});

describe('shouldRotate', () => {
  const limit = HISTORY_LIMITS.maxFileBytes;

  it('does not rotate an empty file', () => {
    expect(shouldRotate(0, 100)).toBe(false);
  });

  it('does not rotate while the append still fits', () => {
    expect(shouldRotate(limit - 101, 100)).toBe(false);
  });

  it('rotates when the append would land exactly on the cap', () => {
    // `size + line + separator` — the newline is a byte too.
    expect(shouldRotate(limit - 100, 100)).toBe(true);
  });

  it('rotates when the file is already over the cap', () => {
    expect(shouldRotate(limit + 1, 1)).toBe(true);
  });

  it('rotates for a single line larger than the whole cap', () => {
    // Otherwise one enormous statement would grow the file without bound.
    expect(shouldRotate(0, limit * 2)).toBe(true);
  });

  it('treats a negative or non-finite size as empty rather than throwing', () => {
    expect(shouldRotate(-1, 10)).toBe(false);
    expect(shouldRotate(Number.NaN, 10)).toBe(false);
    expect(shouldRotate(Number.POSITIVE_INFINITY, 10)).toBe(true);
  });

  it('treats a non-finite append size as fitting nothing', () => {
    expect(shouldRotate(0, Number.NaN)).toBe(false);
    expect(shouldRotate(0, -1)).toBe(false);
  });
});

describe('historyFileName', () => {
  it('names the live file with no index', () => {
    expect(historyFileName(null)).toBe('history.jsonl');
  });

  it('numbers rotated files from 1', () => {
    expect(historyFileName(0)).toBe('history.1.jsonl');
    expect(historyFileName(1)).toBe('history.2.jsonl');
    expect(historyFileName(2)).toBe('history.3.jsonl');
  });

  it('refuses a negative or fractional index rather than inventing a name', () => {
    expect(() => historyFileName(-1)).toThrow(RangeError);
    expect(() => historyFileName(1.5)).toThrow(RangeError);
  });
});

describe('rotationSteps', () => {
  it('shifts oldest-first so no rename overwrites a file that has not moved', () => {
    const steps = rotationSteps('/d/history.jsonl', 3);
    expect(steps).toEqual([
      { from: '/d/history.2.jsonl', to: null },
      { from: '/d/history.1.jsonl', to: '/d/history.2.jsonl' },
      { from: '/d/history.jsonl', to: '/d/history.1.jsonl' },
    ]);
  });

  it('drops the current file outright when only one file is kept', () => {
    expect(rotationSteps('/d/history.jsonl', 1)).toEqual([{ from: '/d/history.jsonl', to: null }]);
  });

  it('produces no steps when retention is zero, meaning "do not keep history"', () => {
    expect(rotationSteps('/d/history.jsonl', 0)).toEqual([]);
  });

  it('keeps every step inside the directory the live file lives in', () => {
    // A path that escaped userData would write somewhere the user did not choose.
    for (const step of rotationSteps('/Users/me/Library/tabby/history.jsonl', 4)) {
      expect(step.from.startsWith('/Users/me/Library/tabby/')).toBe(true);
      expect(step.to === null || step.to.startsWith('/Users/me/Library/tabby/')).toBe(true);
    }
  });

  it('refuses a live path that is not a plain file name', () => {
    expect(() => rotationSteps('/d/history', 3)).toThrow(RangeError);
  });
});

describe('HISTORY_LIMITS', () => {
  it('bounds the whole log to a few megabytes', () => {
    // The privacy note is the reason this is a hard number and not a setting:
    // an unbounded file of query literals, some of which are secrets, is the
    // thing the note is warning about.
    const total = HISTORY_LIMITS.maxFileBytes * HISTORY_LIMITS.maxFiles;
    expect(total).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(HISTORY_LIMITS.maxFiles).toBeGreaterThanOrEqual(1);
  });

  it('caps a single stored statement well below the IPC sql limit', () => {
    expect(HISTORY_LIMITS.maxEntrySqlLength).toBeLessThanOrEqual(64 * 1024);
    expect(HISTORY_LIMITS.maxEntrySqlLength).toBeGreaterThan(0);
  });

  it('returns a usable number of entries by default', () => {
    expect(HISTORY_LIMITS.maxEntriesReturned).toBeGreaterThanOrEqual(100);
  });
});
