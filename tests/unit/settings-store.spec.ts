/**
 * Settings persistence (PLAN Phase 3, ARCHITECTURE §9).
 *
 * The properties that matter are security and durability, not convenience:
 * a password must never touch disk in plaintext, a summary handed to the
 * renderer must never carry secret material, an acknowledged write must survive
 * a crash, and a corrupt settings file must cost the user their settings rather
 * than the application.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SettingsStore,
} from '../../src/main/store/settings-store';
import type { SecretCipher } from '../../src/main/store/cipher';
import type { ConnSaveRequest } from '../../src/shared/ipc-contract';

/** Deterministic stand-in for safeStorage: reversible, and visibly not plaintext. */
function fakeCipher(available = true): SecretCipher & { decryptions: number } {
  const state = { decryptions: 0 };
  return {
    get available() {
      return available;
    },
    get decryptions() {
      return state.decryptions;
    },
    encrypt: (plaintext) => `enc(${Buffer.from(plaintext, 'utf8').toString('base64')})`,
    decrypt: (ciphertext) => {
      state.decryptions += 1;
      const inner = ciphertext.slice(4, -1);
      return Buffer.from(inner, 'base64').toString('utf8');
    },
  };
}

function connection(overrides: Partial<ConnSaveRequest['connection']> = {}): ConnSaveRequest {
  return {
    connection: {
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
    },
    password: 'hunter2',
  };
}

let dir: string;

function store(cipher: SecretCipher = fakeCipher()): SettingsStore {
  return new SettingsStore({ dir, cipher });
}

function settingsFile(): string {
  return join(dir, 'settings.json');
}

function rawSettings(): string {
  return readFileSync(settingsFile(), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabby-settings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('secrets at rest', () => {
  it('never writes the plaintext password to disk', () => {
    store().saveConnection(connection());
    expect(rawSettings()).not.toContain('hunter2');
  });

  it('stores ciphertext instead', () => {
    store().saveConnection(connection());
    const parsed = JSON.parse(rawSettings()) as {
      connections: { encryptedPassword: string }[];
    };
    expect(parsed.connections[0]?.encryptedPassword).toBe('enc(aHVudGVyMg==)');
  });

  it('round-trips the secret through secretFor', () => {
    const s = store();
    s.saveConnection(connection());
    expect(s.secretFor('c1')).toBe('hunter2');
  });

  it('returns null for a connection with no password', () => {
    const s = store();
    s.saveConnection({ connection: connection().connection });
    expect(s.secretFor('c1')).toBeNull();
  });

  it('returns null rather than throwing when decryption fails', () => {
    const cipher = fakeCipher();
    const s = store(cipher);
    s.saveConnection(connection());
    // Simulate a keychain change: the stored blob can no longer be decrypted.
    const broken: SecretCipher = {
      available: true,
      encrypt: cipher.encrypt,
      decrypt: () => {
        throw new Error('keychain changed');
      },
    };
    const reopened = new SettingsStore({ dir, cipher: broken });
    expect(reopened.secretFor('c1')).toBeNull();
  });

  it('refuses to store a password when the keychain is unavailable', () => {
    const result = store(fakeCipher(false)).saveConnection(connection());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('KEYCHAIN_UNAVAILABLE');
    // Nothing was persisted at all, so no plaintext reached the disk either.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('still saves the connection when no password is requested and the keychain is down', () => {
    const result = store(fakeCipher(false)).saveConnection({ connection: connection().connection });
    expect(result.ok).toBe(true);
  });
});

describe('what the renderer is allowed to see', () => {
  it('strips the ciphertext from every summary', () => {
    const s = store();
    s.saveConnection(connection());
    const [summary] = s.listConnections();
    expect(summary).toBeDefined();
    expect(Object.keys(summary ?? {})).not.toContain('encryptedPassword');
    expect(Object.keys(summary ?? {})).not.toContain('password');
    expect(JSON.stringify(s.listConnections())).not.toContain('enc(');
  });

  it('exposes the fields the UI needs', () => {
    const s = store();
    s.saveConnection(connection());
    expect(s.listConnections()[0]).toEqual({
      id: 'c1',
      name: 'Local',
      host: 'localhost',
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      sslMode: 'prefer',
      createdAt: 1_700_000_000_000,
      updatedAt: expect.any(Number),
    });
  });
});

describe('editing and deleting', () => {
  it('keeps the stored credential when only the name changes', () => {
    const s = store();
    s.saveConnection(connection());
    s.saveConnection({ connection: connection({ name: 'Renamed' }).connection });

    expect(s.listConnections()[0]?.name).toBe('Renamed');
    expect(s.secretFor('c1')).toBe('hunter2');
  });

  it('preserves the original createdAt on update', () => {
    const s = store();
    s.saveConnection(connection());
    s.saveConnection({ connection: connection({ name: 'Renamed' }).connection });
    expect(s.listConnections()[0]?.createdAt).toBe(1_700_000_000_000);
  });

  it('replaces a password when a new one is supplied', () => {
    const s = store();
    s.saveConnection(connection());
    s.saveConnection(connection({ name: 'Local' } as never));
    s.saveConnection({ connection: connection().connection, password: 'new-secret' });
    expect(s.secretFor('c1')).toBe('new-secret');
    expect(rawSettings()).not.toContain('new-secret');
  });

  it('deletes a connection and persists the deletion', () => {
    const s = store();
    s.saveConnection(connection());
    expect(s.deleteConnection('c1').ok).toBe(true);
    expect(s.listConnections()).toEqual([]);
    expect(store().listConnections()).toEqual([]);
  });

  it('reports NOT_FOUND for an unknown id', () => {
    const result = store().deleteConnection('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('durability', () => {
  it('leaves no temp file behind after a commit', () => {
    const s = store();
    s.saveConnection(connection());
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('persists across a reopen', () => {
    const s = store();
    s.saveConnection(connection());
    s.patch({ theme: 'light' });

    const reopened = store();
    expect(reopened.listConnections()).toHaveLength(1);
    expect(reopened.current.theme).toBe('light');
  });

  it('writes valid, parseable JSON', () => {
    store().saveConnection(connection());
    expect(() => JSON.parse(rawSettings())).not.toThrow();
  });
});

describe('patch', () => {
  it('persists a theme change', () => {
    const s = store();
    expect(s.patch({ theme: 'light' }).theme).toBe('light');
    expect(store().current.theme).toBe('light');
  });

  it('persists window geometry', () => {
    const window = {
      x: 10,
      y: 20,
      width: 1200,
      height: 800,
      isMaximized: true,
      isFullScreen: false,
    };
    const s = store();
    s.patch({ window });
    expect(store().current.window).toEqual(window);
  });

  it('leaves untouched fields alone', () => {
    const s = store();
    s.saveConnection(connection());
    s.patch({ theme: 'light' });
    expect(store().listConnections()).toHaveLength(1);
  });

  it('accepts an empty patch', () => {
    expect(store().patch({})).toEqual(DEFAULT_SETTINGS);
  });
});

describe('corrupt and hand-edited files', () => {
  it('starts from defaults when no file exists', () => {
    const s = store();
    expect(s.current).toEqual(DEFAULT_SETTINGS);
    expect(s.loadWarning).toBeNull();
  });

  it('recovers from invalid JSON instead of throwing', () => {
    writeFileSync(settingsFile(), '{ this is not json', 'utf8');
    const s = store();
    expect(s.current).toEqual(DEFAULT_SETTINGS);
    expect(s.loadWarning).toMatch(/corrupt/);
  });

  it('recovers from a JSON array', () => {
    writeFileSync(settingsFile(), '[1,2,3]', 'utf8');
    expect(store().current).toEqual(DEFAULT_SETTINGS);
  });

  it('drops a malformed connection but keeps the valid ones', () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        version: SETTINGS_VERSION,
        connections: [
          {
            id: 'good',
            name: 'Good',
            host: 'h',
            port: 5432,
            database: 'd',
            user: 'u',
            sslMode: 'prefer',
            encryptedPassword: null,
            createdAt: 1,
            updatedAt: 1,
          },
          { id: 'bad', name: 42 },
        ],
        window: { x: 0, y: 0, width: 800, height: 600, isMaximized: false, isFullScreen: false },
        theme: 'dark',
      }),
      'utf8',
    );
    const s = store();
    expect(s.listConnections().map((c) => c.id)).toEqual(['good']);
  });

  it('falls back to defaults for an invalid theme and window', () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({ version: SETTINGS_VERSION, theme: 'solarised', window: { x: 'nope' } }),
      'utf8',
    );
    const s = store();
    expect(s.current.theme).toBe('dark');
    expect(s.current.window).toEqual(DEFAULT_SETTINGS.window);
  });

  it('creates the directory if it does not exist', () => {
    const nested = join(dir, 'a', 'b');
    const s = new SettingsStore({ dir: nested, cipher: fakeCipher() });
    expect(s.patch({ theme: 'light' }).theme).toBe('light');
    expect(readFileSync(join(nested, 'settings.json'), 'utf8')).toContain('light');
  });
});
