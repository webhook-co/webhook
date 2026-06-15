import { SecureStorageRequiredError } from "./errors.js";
import { DEFAULT_PROFILE, type StoredCredential } from "./schema.js";

// A single credential backend (one place a credential can live). Backends compose into a
// CredentialStore via resolveStore, modeled on the git-style external-credential-helper
// pattern: read precedence is backend order; writes go to the first eligible writable
// backend. `secure` marks OS-protected storage (keychain) vs the insecure 0600 file.
export interface CredentialBackend {
  readonly id: string;
  readonly secure: boolean;
  readonly canWrite: boolean;
  get(profile: string): Promise<StoredCredential | null>;
  set(profile: string, cred: StoredCredential): Promise<void>;
  erase(profile: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface StoragePolicy {
  /** When true, refuse to persist a credential to a non-secure backend (the 0600 file). */
  readonly requireSecureStorage: boolean;
}

export interface CredentialStore {
  get(profile?: string): Promise<StoredCredential | null>;
  set(cred: StoredCredential, profile?: string): Promise<void>;
  erase(profile?: string): Promise<void>;
  list(): Promise<string[]>;
}

export function resolveStore(
  backends: readonly CredentialBackend[],
  policy: StoragePolicy,
): CredentialStore {
  return {
    async get(profile = DEFAULT_PROFILE) {
      for (const backend of backends) {
        const hit = await backend.get(profile);
        if (hit) return hit;
      }
      return null;
    },
    async set(cred, profile = DEFAULT_PROFILE) {
      const writable = backends.filter((b) => b.canWrite);
      const candidates = policy.requireSecureStorage ? writable.filter((b) => b.secure) : writable;
      const target = candidates[0];
      // No eligible writable backend → refuse rather than silently drop or downgrade.
      if (!target) throw new SecureStorageRequiredError();
      await target.set(profile, cred);
    },
    async erase(profile = DEFAULT_PROFILE) {
      for (const backend of backends) {
        if (backend.canWrite) await backend.erase(profile);
      }
    },
    async list() {
      const names = new Set<string>();
      for (const backend of backends) {
        for (const name of await backend.list()) names.add(name);
      }
      return [...names];
    },
  };
}
