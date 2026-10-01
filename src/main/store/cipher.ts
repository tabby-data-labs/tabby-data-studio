import { safeStorage } from 'electron';

export interface SecretCipher {
  /** False when the OS keychain is unreachable, e.g. Linux without a keyring. */
  readonly available: boolean;
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * `safeStorage`-backed cipher: Keychain on macOS, DPAPI on Windows, libsecret on
 * Linux. Zero third-party crypto, which is the whole reason to use it.
 *
 * The important decision is what happens when encryption is **unavailable**.
 * The answer is to refuse rather than fall back to plaintext: a database
 * password written to a JSON file in cleartext is a credential leak that outlives
 * the session, and the user cannot see it happen. Callers must surface
 * `available === false` as an explicit error so the user knows to configure a
 * keyring.
 */
export const safeStorageCipher: SecretCipher = {
  get available(): boolean {
    return safeStorage.isEncryptionAvailable();
  },

  encrypt(plaintext: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS keychain unavailable; refusing to store a password in plaintext');
    }
    return safeStorage.encryptString(plaintext).toString('base64');
  },

  decrypt(ciphertext: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS keychain unavailable; cannot decrypt a stored password');
    }
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  },
};
