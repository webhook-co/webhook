import { BackendNotWritableError } from "./errors.js";
import type { CredentialBackend } from "./store.js";

/** Env var that supplies the API key headlessly (CI path). Never persisted. */
export const ENV_API_KEY_VAR = "WBHK_API_KEY";

// The read-only env-var backend. Highest read precedence: a key in the environment wins
// over any on-disk profile (the standard CI/headless override). It cannot be written —
// the OS keychain is broken in headless contexts, so CI uses the CI secret store → env.
export function createEnvBackend(
  env: Readonly<Record<string, string | undefined>>,
  varName: string = ENV_API_KEY_VAR,
): CredentialBackend {
  const id = "env";
  return {
    id,
    secure: false,
    canWrite: false,
    persistsConfig: false, // a read-only override that holds no config
    // The env backend has no concept of a persisted active profile (it's a single global override).
    async getActiveProfile() {
      return undefined;
    },
    async setActiveProfile() {
      throw new BackendNotWritableError(id);
    },
    async get() {
      const value = env[varName];
      return value !== undefined && value.length > 0 ? { apiKey: value } : null;
    },
    async set() {
      throw new BackendNotWritableError(id);
    },
    async erase() {
      throw new BackendNotWritableError(id);
    },
    async list() {
      return [];
    },
    // The env backend carries no base URL — WBHK_API_URL is resolved directly by resolveApiBaseUrl
    // (its own precedence rung), not surfaced through the credential store.
    async getApiBaseUrl() {
      return undefined;
    },
    async setApiBaseUrl() {
      throw new BackendNotWritableError(id);
    },
  };
}
