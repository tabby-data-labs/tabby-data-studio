/**
 * Live-database harness for the Phase 4 exit criteria.
 *
 * Connection details come from the environment and nowhere else. No file in this
 * repository contains a password: `TABBY_TEST_PG_PASSWORD` is read at run time and
 * is never written to disk, logged, or committed.
 *
 *   TABBY_TEST_PG_HOST      (default localhost)
 *   TABBY_TEST_PG_PORT      (default 5432)
 *   TABBY_TEST_PG_USER      (required — its absence skips the whole suite)
 *   TABBY_TEST_PG_PASSWORD  (optional; trust auth needs none)
 *   TABBY_TEST_PG_DATABASE  (required — must have scripts/pg-fixtures.sql applied)
 *
 * Every spec is wrapped in `describe.skipIf(!pgConfigured)`, so `npm test` on a
 * machine with no database configured skips rather than fails.
 */
import { env, hrtime } from 'node:process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredConnection } from '../../../src/shared/domain';
import type { MainEventEmitter } from '../../../src/shared/ipc-contract';
import { ConnectionManager } from '../../../src/main/db/connection-manager';
import { createPgDriver } from '../../../src/main/db/driver-pg';
import { QueryService, type ResultLimits } from '../../../src/main/db/query-service';
import { SchemaService } from '../../../src/main/db/schema-service';
import { ExportService } from '../../../src/main/export/export-service';

export interface PgTestConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export function pgTestConfig(): PgTestConfig | null {
  const user = env['TABBY_TEST_PG_USER'] ?? '';
  const database = env['TABBY_TEST_PG_DATABASE'] ?? '';
  if (user === '' || database === '') return null;
  return {
    host: env['TABBY_TEST_PG_HOST'] ?? 'localhost',
    port: Number(env['TABBY_TEST_PG_PORT'] ?? '5432'),
    user,
    password: env['TABBY_TEST_PG_PASSWORD'] ?? '',
    database,
  };
}

const config = pgTestConfig();
export const pgConfigured = config !== null;

export const CONNECTION_ID = 'integration-1';

/** The fixture schema every assertion reads from. */
export const SCHEMA = 'fixtures';

export function storedConnection(): StoredConnection {
  const resolved = config;
  if (!resolved) throw new Error('no test database configured');
  return {
    id: CONNECTION_ID,
    name: 'integration',
    host: resolved.host,
    port: resolved.port,
    database: resolved.database,
    user: resolved.user,
    encryptedPassword: null,
    // localhost with no certificate: the point of these tests is the data layer,
    // not TLS. pg-config.spec.ts covers the SSL modes exhaustively.
    sslMode: 'disable',
    createdAt: 0,
    updatedAt: 0,
  };
}

export interface Harness {
  readonly connections: ConnectionManager;
  readonly schemas: SchemaService;
  readonly queries: QueryService;
  readonly exports: ExportService;
  /** Where `pickPath` puts an export, so a spec can read the file back. */
  readonly exportDir: string;
  /** Events main would push to the renderer, captured for assertions. */
  readonly events: { channel: string; payload: unknown }[];
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  /** Tight registry bounds, for the memory-cap soak. */
  readonly limits?: ResultLimits;
  /**
   * Where an export writes. Defaults to a throwaway directory under the system
   * temp, so a spec can read the file back without naming a path of its own.
   */
  readonly exportDir?: string;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const stored = storedConnection();
  const events: { channel: string; payload: unknown }[] = [];
  const emit = ((channel: string, payload: unknown) => {
    events.push({ channel, payload });
  }) as unknown as MainEventEmitter;

  const connections = new ConnectionManager({
    driver: createPgDriver(),
    findConnection: (connectionId) => (connectionId === CONNECTION_ID ? stored : undefined),
    // Stands in for SettingsStore.secretFor + safeStorage: the plaintext lives in
    // the environment for the lifetime of the process and nowhere else.
    secretFor: () => config?.password ?? null,
  });

  const exportDir = options.exportDir ?? join(tmpdir(), `tabby-export-${hrtime.bigint()}`);
  mkdirSync(exportDir, { recursive: true });

  const schemas = new SchemaService({ connections });
  const queries = new QueryService({
    connections,
    schemas,
    emit,
    limits: options.limits,
  });
  const exports = new ExportService({
    connections,
    queries,
    emit,
    // Stands in for `dialog.showSaveDialog`, which cannot be driven headlessly.
    // The suggested name is honoured so a spec can predict the path.
    pickPath: async (suggested) => join(exportDir, suggested),
  });

  return {
    connections,
    schemas,
    queries,
    exports,
    events,
    exportDir,
    dispose: async () => {
      await exports.cancelAll();
      schemas.dropConnection(CONNECTION_ID);
      await connections.closeAll();
    },
  };
}

/**
 * Milliseconds with microsecond resolution, monotonic. `Date.now()` can step
 * backwards under NTP, and whole-millisecond rounding reports a genuinely fast
 * prefetch hit as `0.0ms`, which is not a measurement.
 */
export function now(): number {
  return Number(hrtime.bigint()) / 1e6;
}

/**
 * Prints a measurement when `TABBY_REPORT_PERF=1`, silent otherwise.
 *
 * The assertions check the budget; this reports what was actually achieved, so a
 * phase's exit-criteria table can quote a measurement instead of a bound. Off by
 * default because a test run should not be noisy.
 */
export function report(label: string, ms: number): void {
  if (env['TABBY_REPORT_PERF'] === '1') {
    console.warn(`[perf] ${label}: ${ms.toFixed(1)}ms`);
  }
}
