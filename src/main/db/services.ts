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
import { ExportService } from '../export/export-service';
import type { SavePathPicker } from '../export/save-dialog';
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
  /**
   * The save dialog, required rather than defaulted.
   *
   * It is the only route by which a file path reaches the export service, so a
   * silent default — a stub that returns null, or one that writes somewhere
   * convenient — would quietly change what the app is allowed to touch. Making it
   * a required dependency means every entry point has to decide, and the compiler
   * lists the ones that have not.
   */
  readonly pickPath: SavePathPicker;
}

export interface DbServices {
  readonly connections: ConnectionManager;
  readonly schemas: SchemaService;
  readonly queries: QueryService;
  readonly exports: ExportService;
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
  const exports = new ExportService({
    connections,
    queries,
    emit: deps.emit,
    pickPath: deps.pickPath,
  });

  return {
    connections,
    schemas,
    queries,
    exports,
    dispose: async () => {
      // Order matters. An export and a live result each hold a checked-out pool
      // client for its whole life, and `pool.end()` waits for every client to come
      // back — so closing connections first would block until a grace timer
      // force-exited the process. Exports are cancelled rather than merely awaited:
      // quitting is a decision to stop, and waiting out a ten-million-row write is
      // not what the user meant by it.
      await exports.cancelAll();
      queries.registry.clear();
      await queries.drain();
      await connections.closeAll();
    },
  };
}
