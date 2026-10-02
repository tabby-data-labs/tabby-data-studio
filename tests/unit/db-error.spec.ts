/**
 * Mapping a `pg` failure onto the tagged error union that crosses IPC
 * (PLAN Phase 4, ARCHITECTURE §8).
 *
 * Tier 1, written test-first. Three properties matter:
 *
 *  1. **The renderer branches on `code`, never on message text**, so the mapping
 *     from SQLSTATE and from Node's socket error codes has to be explicit and
 *     total — every input produces a TabbyError, and nothing throws.
 *  2. **`25006` must survive as `READ_ONLY_VIOLATION`.** That is the assertion
 *     behind Phase 4's read-only exit criterion.
 *  3. **A message cannot carry a secret.** Postgres and the TLS stack both echo
 *     connection details into error text, so the message is redacted here rather
 *     than trusting every call site to remember.
 */
import { describe, expect, it } from 'vitest';
import { isSqlState, sqlStateOf, toTabbyError } from '../../src/main/db/pg-error';

/** Minimal structural stand-in for pg's DatabaseError. */
function pgError(fields: Record<string, unknown>): Error & Record<string, unknown> {
  return Object.assign(new Error(String(fields['message'] ?? 'server error')), fields);
}

function nodeError(code: string, message = 'socket failure'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('SQLSTATE detection', () => {
  it('recognises the five-character alnum form Postgres uses', () => {
    expect(isSqlState('25006')).toBe(true);
    expect(isSqlState('42P01')).toBe(true);
    expect(isSqlState('XX000')).toBe(true);
  });

  it('does not mistake a Node socket code for a SQLSTATE', () => {
    // Both live on `.code`, and confusing them would report ECONNREFUSED as a
    // syntax error class.
    for (const notSqlState of [
      'ECONNREFUSED',
      'ENOTFOUND',
      '42',
      '426012',
      '4260!',
      '',
      null,
      42601,
    ]) {
      expect(isSqlState(notSqlState), String(notSqlState)).toBe(false);
    }
  });

  it('extracts the SQLSTATE from a pg error and returns null otherwise', () => {
    expect(sqlStateOf(pgError({ code: '25006' }))).toBe('25006');
    expect(sqlStateOf(nodeError('ECONNREFUSED'))).toBeNull();
    expect(sqlStateOf('a string')).toBeNull();
    expect(sqlStateOf(null)).toBeNull();
  });

  it('does not read a five-character socket code as a SQLSTATE', () => {
    // `EPIPE` and `EPERM` are exactly five characters of [0-9A-Z], the same shape
    // as a SQLSTATE, and both libraries put them on `.code`. Reporting one as a
    // server error would lose the connection-lost diagnosis.
    expect(isSqlState('EPIPE')).toBe(true); // shape-wise it genuinely matches
    expect(sqlStateOf(nodeError('EPIPE'))).toBeNull();
    expect(sqlStateOf(nodeError('EPERM'))).toBeNull();
    expect(toTabbyError(nodeError('EPIPE')).code).toBe('CONN_LOST');
    expect(toTabbyError(nodeError('EPERM')).code).toBe('INTERNAL');
  });
});

describe('read-only enforcement', () => {
  it('maps 25006 to READ_ONLY_VIOLATION and keeps the SQLSTATE', () => {
    const error = toTabbyError(
      pgError({
        code: '25006',
        message: 'cannot execute INSERT in a read-only transaction',
      }),
    );
    expect(error.code).toBe('READ_ONLY_VIOLATION');
    expect(error.sqlState).toBe('25006');
    expect(error.message).toContain('read-only transaction');
  });

  it('maps 25P02 (transaction aborted) distinctly from a read-only refusal', () => {
    expect(toTabbyError(pgError({ code: '25P02' })).code).toBe('INTERNAL');
    expect(toTabbyError(pgError({ code: '25P02' })).sqlState).toBe('25P02');
  });
});

describe('SQLSTATE classes', () => {
  const cases: [string, string][] = [
    ['28000', 'AUTH_FAILED'],
    ['28P01', 'AUTH_FAILED'],
    ['08001', 'CONN_REFUSED'],
    ['08004', 'CONN_REFUSED'],
    ['08003', 'CONN_LOST'],
    ['08006', 'CONN_LOST'],
    ['08P01', 'CONN_LOST'],
    ['57014', 'QUERY_CANCELLED'],
    ['57P01', 'CONN_LOST'],
    ['57P02', 'CONN_LOST'],
    ['57P03', 'CONN_LOST'],
    ['42601', 'SYNTAX_ERROR'],
    ['42602', 'SYNTAX_ERROR'],
    ['42703', 'SYNTAX_ERROR'],
    ['42883', 'SYNTAX_ERROR'],
    ['42P02', 'SYNTAX_ERROR'],
    ['42P01', 'RELATION_NOT_FOUND'],
    ['42501', 'PERMISSION_DENIED'],
    ['34000', 'CURSOR_CLOSED'],
    ['3D000', 'NOT_FOUND'],
    ['3F000', 'NOT_FOUND'],
    ['53300', 'INTERNAL'],
    ['XX000', 'INTERNAL'],
  ];

  it.each(cases)('maps %s to %s', (sqlState, expected) => {
    const error = toTabbyError(pgError({ code: sqlState, message: 'x' }));
    expect(error.code).toBe(expected);
    expect(error.sqlState).toBe(sqlState);
  });

  it('falls back to the SQLSTATE class for an unrecognised code', () => {
    expect(toTabbyError(pgError({ code: '42ZZZ' })).code).toBe('SYNTAX_ERROR');
    expect(toTabbyError(pgError({ code: '08ZZZ' })).code).toBe('CONN_LOST');
    expect(toTabbyError(pgError({ code: '28ZZZ' })).code).toBe('AUTH_FAILED');
    expect(toTabbyError(pgError({ code: '99ZZZ' })).code).toBe('INTERNAL');
  });
});

describe('socket and TLS errors, which carry no SQLSTATE', () => {
  const cases: [string, string][] = [
    ['ECONNREFUSED', 'CONN_REFUSED'],
    ['EHOSTUNREACH', 'CONN_REFUSED'],
    ['ENETUNREACH', 'CONN_REFUSED'],
    ['ENOTFOUND', 'DNS_FAILED'],
    ['EAI_AGAIN', 'DNS_FAILED'],
    ['ETIMEDOUT', 'CONN_TIMEOUT'],
    ['ECONNRESET', 'CONN_LOST'],
    ['EPIPE', 'CONN_LOST'],
  ];

  it.each(cases)('maps %s to %s', (code, expected) => {
    expect(toTabbyError(nodeError(code)).code).toBe(expected);
  });

  it('reports no SQLSTATE for a socket error', () => {
    expect(toTabbyError(nodeError('ECONNREFUSED')).sqlState).toBeUndefined();
  });

  it('maps certificate failures to SSL_REJECTED, from either code or message', () => {
    for (const code of [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      expect(toTabbyError(nodeError(code)).code, code).toBe('SSL_REJECTED');
      expect(toTabbyError(new Error(`handshake failed: ${code}`)).code, code).toBe('SSL_REJECTED');
    }
  });

  it('recognises a terminated connection from its message text', () => {
    expect(toTabbyError(new Error('Connection terminated unexpectedly')).code).toBe('CONN_LOST');
    expect(toTabbyError(new Error('Client has already been released')).code).toBe('CONN_LOST');
  });

  it('prefers the explicit socket code over a message that also mentions TLS', () => {
    expect(toTabbyError(nodeError('ECONNREFUSED', 'connect ECONNREFUSED after TLS')).code).toBe(
      'CONN_REFUSED',
    );
  });
});

describe('syntax error position', () => {
  it('converts the 1-based server offset to the 0-based offset the console underlines', () => {
    expect(toTabbyError(pgError({ code: '42601', position: '15' })).position).toBe(14);
    expect(toTabbyError(pgError({ code: '42601', position: 15 })).position).toBe(14);
    expect(toTabbyError(pgError({ code: '42601', position: '1' })).position).toBe(0);
  });

  it('omits the position when it is absent or unusable', () => {
    expect(toTabbyError(pgError({ code: '42601' })).position).toBeUndefined();
    expect(toTabbyError(pgError({ code: '42601', position: '0' })).position).toBeUndefined();
    expect(toTabbyError(pgError({ code: '42601', position: 'abc' })).position).toBeUndefined();
    expect(toTabbyError(pgError({ code: '42601', position: '-3' })).position).toBeUndefined();
  });

  it('carries the server hint, which for a missing relation is the useful half', () => {
    const error = toTabbyError(
      pgError({
        code: '42P01',
        message: 'relation "usr" does not exist',
        hint: 'Perhaps you meant to reference the table "user".',
      }),
    );
    expect(error.message).toContain('Perhaps you meant');
  });
});

describe('secret redaction', () => {
  it('redacts key=value credentials', () => {
    const error = toTabbyError(new Error('auth failed password=hunter2 for user postgres'));
    expect(error.message).not.toContain('hunter2');
    expect(error.message).toContain('[redacted]');
  });

  it('redacts a password embedded in a connection URI', () => {
    const error = toTabbyError(
      new Error('could not connect to postgres://postgres:hunter2@db.example.com:5432/app'),
    );
    expect(error.message).not.toContain('hunter2');
    // The host is not secret and stays useful for diagnosing a wrong hostname.
    expect(error.message).toContain('db.example.com');
  });

  it('redacts the hint and detail fields too, not just the message', () => {
    const error = toTabbyError(
      pgError({ code: '28P01', message: 'auth failed', hint: 'password=secret123' }),
    );
    expect(error.message).not.toContain('secret123');
  });
});

describe('total behaviour on hostile input', () => {
  it('never throws, whatever it is handed', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      '',
      'a plain string',
      {},
      [],
      Symbol('x'),
      () => undefined,
      new Error(''),
      pgError({ code: 42601, message: null }),
      pgError({ code: { nested: true } }),
    ];
    for (const input of inputs) {
      const error = toTabbyError(input);
      expect(error.code).toBeTruthy();
      expect(typeof error.message).toBe('string');
    }
  });

  it('survives an error whose message getter throws', () => {
    const hostile = {
      get message(): string {
        throw new Error('boom');
      },
      code: '42601',
    };
    expect(() => toTabbyError(hostile)).not.toThrow();
  });

  it('survives a circular object', () => {
    const circular: Record<string, unknown> = { message: 'circular' };
    circular['self'] = circular;
    expect(() => toTabbyError(circular)).not.toThrow();
  });

  it('uses INTERNAL and keeps a useful message for an unrecognised error', () => {
    const error = toTabbyError('something odd');
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('something odd');
  });

  it('caps the message so one server error cannot flood a log line', () => {
    const error = toTabbyError(new Error('x'.repeat(20_000)));
    expect(error.message.length).toBeLessThan(2_000);
  });

  it('attaches the caller-supplied context', () => {
    const error = toTabbyError(pgError({ code: '08006' }), {
      connectionId: 'conn-1',
      resultId: 'res-2',
    });
    expect(error.connectionId).toBe('conn-1');
    expect(error.resultId).toBe('res-2');
  });
});
