/**
 * One `pg` session per saved connection (PLAN Phase 4, ARCHITECTURE §5.1).
 *
 * Lazy, deduplicated and idempotent: two tabs opening the same connection at the
 * same moment must produce one pool, not two, and a second `open()` on an already
 * open connection must not reconnect and lose the session's cursors.
 *
 * This module never touches `pg` — it drives the `PgDriver` interface, which is
 * what makes it testable with a fake and keeps the driver swappable.
 */
import { err, ok, type Result } from '../../shared/errors';
import type { StoredConnection } from '../../shared/domain';
import { logError, logInfo } from '../log';
import { PgConfigError, toPgConfig } from './pg-config';
import { toTabbyError } from './pg-error';
import type { PgDriver, PgSession } from './driver-pg';
import type { SessionLimits } from './session';

const SCOPE = 'conn';

export interface ConnectionManagerDeps {
  readonly findConnection: (connectionId: string) => StoredConnection | undefined;
  readonly secretFor: (connectionId: string) => string | null;
  readonly driver: PgDriver;
  readonly limits?: Partial<SessionLimits>;
}

export interface ConnectionInfo {
  readonly connectionId: string;
  readonly serverVersion: string;
  readonly backendPid: number;
}

export class ConnectionManager {
  private readonly deps: ConnectionManagerDeps;
  private readonly sessions = new Map<string, PgSession>();
  /** In-flight connects, so concurrent opens share one attempt. */
  private readonly opening = new Map<string, Promise<Result<PgSession>>>();
  private readonly versions = new Map<string, string>();

  constructor(deps: ConnectionManagerDeps) {
    this.deps = deps;
  }

  /** Currently open connection ids. */
  openIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

  session(connectionId: string): PgSession | null {
    return this.sessions.get(connectionId) ?? null;
  }

  info(connectionId: string): ConnectionInfo | null {
    const session = this.sessions.get(connectionId);
    if (!session) return null;
    return {
      connectionId,
      serverVersion: this.versions.get(connectionId) ?? session.serverVersion,
      backendPid: session.backendPid,
    };
  }

  /**
   * Opens a connection, or returns the session that is already open.
   *
   * A concurrent second call waits on the same promise rather than building a
   * second pool against the same server.
   */
  open(connectionId: string): Promise<Result<PgSession>> {
    const existing = this.sessions.get(connectionId);
    if (existing) return Promise.resolve(ok(existing));

    const inFlight = this.opening.get(connectionId);
    if (inFlight) return inFlight;

    const attempt = this.connect(connectionId).finally(() => {
      this.opening.delete(connectionId);
    });
    this.opening.set(connectionId, attempt);
    return attempt;
  }

  /** Opens if needed. The path every query takes. */
  requireSession(connectionId: string): Promise<Result<PgSession>> {
    return this.open(connectionId);
  }

  private async connect(connectionId: string): Promise<Result<PgSession>> {
    const stored = this.deps.findConnection(connectionId);
    if (!stored) {
      return err<PgSession>({
        code: 'NOT_FOUND',
        message: `no saved connection with id ${connectionId}`,
        connectionId,
      });
    }

    let config;
    try {
      config = toPgConfig(stored, this.deps.secretFor(connectionId), this.deps.limits);
    } catch (error) {
      // Stored settings that no longer validate (a hand-edited file, a schema
      // change) must be reported, not thrown across the bridge.
      if (error instanceof PgConfigError) {
        return err<PgSession>({
          code: 'VALIDATION_FAILED',
          field: error.field,
          message: error.message,
          connectionId,
        });
      }
      throw error;
    }

    try {
      const session = await this.deps.driver.connect(config, this.deps.limits);
      this.sessions.set(connectionId, session);
      this.versions.set(connectionId, session.serverVersion);
      logInfo(SCOPE, `opened ${connectionId} (${session.serverVersion})`);
      return ok(session);
    } catch (error) {
      logError(`${SCOPE}:open`, error);
      return err<PgSession>(toTabbyError(error, { connectionId }));
    }
  }

  /**
   * Verifies a connection without leaving it open.
   *
   * Distinct from `open()` because "Test" in the UI should not silently start a
   * session that then holds a pool — and an xmin horizon — for the rest of the run.
   */
  async test(connectionId: string): Promise<Result<{ serverVersion: string }>> {
    const existing = this.sessions.get(connectionId);
    if (existing) {
      try {
        await existing.query('select 1');
        return ok({ serverVersion: existing.serverVersion });
      } catch (error) {
        // The session died underneath us: drop it so the next open reconnects.
        await this.close(connectionId);
        return err<{ serverVersion: string }>(toTabbyError(error, { connectionId }));
      }
    }

    const result = await this.open(connectionId);
    if (!result.ok) return err<{ serverVersion: string }>(result.error);
    const version = result.value.serverVersion;
    await this.close(connectionId);
    return ok({ serverVersion: version });
  }

  async close(connectionId: string): Promise<Result<void>> {
    const session = this.sessions.get(connectionId);
    if (!session) {
      return err<void>({
        code: 'NOT_FOUND',
        message: `no open connection with id ${connectionId}`,
        connectionId,
      });
    }

    this.sessions.delete(connectionId);
    this.versions.delete(connectionId);
    try {
      await session.end();
      logInfo(SCOPE, `closed ${connectionId}`);
    } catch (error) {
      // A failure to close is worth a log line and nothing more: the socket is
      // gone either way, and reporting an error here would block window teardown.
      logError(`${SCOPE}:close`, error);
    }
    return ok(undefined);
  }

  /** Called on app quit. Never throws, so shutdown cannot stall. */
  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }
}
