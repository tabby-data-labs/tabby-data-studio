/**
 * Session hardening applied to every new Postgres backend (PLAN Phase 4,
 * ARCHITECTURE §5.1).
 *
 * Tier 1, written test-first. `default_transaction_read_only` is the real v1
 * safety guarantee: it is enforced by the server, so a bug in our SQL
 * construction cannot write. That makes the *ordering* of these statements a
 * correctness property, not a style choice — read-only must be in effect before
 * anything else can run on the backend.
 */
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_NAME,
  DEFAULT_SESSION_LIMITS,
  READ_ONLY_STATEMENT,
  resolveLimits,
  sessionStatements,
} from '../../src/main/db/session';

describe('statement set', () => {
  it('enables read-only mode first, before any timeout or encoding is touched', () => {
    const statements = sessionStatements();
    expect(statements[0]).toBe('SET default_transaction_read_only = on');
    expect(READ_ONLY_STATEMENT).toBe('SET default_transaction_read_only = on');
  });

  it('applies every session characteristic listed in ARCHITECTURE §5.1', () => {
    const statements = sessionStatements();
    expect(statements).toEqual([
      'SET default_transaction_read_only = on',
      `SET statement_timeout = ${DEFAULT_SESSION_LIMITS.statementTimeoutMs}`,
      `SET idle_in_transaction_session_timeout = ${DEFAULT_SESSION_LIMITS.idleInTransactionTimeoutMs}`,
      `SET lock_timeout = ${DEFAULT_SESSION_LIMITS.lockTimeoutMs}`,
      "SET client_encoding = 'UTF8'",
      "SET DateStyle = 'ISO, MDY'",
      "SET timezone = 'UTC'",
      `SET application_name = '${APPLICATION_NAME}'`,
    ]);
  });

  it('defaults to the documented 30s / 60s / 5s budget', () => {
    expect(DEFAULT_SESSION_LIMITS).toEqual({
      statementTimeoutMs: 30_000,
      idleInTransactionTimeoutMs: 60_000,
      lockTimeoutMs: 5_000,
    });
  });

  it('emits each statement without a trailing semicolon, so they run one at a time', () => {
    for (const statement of sessionStatements()) {
      expect(statement.endsWith(';'), statement).toBe(false);
      expect(statement.startsWith('SET ')).toBe(true);
    }
  });

  it('never interpolates a value that did not come from this module', () => {
    // Every right-hand side is either a bare integer or one of two fixed string
    // literals. There is no caller-supplied text anywhere in the output.
    const joined = sessionStatements().join('\n');
    expect(joined).not.toContain("'UTC'--");
    expect(joined.match(/'/g)?.length ?? 0).toBe(8); // 4 quoted literals, 2 quotes each
  });

  it('is pure: two calls produce equal but independent arrays', () => {
    const a = sessionStatements();
    const b = sessionStatements();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('timeout rendering', () => {
  it('uses bare milliseconds, which Postgres documents as the unit', () => {
    // `'30s'` in the design doc and `30000` here are the same setting; the
    // integer form has no unit-string parsing to get wrong across versions.
    const statements = sessionStatements({ statementTimeoutMs: 1_500 });
    expect(statements).toContain('SET statement_timeout = 1500');
  });

  it('accepts a partial override and keeps defaults for the rest', () => {
    const statements = sessionStatements({ lockTimeoutMs: 250 });
    expect(statements).toContain('SET lock_timeout = 250');
    expect(statements).toContain(
      `SET statement_timeout = ${DEFAULT_SESSION_LIMITS.statementTimeoutMs}`,
    );
    expect(statements).toContain(
      `SET idle_in_transaction_session_timeout = ${DEFAULT_SESSION_LIMITS.idleInTransactionTimeoutMs}`,
    );
  });

  it('ignores undefined overrides', () => {
    expect(sessionStatements({ statementTimeoutMs: undefined })).toEqual(sessionStatements());
  });
});

describe('limit validation fails closed', () => {
  it('rejects zero, because in Postgres zero means "no timeout at all"', () => {
    expect(() => resolveLimits({ statementTimeoutMs: 0 })).toThrow(/statement_timeout/);
    expect(() => resolveLimits({ lockTimeoutMs: 0 })).toThrow(/lock_timeout/);
    expect(() => resolveLimits({ idleInTransactionTimeoutMs: 0 })).toThrow(/idle_in_transaction/);
  });

  it('rejects negative, fractional and non-finite values', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => resolveLimits({ statementTimeoutMs: bad }), String(bad)).toThrow();
    }
  });

  it('rejects non-numbers rather than coercing them', () => {
    // `undefined` is deliberately absent here: a Partial override that omits a
    // limit means "use the default", which the test above covers.
    for (const bad of ['30s', null, {}, true, []]) {
      expect(
        () => resolveLimits({ statementTimeoutMs: bad as unknown as number }),
        String(bad),
      ).toThrow();
    }
  });

  it('caps the timeout at one hour so a nonsense value cannot hang a session', () => {
    expect(() => resolveLimits({ statementTimeoutMs: 3_600_000 })).not.toThrow();
    expect(() => resolveLimits({ statementTimeoutMs: 3_600_001 })).toThrow();
  });

  it('reports which limit was invalid', () => {
    try {
      resolveLimits({ lockTimeoutMs: -5 });
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect((caught as Error).message).toContain('lock_timeout');
    }
  });
});
