/**
 * Wires the data layer together (PLAN Phase 4).
 *
 * One place constructs the connection manager, the schema cache and the query
 * service, so the app entry point and the smoke harness get exactly the same
 * object graph — a harness that wires its own would silently test a different
 * configuration from the one that ships.
 */
import type { StoredConnection } from '../../shared/domain';
import type { MainEventEmitter } from '../../shared/ipc-contract';
import type { SettingsStore } from '../store/settings-store';
import { ConnectionManager } from './connection-manager';
import { createPgDriver } from './driver-pg';
import { QueryService } from './query-service';
import { SchemaService } from './schema-service';
import type { SessionLimits } from './session';

export interface DbServicesDeps {
  readonly settings: SettingsStore;
  /** main → renderer events. The harness passes a recorder instead of a window. */
  readonly emit: MainEventEmitter;
  readonly limits?: Partial<SessionLimits>;
}

export interface DbServices {
  readonly connections: ConnectionManager;
  readonly schemas: SchemaService;
  readonly queries: QueryService;
  /** Closes every session. Called on quit; never throws, so shutdown cannot stall. */
  dispose(): Promise<void>;
}

export function createDbServices(deps: DbServicesDeps): DbServices {
  const connections = new ConnectionManager({
    driver: createPgDriver(),
    findConnection: (connectionId: string): StoredConnection | undefined =>
      deps.settings.current.connections.find((connection) => connection.id === connectionId),
    secretFor: (connectionId: string) => deps.settings.secretFor(connectionId),
    limits: deps.limits,
  });

  const schemas = new SchemaService({ connections });
  const queries = new QueryService({ connections, schemas, emit: deps.emit });

  return {
    connections,
    schemas,
    queries,
    dispose: async () => {
      // Order matters. A live result holds a checked-out pool client for its whole
      // life, and `pool.end()` waits for every client to come back — so closing
      // connections first would block until a grace timer force-exited the process.
      // Draining the registry, then awaiting the releases, makes shutdown prompt.
      queries.registry.clear();
      await queries.drain();
      await connections.closeAll();
    },
  };
}
