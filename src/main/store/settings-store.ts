import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { err, ok, scrub, type Result } from '../../shared/errors';
import type {
  AppSettings,
  ConnectionSummary,
  SettingsPatch,
  StoredConnection,
  WindowState,
} from '../../shared/domain';
import type { ConnSaveRequest } from '../../shared/ipc-contract';
import type { SecretCipher } from './cipher';

export const SETTINGS_VERSION = 1;
const FILE_NAME = 'settings.json';

export const DEFAULT_WINDOW: WindowState = {
  x: 0,
  y: 0,
  width: 1440,
  height: 900,
  isMaximized: false,
  isFullScreen: false,
};

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  connections: [],
  window: DEFAULT_WINDOW,
  theme: 'dark',
};

export interface SettingsStoreOptions {
  readonly dir: string;
  readonly cipher: SecretCipher;
}

function toSummary(connection: StoredConnection): ConnectionSummary {
  // Explicit pick, not a spread-and-delete: a new secret field added to
  // StoredConnection later must never leak to the renderer by default.
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    sslMode: connection.sslMode,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/**
 * Persisted app settings, with passwords held as `safeStorage` ciphertext.
 *
 * Two properties are load-bearing and both are tested:
 *
 *  - **Atomic writes.** Write to a sibling temp file, then `rename()`. A crash
 *    mid-write must not leave a truncated settings file that loses every saved
 *    connection.
 *  - **A corrupt file must not make the app unbootable.** Parse or shape errors
 *    fall back to defaults and are reported, rather than throwing during
 *    startup where there is no UI to show the failure in.
 */
export class SettingsStore {
  private readonly dir: string;
  private readonly path: string;
  private readonly cipher: SecretCipher;
  private settings: AppSettings;
  /** Set when the on-disk file was unreadable, so the UI can warn the user. */
  readonly loadWarning: string | null;

  constructor(options: SettingsStoreOptions) {
    this.dir = options.dir;
    this.path = join(options.dir, FILE_NAME);
    this.cipher = options.cipher;

    const loaded = this.read();
    this.settings = loaded.settings;
    this.loadWarning = loaded.warning;
  }

  private read(): { settings: AppSettings; warning: string | null } {
    if (!existsSync(this.path)) return { settings: DEFAULT_SETTINGS, warning: null };

    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      return {
        settings: DEFAULT_SETTINGS,
        warning: `could not read settings: ${scrub(String(error))}`,
      };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return { settings: normalise(parsed), warning: null };
    } catch (error) {
      // Deliberately does not rethrow: a hand-edited or truncated file must cost
      // the user their settings, not the application.
      return {
        settings: DEFAULT_SETTINGS,
        warning: `settings file was corrupt and was reset: ${scrub(String(error))}`,
      };
    }
  }

  get current(): AppSettings {
    return this.settings;
  }

  /** Commits to disk before returning, so a crash cannot lose an acknowledged write. */
  private commit(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }

  patch(patch: SettingsPatch): AppSettings {
    this.settings = {
      ...this.settings,
      ...(patch.theme === undefined ? {} : { theme: patch.theme }),
      ...(patch.window === undefined ? {} : { window: patch.window }),
    };
    this.commit();
    return this.settings;
  }

  listConnections(): readonly ConnectionSummary[] {
    return this.settings.connections.map(toSummary);
  }

  saveConnection(request: ConnSaveRequest): Result<ConnectionSummary> {
    const wantsSecret = request.password !== undefined && request.password !== '';

    if (wantsSecret && !this.cipher.available) {
      return err<ConnectionSummary>({
        code: 'KEYCHAIN_UNAVAILABLE',
        message:
          'The OS keychain is unavailable, so the password cannot be stored safely. ' +
          'Save the connection without a password, or configure a system keyring.',
      });
    }

    const now = Date.now();
    const existing = this.settings.connections.find((c) => c.id === request.connection.id);
    const id = existing ? existing.id : request.connection.id || randomUUID();

    const stored: StoredConnection = {
      id,
      name: request.connection.name,
      host: request.connection.host,
      port: request.connection.port,
      database: request.connection.database,
      user: request.connection.user,
      sslMode: request.connection.sslMode,
      // Keep the previous ciphertext when no new password is supplied, so editing
      // a connection's name does not silently drop its credential.
      encryptedPassword: wantsSecret
        ? this.cipher.encrypt(request.password as string)
        : (existing?.encryptedPassword ?? null),
      createdAt: existing?.createdAt ?? request.connection.createdAt ?? now,
      updatedAt: now,
    };

    const connections = this.settings.connections.filter((c) => c.id !== id);
    connections.push(stored);
    this.settings = { ...this.settings, connections };
    this.commit();

    return ok(toSummary(stored));
  }

  deleteConnection(connectionId: string): Result<void> {
    const before = this.settings.connections.length;
    const connections = this.settings.connections.filter((c) => c.id !== connectionId);
    if (connections.length === before) {
      return err<void>({ code: 'NOT_FOUND', message: `no connection with id ${connectionId}` });
    }
    this.settings = { ...this.settings, connections };
    this.commit();
    return ok(undefined);
  }

  /**
   * Decrypted secret, for the main process only at connect time. Never crosses
   * IPC, and never appears in a log line.
   */
  secretFor(connectionId: string): string | null {
    const connection = this.settings.connections.find((c) => c.id === connectionId);
    if (!connection?.encryptedPassword) return null;
    try {
      return this.cipher.decrypt(connection.encryptedPassword);
    } catch {
      // A keychain that has changed since the password was saved (new user,
      // restored backup) lands here. Treat it as "no password" and let the
      // connection fail on auth with a clear message.
      return null;
    }
  }
}

/**
 * Coerces whatever was on disk into a valid AppSettings. Tolerates a partial or
 * hand-edited file instead of rejecting the whole thing, because losing every
 * saved connection over one bad field is the worse outcome.
 */
function normalise(parsed: Partial<AppSettings> | null): AppSettings {
  if (parsed === null || typeof parsed !== 'object') return DEFAULT_SETTINGS;

  const connections = Array.isArray(parsed.connections)
    ? parsed.connections.filter(isStoredConnection)
    : [];

  const window = isWindowState(parsed.window) ? parsed.window : DEFAULT_WINDOW;
  const theme = parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'dark';

  return { version: SETTINGS_VERSION, connections, window, theme };
}

function isWindowState(value: unknown): value is WindowState {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    Number.isFinite(w['x']) &&
    Number.isFinite(w['y']) &&
    Number.isFinite(w['width']) &&
    Number.isFinite(w['height']) &&
    typeof w['isMaximized'] === 'boolean' &&
    typeof w['isFullScreen'] === 'boolean'
  );
}

function isStoredConnection(value: unknown): value is StoredConnection {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c['id'] === 'string' &&
    typeof c['name'] === 'string' &&
    typeof c['host'] === 'string' &&
    typeof c['port'] === 'number' &&
    typeof c['database'] === 'string' &&
    typeof c['user'] === 'string' &&
    typeof c['sslMode'] === 'string' &&
    (c['encryptedPassword'] === null || typeof c['encryptedPassword'] === 'string')
  );
}
