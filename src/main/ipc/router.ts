import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { err, ok, scrub, type Result } from '../../shared/errors';
import { IpcChannel, type SettingsSnapshot } from '../../shared/ipc-contract';
import type { WindowState } from '../../shared/domain';
import { logError, logInfo, logRejectedPayload } from '../log';
import type { SettingsStore } from '../store/settings-store';
import type { ConnectionManager } from '../db/connection-manager';
import type { QueryService } from '../db/query-service';
import type { SchemaService } from '../db/schema-service';
import {
  ValidationError,
  validateConnSave,
  validateConnectionId,
  validateQueryRun,
  validateResultId,
  validateResultSort,
  validateResultWindow,
  validateSchemaChildren,
  validateSchemaTable,
  validateSettingsPatch,
} from './validate';

export interface RouterServices {
  readonly settings: SettingsStore;
  readonly window: () => BrowserWindow | null;
  readonly connections: ConnectionManager;
  readonly schemas: SchemaService;
  readonly queries: QueryService;
}

const SCOPE = 'ipc';

type Handler<T> = (input: T) => Result<unknown> | Promise<Result<unknown>>;

/**
 * Registers every invoke-style IPC channel.
 *
 * Three invariants hold for all of them, and they are the reason this file
 * exists rather than scattering `ipcMain.handle` calls around:
 *
 *  1. **Every payload is validated before a handler sees it.** A compromised
 *     renderer must not be able to reach a service with a hostile argument.
 *  2. **Nothing throws across the bridge.** A thrown error loses its shape in
 *     transit, so handlers always return `Result<T>`; the wrapper converts any
 *     escapee into a tagged `INTERNAL` error.
 * 3. **Rejections are logged, but never with the payload.** The log records the
 *     channel and the offending field path. Echoing a rejected body would put
 *     attacker-controlled bytes — possibly a password — into a log file.
 *
 * Returns a disposer so the harness and tests can unregister cleanly.
 */
export function registerIpcHandlers(services: RouterServices): () => void {
  const registered: string[] = [];

  function handle<T>(channel: string, parse: (value: unknown) => T, run: Handler<T>): void {
    ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, payload: unknown) => {
      let input: T;
      try {
        input = parse(payload);
      } catch (error) {
        if (error instanceof ValidationError) {
          logRejectedPayload(SCOPE, channel, error.field, error.message);
          return err({ code: 'VALIDATION_FAILED', field: error.field, message: error.message });
        }
        logError(channel, error);
        return err({ code: 'INTERNAL', message: 'payload validation failed' });
      }

      try {
        return await run(input);
      } catch (error) {
        // Never forward a stack trace or a connection string to the renderer.
        logError(channel, error);
        const message = error instanceof Error ? error.message : String(error);
        return err({ code: 'INTERNAL', message: scrub(message) });
      }
    });
    registered.push(channel);
  }

  function snapshot(): SettingsSnapshot {
    const current = services.settings.current;
    return {
      connections: services.settings.listConnections(),
      window: current.window,
      theme: current.theme,
      loadWarning: services.settings.loadWarning,
    };
  }

  function windowState(): WindowState {
    const win = services.window();
    if (!win || win.isDestroyed()) return services.settings.current.window;
    const bounds = win.getNormalBounds();
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    };
  }

  // ── Settings & window ──────────────────────────────────────────────────────
  handle(
    IpcChannel.settingsGet,
    () => undefined,
    () => ok(snapshot()),
  );

  handle(IpcChannel.settingsPatch, validateSettingsPatch, (patch) => {
    services.settings.patch(patch);
    // The live window follows a geometry change so the user sees it immediately.
    const win = services.window();
    if (patch.window && win && !win.isDestroyed()) {
      applyWindowState(win, patch.window);
    }
    return ok(snapshot());
  });

  handle(
    IpcChannel.windowState,
    () => undefined,
    () => ok(windowState()),
  );

  // ── Connections ────────────────────────────────────────────────────────────
  handle(
    IpcChannel.connList,
    () => undefined,
    () => ok(services.settings.listConnections()),
  );

  handle(IpcChannel.connSave, validateConnSave, (request) => {
    const result = services.settings.saveConnection(request);
    if (result.ok) logInfo(SCOPE, `saved connection ${result.value.id}`);
    return result;
  });

  handle(IpcChannel.connDelete, validateConnectionId, (connectionId) => {
    // Dropping the stored connection cannot leave a live session behind: it would
    // keep a pool — and an xmin horizon on the server — for a connection the user
    // believes is gone.
    const stored = services.settings.deleteConnection(connectionId);
    if (stored.ok) void services.connections.close(connectionId);
    return stored;
  });

  handle(IpcChannel.connTest, validateConnectionId, (connectionId) =>
    services.connections.test(connectionId),
  );

  handle(IpcChannel.connOpen, validateConnectionId, async (connectionId) => {
    const opened = await services.connections.open(connectionId);
    // The renderer gets nothing back but success: a PgSession is a live socket and
    // must never cross the bridge.
    return opened.ok ? ok(undefined) : err<void>(opened.error);
  });

  handle(IpcChannel.connClose, validateConnectionId, async (connectionId) => {
    services.queries.dropConnection(connectionId);
    services.schemas.dropConnection(connectionId);
    return services.connections.close(connectionId);
  });

  // ── Schema ─────────────────────────────────────────────────────────────────
  handle(IpcChannel.schemaChildren, validateSchemaChildren, (request) =>
    services.schemas.childrenOf(request.connectionId, request.parentSchema),
  );

  handle(IpcChannel.schemaTable, validateSchemaTable, (request) =>
    services.schemas.tableOf(request.connectionId, request.schema, request.table),
  );

  handle(IpcChannel.schemaRefresh, validateConnectionId, (connectionId) =>
    ok(services.schemas.refresh(connectionId)),
  );

  // ── Queries and results ────────────────────────────────────────────────────
  handle(IpcChannel.queryRun, validateQueryRun, (request) => services.queries.run(request));

  handle(IpcChannel.queryCancel, validateResultId, (resultId) => services.queries.cancel(resultId));

  handle(IpcChannel.resultMeta, validateResultId, (resultId) => services.queries.meta(resultId));

  handle(IpcChannel.resultWindow, validateResultWindow, (request) =>
    services.queries.window(request),
  );

  handle(IpcChannel.resultSort, validateResultSort, (request) => services.queries.sort(request));

  handle(IpcChannel.resultDispose, validateResultId, (resultId) =>
    services.queries.dispose(resultId),
  );

  logInfo(SCOPE, `registered ${registered.length} channels`);

  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel);
    registered.length = 0;
  };
}

/** Restores persisted geometry, ignoring a fullscreen/maximized request that would fight the WM. */
export function applyWindowState(win: BrowserWindow, state: WindowState): void {
  if (state.isFullScreen) {
    win.setFullScreen(true);
    return;
  }
  if (win.isFullScreen()) win.setFullScreen(false);

  win.setBounds({ x: state.x, y: state.y, width: state.width, height: state.height });
  if (state.isMaximized) win.maximize();
  else win.unmaximize();
}
