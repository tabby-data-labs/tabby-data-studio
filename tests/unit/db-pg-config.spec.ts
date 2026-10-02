/**
 * Mapping a saved connection onto a `pg` pool configuration (PLAN Phase 4,
 * ARCHITECTURE §5.1 "SSL config with explicit `rejectUnauthorized`; no silent
 * trust").
 *
 * Tier 1, written test-first. Two properties are load-bearing:
 *
 *  1. **SSL mode is never downgraded silently.** An unknown mode is a hard
 *     error rather than a default, and only `disable` produces `ssl: false`.
 *  2. **The password cannot escape.** It never appears in a connection string,
 *     the key is absent entirely when there is no password, and the string we
 *     hand to the logger is built from an explicit field list.
 */
import { describe, expect, it } from 'vitest';
import type { SslMode, StoredConnection } from '../../src/shared/domain';
import {
  AUX_CONNECTIONS,
  MAX_CONCURRENT_CURSORS,
  PgConfigError,
  RESERVED_CANCEL_CONNECTIONS,
  describeConfigForLog,
  poolSizeFor,
  toPgConfig,
  type PgSslConfig,
} from '../../src/main/db/pg-config';
import { DEFAULT_SESSION_LIMITS } from '../../src/main/db/session';

function connection(overrides: Partial<StoredConnection> = {}): StoredConnection {
  return {
    id: 'conn-1',
    name: 'local',
    host: 'localhost',
    port: 5432,
    database: 'tabby-data-test',
    user: 'postgres',
    encryptedPassword: 'enc(whatever)',
    sslMode: 'prefer',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('basic mapping', () => {
  it('passes host, port, database and user through unchanged', () => {
    const config = toPgConfig(connection(), null);
    expect(config.host).toBe('localhost');
    expect(config.port).toBe(5432);
    expect(config.database).toBe('tabby-data-test');
    expect(config.user).toBe('postgres');
  });

  it('sets the decrypted password when one exists', () => {
    expect(toPgConfig(connection(), 'hunter2').password).toBe('hunter2');
  });

  it('omits the password key entirely when there is no secret', () => {
    // Absent, not `undefined` and not `''`: an explicit key is the kind of thing
    // that ends up serialised into a log or a crash report.
    expect('password' in toPgConfig(connection(), null)).toBe(false);
    expect('password' in toPgConfig(connection(), '')).toBe(false);
  });

  it('never builds a connection string, which would embed the password', () => {
    expect('connectionString' in toPgConfig(connection(), 'hunter2')).toBe(false);
    expect(JSON.stringify(toPgConfig(connection(), 'hunter2'))).not.toContain('postgres://');
  });

  it('identifies itself to the server', () => {
    expect(toPgConfig(connection(), null).application_name).toBe('tabby');
  });

  it('mirrors the session timeouts into the pool, so a lazily created client is limited too', () => {
    const config = toPgConfig(connection(), null);
    expect(config.statement_timeout).toBe(DEFAULT_SESSION_LIMITS.statementTimeoutMs);
    expect(config.lock_timeout).toBe(DEFAULT_SESSION_LIMITS.lockTimeoutMs);
    expect(config.idle_in_transaction_session_timeout).toBe(
      DEFAULT_SESSION_LIMITS.idleInTransactionTimeoutMs,
    );
  });

  it('accepts explicit limits in place of the defaults', () => {
    const config = toPgConfig(connection(), null, { statementTimeoutMs: 1_000 });
    expect(config.statement_timeout).toBe(1_000);
  });

  it('rejects invalid limits rather than connecting without them', () => {
    expect(() => toPgConfig(connection(), null, { statementTimeoutMs: 0 })).toThrow();
  });
});

describe('pool sizing', () => {
  it('reserves a connection for pg_cancel_backend on top of the cursor slots', () => {
    // Cancelling on the busy connection is impossible — it is blocked waiting for
    // the server — so the reserve is not optional headroom.
    expect(RESERVED_CANCEL_CONNECTIONS).toBe(1);
    expect(MAX_CONCURRENT_CURSORS).toBeGreaterThanOrEqual(2);
    expect(poolSizeFor(MAX_CONCURRENT_CURSORS)).toBe(
      MAX_CONCURRENT_CURSORS + RESERVED_CANCEL_CONNECTIONS + AUX_CONNECTIONS,
    );
    expect(toPgConfig(connection(), null).max).toBe(poolSizeFor(MAX_CONCURRENT_CURSORS));
  });

  it('leaves headroom for catalog reads, so a full set of cursors cannot deadlock the UI', () => {
    // Every result holds its client until its tab closes. With no spare slots, the
    // next schema-tree expansion or background count(*) would queue behind them
    // forever — which presents as a hung window, not as an error.
    expect(AUX_CONNECTIONS).toBeGreaterThanOrEqual(1);
    expect(poolSizeFor(MAX_CONCURRENT_CURSORS)).toBeGreaterThan(
      MAX_CONCURRENT_CURSORS + RESERVED_CANCEL_CONNECTIONS,
    );
  });

  it('refuses a pool that could not also cancel', () => {
    expect(() => poolSizeFor(0)).toThrow(PgConfigError);
    expect(() => poolSizeFor(-1)).toThrow(PgConfigError);
    expect(() => poolSizeFor(1.5)).toThrow(PgConfigError);
  });

  it('caps the pool so a handful of connections cannot exhaust server slots', () => {
    expect(() => poolSizeFor(64)).toThrow(PgConfigError);
  });

  it('sets an idle timeout and a connection timeout', () => {
    const config = toPgConfig(connection(), null);
    expect(config.idleTimeoutMillis).toBeGreaterThan(0);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
    // A connect that hangs forever is worse than one that fails: the UI would
    // show a spinner with no way out.
    expect(config.connectionTimeoutMillis).toBeLessThanOrEqual(15_000);
  });
});

describe('SSL modes', () => {
  function sslFor(mode: SslMode) {
    return toPgConfig(connection({ sslMode: mode }), null).ssl;
  }

  /** Narrows away the `disable` case so the assertions below are typed. */
  function tlsFor(mode: SslMode): PgSslConfig {
    const ssl = sslFor(mode);
    if (ssl === false) throw new Error(`expected TLS to be enabled for sslMode=${mode}`);
    return ssl;
  }

  it('disables TLS only for `disable`', () => {
    expect(sslFor('disable')).toBe(false);
  });

  it('encrypts without verifying the certificate for `prefer` and `require`', () => {
    // libpq's `require` means "encrypt, do not authenticate the server"; matching
    // it exactly avoids surprising a user who pointed Tabby at a self-signed host.
    for (const mode of ['prefer', 'require'] as const) {
      expect(tlsFor(mode).rejectUnauthorized, mode).toBe(false);
    }
  });

  it('verifies the certificate chain but not the hostname for `verify-ca`', () => {
    const ssl = tlsFor('verify-ca');
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(typeof ssl.checkServerIdentity).toBe('function');
    // A hostname mismatch must be accepted here — that is the whole difference
    // between verify-ca and verify-full.
    const mismatched = { subject: { CN: 'other.example.com' } };
    expect(ssl.checkServerIdentity?.('db.example.com', mismatched)).toBeUndefined();
  });

  it('verifies both chain and hostname for `verify-full`', () => {
    const ssl = tlsFor('verify-full');
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(typeof ssl.checkServerIdentity).toBe('function');

    const matching = { subject: { CN: 'db.example.com' }, subjectaltname: 'DNS:db.example.com' };
    expect(ssl.checkServerIdentity?.('db.example.com', matching)).toBeUndefined();

    const wrong = { subject: { CN: 'other.example.com' }, subjectaltname: 'DNS:other.example.com' };
    expect(ssl.checkServerIdentity?.('db.example.com', wrong)).toBeInstanceOf(Error);
  });

  it('passes the hostname to TLS as the SNI servername when verifying', () => {
    expect(tlsFor('verify-ca')).toMatchObject({ servername: 'localhost' });
    expect(tlsFor('verify-full')).toMatchObject({ servername: 'localhost' });
  });

  it('does not attempt SNI for a Unix-socket host', () => {
    const ssl = toPgConfig(connection({ host: '/tmp', sslMode: 'verify-full' }), null).ssl;
    if (ssl === false) throw new Error('expected TLS');
    expect(ssl.servername).toBeUndefined();
  });

  it('rejects an unknown SSL mode instead of defaulting to plaintext', () => {
    expect(() => sslFor('allow' as SslMode)).toThrow(PgConfigError);
    expect(() => sslFor('' as SslMode)).toThrow(PgConfigError);
    expect(() => sslFor(undefined as unknown as SslMode)).toThrow(PgConfigError);
  });
});

describe('input validation', () => {
  it('rejects a port outside 1..65535', () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(() => toPgConfig(connection({ port }), null), String(port)).toThrow(PgConfigError);
    }
    expect(() => toPgConfig(connection({ port: 1 }), null)).not.toThrow();
    expect(() => toPgConfig(connection({ port: 65535 }), null)).not.toThrow();
  });

  it('rejects an empty host, database or user', () => {
    expect(() => toPgConfig(connection({ host: '' }), null)).toThrow(PgConfigError);
    expect(() => toPgConfig(connection({ database: '' }), null)).toThrow(PgConfigError);
    expect(() => toPgConfig(connection({ user: '' }), null)).toThrow(PgConfigError);
  });

  it('rejects a NUL byte in any field, which would truncate the value server-side', () => {
    expect(() => toPgConfig(connection({ user: 'postgres\u0000x' }), null)).toThrow(PgConfigError);
    expect(() => toPgConfig(connection({ database: 'db\u0000' }), null)).toThrow(PgConfigError);
  });

  it('rejects a non-string password', () => {
    expect(() => toPgConfig(connection(), 42 as unknown as string)).toThrow(PgConfigError);
    expect(() => toPgConfig(connection(), {} as unknown as string)).toThrow(PgConfigError);
  });

  it('accepts a Unix-socket directory as the host', () => {
    expect(toPgConfig(connection({ host: '/var/run/postgresql' }), null).host).toBe(
      '/var/run/postgresql',
    );
  });
});

describe('describeConfigForLog', () => {
  it('names the target without naming the credential', () => {
    const described = describeConfigForLog(toPgConfig(connection(), 'hunter2'));
    expect(described).toContain('localhost');
    expect(described).toContain('5432');
    expect(described).toContain('tabby-data-test');
    expect(described).toContain('postgres');
    expect(described).not.toContain('hunter2');
  });

  it('does not leak a password that is itself shaped like a key=value pair', () => {
    const described = describeConfigForLog(toPgConfig(connection(), 'password=hunter2'));
    expect(described).not.toContain('hunter2');
  });

  it('says whether TLS is on and whether the certificate is verified', () => {
    expect(describeConfigForLog(toPgConfig(connection({ sslMode: 'disable' }), null))).toContain(
      'ssl=off',
    );
    expect(describeConfigForLog(toPgConfig(connection({ sslMode: 'require' }), null))).toContain(
      'ssl=on',
    );
    expect(describeConfigForLog(toPgConfig(connection({ sslMode: 'require' }), null))).toContain(
      'verify=no',
    );
    expect(
      describeConfigForLog(toPgConfig(connection({ sslMode: 'verify-full' }), null)),
    ).toContain('verify=yes');
  });

  it('never emits an object, which would stringify every field including the password', () => {
    const described = describeConfigForLog(toPgConfig(connection(), 'hunter2'));
    expect(described).not.toContain('[object Object]');
    expect(described).not.toContain('"password"');
  });
});
