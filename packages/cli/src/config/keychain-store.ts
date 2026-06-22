import { BackendNotWritableError } from "./errors.js";
import { StoredCredentialSchema, type StoredCredential } from "./schema.js";
import type { CredentialBackend } from "./store.js";

// The OS-keychain credential backend: a `secure` (encrypted-at-rest) store for the `whk_` key, composed
// AHEAD of the 0600 file. It holds ONLY the credential — the active profile + base URLs are non-secret
// config and stay in the file (`persistsConfig: false`, so resolveStore routes config past it). The
// actual OS calls live behind the injected `KeychainIo` seam (the macOS `security` / Linux
// `secret-tool` / Windows credential CLIs in io.ts, coverage-excluded); this backend is the thin,
// unit-tested logic over that seam. A missing OS keychain surfaces as `KeychainUnavailableError` from the
// seam, which resolveStore uses to fall back to the file (or, under require-secure, to fail loud).

/** The OS-keychain operations for one logical secret per account (the profile name). */
export interface KeychainIo {
  /** The stored secret for `account`, or null when absent. Throws KeychainUnavailableError if no keychain. */
  get(account: string): Promise<string | null>;
  /** Store (replacing any existing) the secret for `account`. */
  set(account: string, secret: string): Promise<void>;
  /** Remove the secret for `account` (a no-op when absent). */
  erase(account: string): Promise<void>;
}

export function createKeychainBackend(opts: { keychainIo: KeychainIo }): CredentialBackend {
  const id = "keychain";
  return {
    id,
    secure: true,
    canWrite: true,
    persistsConfig: false,
    // Config lives in the file backend, not the keychain — these never run (resolveStore routes config to
    // a persistsConfig backend), but the interface requires them; behave like the read-only env backend.
    async getActiveProfile() {
      return undefined;
    },
    async setActiveProfile() {
      throw new BackendNotWritableError(id);
    },
    async get(profile): Promise<StoredCredential | null> {
      const raw = await opts.keychainIo.get(profile);
      if (raw === null || raw.length === 0) return null;
      // The stored secret is the JSON-serialized credential (supports the OAuth variant). A bare string
      // is a legacy (pre-OAuth) entry that held just the api key → treat it as `{ apiKey }`. A parseable
      // but schema-invalid blob is corrupt → null (cold-start; the user re-logs in).
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { apiKey: raw };
      }
      const result = StoredCredentialSchema.safeParse(parsed);
      return result.success ? result.data : null;
    },
    async set(profile, cred) {
      // Store the whole credential (the OAuth variant carries the refresh token + metadata, not just a key).
      await opts.keychainIo.set(profile, JSON.stringify(cred));
    },
    async erase(profile) {
      await opts.keychainIo.erase(profile);
    },
    // Listing every account for a service isn't portable across the OS CLIs; the file backend's profile
    // list (unioned by resolveStore) is the source of truth for which profiles exist.
    async list() {
      return [];
    },
    async getApiBaseUrl() {
      return undefined;
    },
    async setApiBaseUrl() {
      throw new BackendNotWritableError(id);
    },
  };
}
