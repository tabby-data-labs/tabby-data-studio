/**
 * IPC boundary validators (PLAN Phase 3, ARCHITECTURE §3).
 *
 * AGENTS.md puts main-process pure helpers in Tier 1, so these are written
 * test-first. The renderer is treated as untrusted input: a compromised renderer
 * must not be able to make main interpolate arbitrary SQL, allocate unbounded
 * memory, or pollute a prototype.
 *
 * Expectations are derived from the threat model, not from the implementation.
 */
import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  validateConnSave,
  validateConnectionId,
  validateHistoryAdd,
  validateHistoryId,
  validateHistoryLimit,
  validateQueryRun,
  validateResultWindow,
  validateSchemaChildren,
  validateSchemaTable,
  validateSettingsPatch,
} from '../../src/main/ipc/validate';
import { HISTORY_LIMITS } from '../../src/shared/history';

describe('primitive shape checks', () => {
  it('accepts a well-formed result window request', () => {
    expect(validateResultWindow({ resultId: 'r1', startRow: 0, rowCount: 200 })).toEqual({
      resultId: 'r1',
      startRow: 0,
      rowCount: 200,
    });
  });

  it('rejects a non-object payload', () => {
    for (const bad of [null, undefined, 42, 'r1', true, [], () => {}]) {
      expect(() => validateResultWindow(bad), String(bad)).toThrow(ValidationError);
    }
  });

  it('rejects a missing or wrongly typed field', () => {
    expect(() => validateResultWindow({ startRow: 0, rowCount: 10 })).toThrow(/resultId/);
    expect(() => validateResultWindow({ resultId: 1, startRow: 0, rowCount: 10 })).toThrow(
      /resultId/,
    );
    expect(() => validateResultWindow({ resultId: 'r', startRow: '0', rowCount: 10 })).toThrow(
      /startRow/,
    );
  });

  it('rejects unknown keys rather than passing them through', () => {
    // A permissive validator would let a caller smuggle extra fields to a handler.
    expect(() =>
      validateResultWindow({ resultId: 'r1', startRow: 0, rowCount: 10, isAdmin: true }),
    ).toThrow(/isAdmin/);
  });

  it('rejects NaN and Infinity where an integer is required', () => {
    expect(() =>
      validateResultWindow({ resultId: 'r', startRow: Number.NaN, rowCount: 10 }),
    ).toThrow(/startRow/);
    expect(() =>
      validateResultWindow({ resultId: 'r', startRow: 0, rowCount: Number.POSITIVE_INFINITY }),
    ).toThrow(/rowCount/);
  });

  it('rejects fractional and negative row indices', () => {
    expect(() => validateResultWindow({ resultId: 'r', startRow: -1, rowCount: 10 })).toThrow(
      /startRow/,
    );
    expect(() => validateResultWindow({ resultId: 'r', startRow: 1.5, rowCount: 10 })).toThrow(
      /startRow/,
    );
  });

  it('caps rowCount so one request cannot ask for the whole table', () => {
    expect(() => validateResultWindow({ resultId: 'r', startRow: 0, rowCount: 0 })).toThrow(
      /rowCount/,
    );
    expect(() =>
      validateResultWindow({ resultId: 'r', startRow: 0, rowCount: 10_000_000 }),
    ).toThrow(/rowCount/);
    // The documented maximum is accepted.
    expect(validateResultWindow({ resultId: 'r', startRow: 0, rowCount: 10_000 }).rowCount).toBe(
      10_000,
    );
  });

  it('caps identifier length', () => {
    expect(() => validateConnectionId('x'.repeat(200))).toThrow(/connectionId/);
  });

  it('reports a field path that names the offending key', () => {
    try {
      validateResultWindow({ resultId: 'r1', startRow: -5, rowCount: 10 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('startRow');
    }
  });

  it('reports a nested field path for nested objects', () => {
    try {
      validateConnSave({ connection: { id: 'c1', name: 42 }, password: 'p' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ValidationError).field).toBe('connection.name');
    }
  });
});

describe('prototype pollution', () => {
  it('rejects __proto__ as a key', () => {
    const payload = JSON.parse('{"resultId":"r1","startRow":0,"rowCount":10,"__proto__":{"x":1}}');
    expect(() => validateResultWindow(payload)).toThrow(ValidationError);
  });

  it('rejects constructor and prototype keys', () => {
    expect(() =>
      validateResultWindow({ resultId: 'r1', startRow: 0, rowCount: 10, constructor: {} }),
    ).toThrow(/constructor/);
    expect(() =>
      validateResultWindow({ resultId: 'r1', startRow: 0, rowCount: 10, prototype: {} }),
    ).toThrow(/prototype/);
  });

  it('never mutates Object.prototype while validating', () => {
    // A hostile renderer sends an object where a bare string is expected, with a
    // __proto__ key riding along. It must be refused, and nothing may leak onto
    // Object.prototype.
    const payload = JSON.parse('{"connectionId":"c1","__proto__":{"polluted":true}}');
    expect(() => validateConnectionId(payload)).toThrow(ValidationError);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects nested __proto__ too', () => {
    const payload = JSON.parse(
      '{"connection":{"id":"c1","name":"n","host":"h","port":5432,"database":"d","user":"u","sslMode":"disable","createdAt":0,"updatedAt":0,"__proto__":{"x":1}}}',
    );
    expect(() => validateConnSave(payload)).toThrow(ValidationError);
  });
});

describe('SQL-bearing fields', () => {
  it('accepts ordinary SQL text', () => {
    const sql = "SELECT * FROM t WHERE x = 'a;b' -- comment";
    expect(validateQueryRun({ connectionId: 'c1', sql }).sql).toBe(sql);
  });

  it('caps SQL length so a payload cannot exhaust memory', () => {
    expect(() => validateQueryRun({ connectionId: 'c1', sql: 'x'.repeat(2_000_000) })).toThrow(
      /sql/,
    );
  });

  it('rejects a NUL byte in SQL, which would truncate the statement server-side', () => {
    expect(() =>
      validateQueryRun({ connectionId: 'c1', sql: 'SELECT 1;\u0000DROP TABLE t' }),
    ).toThrow(/sql/);
  });

  it('rejects empty SQL', () => {
    expect(() => validateQueryRun({ connectionId: 'c1', sql: '' })).toThrow(/sql/);
  });

  it('accepts an optional browse target of two identifiers', () => {
    // Present only when the statement is a plain table scan, so main can page
    // without holding a transaction open.
    expect(
      validateQueryRun({
        connectionId: 'c1',
        sql: 'select * from fixtures.big',
        browse: { schema: 'fixtures', table: 'big' },
      }).browse,
    ).toEqual({ schema: 'fixtures', table: 'big' });
  });

  it('omits the browse key entirely when it was not sent', () => {
    expect('browse' in validateQueryRun({ connectionId: 'c1', sql: 'select 1' })).toBe(false);
  });

  it('rejects a browse target that is not exactly two identifiers', () => {
    expect(() =>
      validateQueryRun({ connectionId: 'c1', sql: 'select 1', browse: { schema: 's' } }),
    ).toThrow(/browse/);
    expect(() =>
      validateQueryRun({
        connectionId: 'c1',
        sql: 'select 1',
        browse: { schema: 's', table: 't', extra: 1 },
      }),
    ).toThrow(/browse/);
    expect(() =>
      validateQueryRun({ connectionId: 'c1', sql: 'select 1', browse: 'fixtures.big' }),
    ).toThrow(/browse/);
    expect(() =>
      validateQueryRun({ connectionId: 'c1', sql: 'select 1', browse: { schema: '', table: 't' } }),
    ).toThrow(/browse/);
  });

  it('rejects control characters and NUL bytes in a browse identifier', () => {
    expect(() =>
      validateQueryRun({
        connectionId: 'c1',
        sql: 'select 1',
        browse: { schema: 's\u0000', table: 't' },
      }),
    ).toThrow(/browse\.schema/);
    expect(() =>
      validateQueryRun({
        connectionId: 'c1',
        sql: 'select 1',
        browse: { schema: 's', table: 'a\tb' },
      }),
    ).toThrow(/browse\.table/);
  });

  it('still refuses unknown top-level keys on a query run', () => {
    expect(() => validateQueryRun({ connectionId: 'c1', sql: 'select 1', browse: null })).toThrow(
      /browse/,
    );
  });

  it('allows an identifier to contain a quote, because quoting is quoteIdent’s job', () => {
    // Postgres permits `we"ird` as a quoted identifier. Rejecting it here would
    // make such a table unbrowsable; the boundary checks shape and bounds, and
    // Phase 4's quoteIdent owns escaping. Control characters are still refused.
    expect(
      validateSchemaTable({ connectionId: 'c1', schema: 'public', table: 'we"ird' }).table,
    ).toBe('we"ird');
  });

  it('rejects control characters and NUL in identifiers', () => {
    expect(() =>
      validateSchemaTable({ connectionId: 'c1', schema: 'pub\u0000lic', table: 't' }),
    ).toThrow(/schema/);
    expect(() =>
      validateSchemaTable({ connectionId: 'c1', schema: 'public', table: 't\nDROP' }),
    ).toThrow(/table/);
  });

  it('caps identifier length at Postgres NAMEDATALEN', () => {
    expect(() =>
      validateSchemaTable({ connectionId: 'c1', schema: 'public', table: 't'.repeat(64) }),
    ).toThrow(/table/);
    expect(
      validateSchemaTable({ connectionId: 'c1', schema: 'public', table: 't'.repeat(63) }).table,
    ).toHaveLength(63);
  });

  it('accepts a null parent schema at the database root', () => {
    expect(
      validateSchemaChildren({ connectionId: 'c1', parentSchema: null }).parentSchema,
    ).toBeNull();
  });

  it('rejects a non-string, non-null parent schema', () => {
    expect(() => validateSchemaChildren({ connectionId: 'c1', parentSchema: 42 })).toThrow(
      /parentSchema/,
    );
  });
});

describe('enums', () => {
  it('accepts every documented sslMode', () => {
    for (const sslMode of ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const) {
      expect(
        validateConnSave({ connection: connFixture({ sslMode }), password: 'p' }).connection
          .sslMode,
      ).toBe(sslMode);
    }
  });

  it('rejects an unknown sslMode instead of defaulting it', () => {
    expect(() =>
      validateConnSave({ connection: connFixture({ sslMode: 'trust-everything' }), password: 'p' }),
    ).toThrow(/sslMode/);
  });
});

describe('connection payloads', () => {
  it('accepts a well-formed connection and drops the plaintext password field', () => {
    const result = validateConnSave({ connection: connFixture(), password: 'hunter2' });
    expect(result.connection.id).toBe('c1');
    // The plaintext travels only in `password`; it must never be copied onto the
    // stored record by the validator.
    expect(Object.keys(result.connection)).not.toContain('password');
    expect(result.password).toBe('hunter2');
  });

  it('allows an omitted password', () => {
    expect(validateConnSave({ connection: connFixture() }).password).toBeUndefined();
  });

  it('rejects a non-string password', () => {
    expect(() => validateConnSave({ connection: connFixture(), password: 42 })).toThrow(/password/);
  });

  it('caps password length', () => {
    expect(() =>
      validateConnSave({ connection: connFixture(), password: 'x'.repeat(5000) }),
    ).toThrow(/password/);
  });

  it('validates the port range', () => {
    expect(() => validateConnSave({ connection: connFixture({ port: 0 }) })).toThrow(/port/);
    expect(() => validateConnSave({ connection: connFixture({ port: 70_000 }) })).toThrow(/port/);
    expect(() => validateConnSave({ connection: connFixture({ port: 5432.5 }) })).toThrow(/port/);
    expect(validateConnSave({ connection: connFixture({ port: 5432 }) }).connection.port).toBe(
      5432,
    );
  });

  it('rejects an empty host or database', () => {
    expect(() => validateConnSave({ connection: connFixture({ host: '' }) })).toThrow(/host/);
    expect(() => validateConnSave({ connection: connFixture({ database: '' }) })).toThrow(
      /database/,
    );
  });

  it('rejects a malformed timestamp', () => {
    expect(() => validateConnSave({ connection: connFixture({ createdAt: -1 }) })).toThrow(
      /createdAt/,
    );
  });

  it('accepts a bare connection id', () => {
    expect(validateConnectionId('c1')).toBe('c1');
  });

  it('rejects an empty connection id', () => {
    expect(() => validateConnectionId('')).toThrow(/connectionId/);
  });
});

describe('settings patch', () => {
  it('accepts a theme change', () => {
    expect(validateSettingsPatch({ theme: 'light' })).toEqual({ theme: 'light' });
  });

  it('rejects an unknown theme', () => {
    expect(() => validateSettingsPatch({ theme: 'solarised' })).toThrow(/theme/);
  });

  it('accepts a sane window geometry', () => {
    const window = {
      x: 100,
      y: 80,
      width: 1440,
      height: 900,
      isMaximized: false,
      isFullScreen: false,
    };
    // The validator returns a patch, not the bare window.
    expect(validateSettingsPatch({ window })).toEqual({ window });
  });

  it('accepts a negative window position, which is valid on a secondary display', () => {
    const window = {
      x: -1920,
      y: -40,
      width: 1440,
      height: 900,
      isMaximized: false,
      isFullScreen: false,
    };
    expect(validateSettingsPatch({ window })).toEqual({ window });
  });

  it('rejects a non-positive or absurd window size', () => {
    const base = { x: 0, y: 0, isMaximized: false, isFullScreen: false };
    expect(() => validateSettingsPatch({ window: { ...base, width: 0, height: 900 } })).toThrow(
      /width/,
    );
    expect(() =>
      validateSettingsPatch({ window: { ...base, width: 100_000, height: 900 } }),
    ).toThrow(/width/);
  });

  it('rejects a non-finite window position', () => {
    expect(() =>
      validateSettingsPatch({
        window: {
          x: Number.NaN,
          y: 0,
          width: 800,
          height: 600,
          isMaximized: false,
          isFullScreen: false,
        },
      }),
    ).toThrow(/x/);
  });

  it('accepts an empty patch', () => {
    expect(validateSettingsPatch({})).toEqual({});
  });

  it('rejects an unknown patch key', () => {
    expect(() => validateSettingsPatch({ theme: 'dark', isAdmin: true })).toThrow(/isAdmin/);
  });
});

describe('query history payloads', () => {
  function historyFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sql: "select * from fixtures.big where token = 'not-a-secret'",
      connectionId: 'c1',
      connectionLabel: 'Local · localhost:5432/postgres',
      status: 'ok',
      elapsedMs: 12,
      rowCount: 1000,
      ...overrides,
    };
  }

  it('accepts a well-formed record and passes the SQL through untouched', () => {
    // History stores what the user typed. Rewriting it here — collapsing
    // whitespace, stripping a literal that looks like a secret — would make the
    // restored statement a different query from the one that ran.
    const sql = "select 'a\nb'";
    expect(validateHistoryAdd(historyFixture({ sql }))).toEqual({
      sql,
      connectionId: 'c1',
      connectionLabel: 'Local · localhost:5432/postgres',
      status: 'ok',
      elapsedMs: 12,
      rowCount: 1000,
    });
  });

  it.each(['ok', 'failed', 'cancelled'])('accepts status %s', (status) => {
    expect(validateHistoryAdd(historyFixture({ status })).status).toBe(status);
  });

  it('accepts the -1 sentinel for a run that produced no number', () => {
    const parsed = validateHistoryAdd(historyFixture({ elapsedMs: -1, rowCount: -1 }));
    expect(parsed.elapsedMs).toBe(-1);
    expect(parsed.rowCount).toBe(-1);
  });

  it('accepts an empty connection label', () => {
    // A connection deleted between the run and the record has no summary to
    // label it with; refusing the record would lose the query too.
    expect(validateHistoryAdd(historyFixture({ connectionLabel: '' })).connectionLabel).toBe('');
  });

  it('rejects an unknown status rather than storing one', () => {
    expect(() => validateHistoryAdd(historyFixture({ status: 'exploded' }))).toThrow(/status/);
  });

  it('rejects a NUL byte in the SQL', () => {
    // The same check `query:run` applies. A NUL reaching a JSONL file would be a
    // record boundary waiting to happen, and server-side it would split one
    // statement into two.
    expect(() => validateHistoryAdd(historyFixture({ sql: 'select\u0000 1' }))).toThrow(/NUL/);
  });

  it('rejects an unknown key, so a renderer cannot smuggle an id or a timestamp', () => {
    // Both are main's to generate; accepting them would let a caller backdate or
    // collide history entries.
    expect(() => validateHistoryAdd(historyFixture({ id: 'mine' }))).toThrow(/id/);
    expect(() => validateHistoryAdd(historyFixture({ ranAt: 1 }))).toThrow(/ranAt/);
  });

  it('rejects a missing required field', () => {
    const payload = historyFixture();
    delete payload['sql'];
    expect(() => validateHistoryAdd(payload)).toThrow(/sql/);
  });

  it('rejects a non-finite elapsed time', () => {
    expect(() => validateHistoryAdd(historyFixture({ elapsedMs: Number.NaN }))).toThrow(
      /elapsedMs/,
    );
    expect(() => validateHistoryAdd(historyFixture({ rowCount: Number.NaN }))).toThrow(/rowCount/);
  });

  it('rejects a negative row count below the sentinel', () => {
    expect(() => validateHistoryAdd(historyFixture({ rowCount: -2 }))).toThrow(/rowCount/);
  });

  it('rejects prototype pollution in the record', () => {
    const raw = `{"sql":"select 1","connectionId":"c1","connectionLabel":"",
      "status":"ok","elapsedMs":1,"rowCount":1,"__proto__":{"isAdmin":true}}`;
    expect(() => validateHistoryAdd(JSON.parse(raw))).toThrow(/__proto__/);
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it('defaults an omitted limit to the retention cap', () => {
    expect(validateHistoryLimit(undefined)).toBe(HISTORY_LIMITS.maxEntriesReturned);
  });

  it('accepts a limit within bounds', () => {
    expect(validateHistoryLimit(1)).toBe(1);
    expect(validateHistoryLimit(HISTORY_LIMITS.maxEntriesReturned)).toBe(
      HISTORY_LIMITS.maxEntriesReturned,
    );
  });

  it('refuses a limit that would pull the whole log into one response', () => {
    expect(() => validateHistoryLimit(HISTORY_LIMITS.maxEntriesReturned + 1)).toThrow(/limit/);
    expect(() => validateHistoryLimit(Number.MAX_SAFE_INTEGER)).toThrow(/limit/);
  });

  it('refuses a zero, negative or fractional limit', () => {
    expect(() => validateHistoryLimit(0)).toThrow(/limit/);
    expect(() => validateHistoryLimit(-1)).toThrow(/limit/);
    expect(() => validateHistoryLimit(1.5)).toThrow(/limit/);
  });

  it('bounds a history id like every other id on the bridge', () => {
    expect(validateHistoryId('h1')).toBe('h1');
    expect(() => validateHistoryId('')).toThrow(ValidationError);
    expect(() => validateHistoryId('x'.repeat(200))).toThrow(/historyId/);
  });
});

function connFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    name: 'Local',
    host: 'localhost',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    sslMode: 'prefer',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}
