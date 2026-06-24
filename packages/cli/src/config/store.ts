import { KeychainUnavailableError, SecureStorageRequiredError } from "./errors.js";
import { DEFAULT_PROFILE, type StoredCredential } from "./schema.js";

// A single credential backend (one place a credential can live). Backends compose into a
// CredentialStore via resolveStore, modeled on the git-style external-credential-helper
// pattern: read precedence is backend order; writes go to the first eligible writable
// backend. `secure` marks OS-protected storage (keychain) vs the insecure 0600 file.
export interface CredentialBackend {
  readonly id: string;
  readonly secure: boolean;
  readonly canWrite: boolean;
  /**
   * Whether this backend persists NON-secret config (the active profile + the per-profile base URL).
   * The keychain holds secrets only (`false`) — config writes route past it to the file (`true`), so a
   * keychain composed AHEAD of the file doesn't swallow non-secret config.
   */
  readonly persistsConfig: boolean;
  /** The persisted active-profile name (config, not per-profile), or undefined when unset. */
  getActiveProfile(): Promise<string | undefined>;
  /** Persist (or, with undefined, clear) the active-profile name (a writable backend only). */
  setActiveProfile(name: string | undefined): Promise<void>;
  get(profile: string): Promise<StoredCredential | null>;
  set(profile: string, cred: StoredCredential): Promise<void>;
  erase(profile: string): Promise<void>;
  list(): Promise<string[]>;
  /** The persisted per-profile API base URL, or undefined when unset (config, not a secret). */
  getApiBaseUrl(profile: string): Promise<string | undefined>;
  /** Persist the per-profile API base URL (a writable backend only). */
  setApiBaseUrl(profile: string, apiBaseUrl: string): Promise<void>;
}

export interface StoragePolicy {
  /** When true, refuse to persist a credential to a non-secure backend (the 0600 file). */
  readonly requireSecureStorage: boolean;
}

/** Per-call credential-write options. */
export interface SetCredentialOptions {
  /** Force acceptance of an insecure (file) backend even under `requireSecureStorage` (the `--insecure-storage` opt-in). */
  readonly allowInsecure?: boolean;
}

export interface CredentialStore {
  get(profile?: string): Promise<StoredCredential | null>;
  /**
   * The stored credential AND which backend served it (the backend `id`: "env" | "keychain" | "file"), or
   * null when none. Lets `doctor`/`whoami` report the REAL source — a keychain credential is "keychain",
   * not mislabeled "file". Optional so the many inline in-memory test fakes need not implement it; callers
   * fall back to a generic label when it's absent.
   */
  getWithSource?(profile?: string): Promise<{ cred: StoredCredential; source: string } | null>;
  set(cred: StoredCredential, profile?: string, opts?: SetCredentialOptions): Promise<void>;
  erase(profile?: string): Promise<void>;
  list(): Promise<string[]>;
  /**
   * The persisted active profile (first backend that has one), or undefined when unset. Optional so the
   * many inline in-memory `CredentialStore` test fakes need not implement it; absent → resolves to the
   * default profile.
   */
  getActiveProfile?(): Promise<string | undefined>;
  /** Persist (or clear, with undefined) the active profile to the first writable backend. Optional for
   *  the same reason as getActiveProfile (inline test fakes); the real store always implements it. */
  setActiveProfile?(name: string | undefined): Promise<void>;
  /** The sticky per-profile API base URL (read precedence = backend order), or undefined when unset. */
  getApiBaseUrl(profile?: string): Promise<string | undefined>;
  /** Persist the sticky per-profile API base URL to the first writable backend. */
  setApiBaseUrl(apiBaseUrl: string, profile?: string): Promise<void>;
}

export function resolveStore(
  backends: readonly CredentialBackend[],
  policy: StoragePolicy,
): CredentialStore {
  return {
    async getActiveProfile() {
      for (const backend of backends) {
        const hit = await backend.getActiveProfile();
        if (hit !== undefined) return hit;
      }
      return undefined;
    },
    async setActiveProfile(name) {
      // The active profile is config (not a secret), so it persists to the first writable backend that
      // PERSISTS CONFIG — skipping a secrets-only backend (the keychain) composed ahead of the file.
      const target = backends.find((b) => b.canWrite && b.persistsConfig);
      if (!target) throw new SecureStorageRequiredError();
      await target.setActiveProfile(name);
    },
    async get(profile = DEFAULT_PROFILE) {
      for (const backend of backends) {
        let hit: StoredCredential | null;
        try {
          hit = await backend.get(profile);
        } catch (err) {
          // A missing OS keychain has no credential to offer — skip it and read the next backend
          // (so a no-keychain box still reads the env/file). Any other read error is real.
          if (err instanceof KeychainUnavailableError) continue;
          throw err;
        }
        if (hit) return hit;
      }
      return null;
    },
    async getWithSource(profile = DEFAULT_PROFILE) {
      // Same read precedence as get(), but report WHICH backend served the credential (its id) so the
      // diagnostics show the real source instead of guessing "file" for a keychain credential.
      for (const backend of backends) {
        let hit: StoredCredential | null;
        try {
          hit = await backend.get(profile);
        } catch (err) {
          if (err instanceof KeychainUnavailableError) continue;
          throw err;
        }
        if (hit) return { cred: hit, source: backend.id };
      }
      return null;
    },
    async set(cred, profile = DEFAULT_PROFILE, opts) {
      const writable = backends.filter((b) => b.canWrite);
      // Under require-secure (unless --insecure-storage opts out), only secure backends are eligible.
      const secureOnly = policy.requireSecureStorage && opts?.allowInsecure !== true;
      const candidates = secureOnly ? writable.filter((b) => b.secure) : writable;
      // No eligible writable backend → refuse rather than silently drop or downgrade.
      if (candidates.length === 0) throw new SecureStorageRequiredError();
      // Try candidates in precedence order. ONLY a missing OS keychain (KeychainUnavailableError) falls
      // through to the next candidate — so the default policy degrades from keychain to the file, while
      // require-secure (candidates = secure only) has nothing to fall through to and fails loud. Any other
      // failure (denied, locked, write error) is real and propagates — never a silent insecure downgrade.
      let lastUnavailable: KeychainUnavailableError | undefined;
      for (const target of candidates) {
        try {
          await target.set(profile, cred);
          return;
        } catch (err) {
          if (err instanceof KeychainUnavailableError) {
            lastUnavailable = err;
            continue;
          }
          throw err;
        }
      }
      throw lastUnavailable ?? new SecureStorageRequiredError();
    },
    async erase(profile = DEFAULT_PROFILE) {
      // Best-effort across every writable backend so logout clears the credential EVERYWHERE. A missing
      // OS keychain (KeychainUnavailableError) must not abort the wipe — the file still gets cleared, so
      // no stale secret is left behind. Any other error is real and propagates.
      for (const backend of backends) {
        if (!backend.canWrite) continue;
        try {
          await backend.erase(profile);
        } catch (err) {
          if (!(err instanceof KeychainUnavailableError)) throw err;
        }
      }
    },
    async list() {
      const names = new Set<string>();
      for (const backend of backends) {
        for (const name of await backend.list()) names.add(name);
      }
      return [...names];
    },
    async getApiBaseUrl(profile = DEFAULT_PROFILE) {
      for (const backend of backends) {
        const hit = await backend.getApiBaseUrl(profile);
        if (hit !== undefined) return hit;
      }
      return undefined;
    },
    async setApiBaseUrl(apiBaseUrl, profile = DEFAULT_PROFILE) {
      // The base URL is configuration, not a secret, so it persists to the first writable CONFIG backend
      // (skipping a secrets-only keychain ahead of the file); the secure-storage policy governs only the
      // CREDENTIAL location.
      const target = backends.find((b) => b.canWrite && b.persistsConfig);
      if (!target) throw new SecureStorageRequiredError();
      await target.setApiBaseUrl(profile, apiBaseUrl);
    },
  };
}
