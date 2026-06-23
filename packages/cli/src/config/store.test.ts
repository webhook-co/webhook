import { describe, expect, it } from "vitest";

import {
  BackendNotWritableError,
  KeychainUnavailableError,
  SecureStorageRequiredError,
} from "./errors.js";
import { DEFAULT_PROFILE, type StoredCredential } from "./schema.js";
import { type CredentialBackend, resolveStore } from "./store.js";

/** Minimal in-memory backend for exercising the resolver in isolation (no fs). */
function memoryBackend(
  id: string,
  opts: {
    secure: boolean;
    canWrite: boolean;
    seed?: Record<string, StoredCredential>;
    activeProfile?: string;
    /** Whether this backend persists non-secret config (base URL + active profile). Defaults true. */
    persistsConfig?: boolean;
    /** When true, every credential op throws KeychainUnavailableError (a missing OS keychain). */
    unavailable?: boolean;
  },
): CredentialBackend {
  const store = new Map<string, StoredCredential>(Object.entries(opts.seed ?? {}));
  const baseUrls = new Map<string, string>();
  let active = opts.activeProfile;
  return {
    id,
    secure: opts.secure,
    canWrite: opts.canWrite,
    persistsConfig: opts.persistsConfig ?? true,
    async getActiveProfile() {
      return active;
    },
    async setActiveProfile(name) {
      if (!opts.canWrite) throw new BackendNotWritableError(id);
      active = name;
    },
    async get(profile) {
      if (opts.unavailable) throw new KeychainUnavailableError();
      return store.get(profile) ?? null;
    },
    async set(profile, cred) {
      if (opts.unavailable) throw new KeychainUnavailableError();
      if (!opts.canWrite) throw new BackendNotWritableError(id);
      store.set(profile, cred);
    },
    async erase(profile) {
      if (opts.unavailable) throw new KeychainUnavailableError();
      if (!opts.canWrite) throw new BackendNotWritableError(id);
      store.delete(profile);
    },
    async list() {
      return [...store.keys()];
    },
    async getApiBaseUrl(profile) {
      return baseUrls.get(profile);
    },
    async setApiBaseUrl(profile, apiBaseUrl) {
      if (!opts.canWrite) throw new BackendNotWritableError(id);
      baseUrls.set(profile, apiBaseUrl);
    },
  };
}

describe("resolveStore", () => {
  it("reads in precedence order — earlier backends win", async () => {
    const env = memoryBackend("env", {
      secure: false,
      canWrite: false,
      seed: { [DEFAULT_PROFILE]: { apiKey: "whk_env" } },
    });
    const file = memoryBackend("file", {
      secure: false,
      canWrite: true,
      seed: { [DEFAULT_PROFILE]: { apiKey: "whk_file" } },
    });
    const store = resolveStore([env, file], { requireSecureStorage: false });
    await expect(store.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_env" });
  });

  it("falls through to the next backend on a miss", async () => {
    const env = memoryBackend("env", { secure: false, canWrite: false });
    const file = memoryBackend("file", {
      secure: false,
      canWrite: true,
      seed: { [DEFAULT_PROFILE]: { apiKey: "whk_file" } },
    });
    const store = resolveStore([env, file], { requireSecureStorage: false });
    await expect(store.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_file" });
  });

  it("writes to the first writable backend", async () => {
    const env = memoryBackend("env", { secure: false, canWrite: false });
    const file = memoryBackend("file", { secure: false, canWrite: true });
    const store = resolveStore([env, file], { requireSecureStorage: false });
    await store.set({ apiKey: "whk_written" }, DEFAULT_PROFILE);
    await expect(file.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_written" });
  });

  it("refuses to persist to an insecure backend when secure storage is required", async () => {
    const file = memoryBackend("file", { secure: false, canWrite: true });
    const store = resolveStore([file], { requireSecureStorage: true });
    await expect(store.set({ apiKey: "whk_x" }, DEFAULT_PROFILE)).rejects.toBeInstanceOf(
      SecureStorageRequiredError,
    );
    // and nothing was written
    await expect(file.get(DEFAULT_PROFILE)).resolves.toBeNull();
  });

  it("allows a secure backend under the require-secure-storage policy", async () => {
    const keychain = memoryBackend("keychain", { secure: true, canWrite: true });
    const file = memoryBackend("file", { secure: false, canWrite: true });
    const store = resolveStore([keychain, file], { requireSecureStorage: true });
    await store.set({ apiKey: "whk_secure" }, DEFAULT_PROFILE);
    await expect(keychain.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_secure" });
  });

  it("refuses to write when no backend can persist", async () => {
    const env = memoryBackend("env", { secure: false, canWrite: false });
    const store = resolveStore([env], { requireSecureStorage: false });
    await expect(store.set({ apiKey: "whk_x" }, DEFAULT_PROFILE)).rejects.toBeInstanceOf(
      SecureStorageRequiredError,
    );
  });

  it("erases the credential from every writable backend", async () => {
    const file = memoryBackend("file", {
      secure: false,
      canWrite: true,
      seed: { [DEFAULT_PROFILE]: { apiKey: "whk_gone" } },
    });
    const store = resolveStore([file], { requireSecureStorage: false });
    await store.erase();
    await expect(file.get(DEFAULT_PROFILE)).resolves.toBeNull();
  });

  it("getActiveProfile returns the first backend's persisted active profile (file over env)", async () => {
    const env = memoryBackend("env", { secure: false, canWrite: false }); // env has none
    const file = memoryBackend("file", {
      secure: false,
      canWrite: true,
      activeProfile: "staging",
    });
    const store = resolveStore([env, file], { requireSecureStorage: false });
    await expect(store.getActiveProfile?.()).resolves.toBe("staging");
  });

  it("getActiveProfile is undefined when no backend has one set", async () => {
    const file = memoryBackend("file", { secure: false, canWrite: true });
    const store = resolveStore([file], { requireSecureStorage: false });
    await expect(store.getActiveProfile?.()).resolves.toBeUndefined();
  });

  it("setActiveProfile persists to the first writable backend (skipping a read-only one)", async () => {
    const env = memoryBackend("env", { secure: false, canWrite: false });
    const file = memoryBackend("file", { secure: false, canWrite: true });
    const store = resolveStore([env, file], { requireSecureStorage: false });
    await store.setActiveProfile?.("staging");
    await expect(file.getActiveProfile()).resolves.toBe("staging");
    await expect(env.getActiveProfile()).resolves.toBeUndefined(); // the read-only backend was skipped
  });

  it("setActiveProfile(undefined) clears the persisted active profile", async () => {
    const file = memoryBackend("file", { secure: false, canWrite: true, activeProfile: "staging" });
    const store = resolveStore([file], { requireSecureStorage: false });
    await store.setActiveProfile?.(undefined);
    await expect(store.getActiveProfile?.()).resolves.toBeUndefined();
  });

  it("setActiveProfile refuses when no backend can persist", async () => {
    const env = memoryBackend("env", { secure: false, canWrite: false });
    const store = resolveStore([env], { requireSecureStorage: false });
    await expect(store.setActiveProfile?.("x")).rejects.toBeInstanceOf(SecureStorageRequiredError);
  });

  it("lists the union of profiles across backends", async () => {
    const env = memoryBackend("env", { secure: false, canWrite: false });
    const file = memoryBackend("file", {
      secure: false,
      canWrite: true,
      seed: { [DEFAULT_PROFILE]: { apiKey: "a" }, staging: { apiKey: "b" } },
    });
    const store = resolveStore([env, file], { requireSecureStorage: false });
    await expect(store.list()).resolves.toEqual(
      expect.arrayContaining([DEFAULT_PROFILE, "staging"]),
    );
  });
});

describe("resolveStore — sticky apiBaseUrl", () => {
  it("reads the base URL in backend precedence order (first defined wins)", async () => {
    const env = memoryBackend("env", { secure: false, canWrite: false });
    const file = memoryBackend("file", { secure: false, canWrite: true });
    await file.setApiBaseUrl(DEFAULT_PROFILE, "https://stored.example");
    const store = resolveStore([env, file], { requireSecureStorage: false });
    await expect(store.getApiBaseUrl()).resolves.toBe("https://stored.example");
  });

  it("returns undefined when no backend has a base URL", async () => {
    const file = memoryBackend("file", { secure: false, canWrite: true });
    const store = resolveStore([file], { requireSecureStorage: false });
    await expect(store.getApiBaseUrl()).resolves.toBeUndefined();
  });

  it("persists the base URL to the first writable backend, ignoring the secure-storage policy", async () => {
    // The base URL is config, not a secret — requireSecureStorage gates the credential, not this.
    const env = memoryBackend("env", { secure: false, canWrite: false });
    const file = memoryBackend("file", { secure: false, canWrite: true });
    const store = resolveStore([env, file], { requireSecureStorage: true });
    await store.setApiBaseUrl("https://api.self.example");
    await expect(file.getApiBaseUrl(DEFAULT_PROFILE)).resolves.toBe("https://api.self.example");
  });

  it("refuses to persist a base URL when no backend can write", async () => {
    const env = memoryBackend("env", { secure: false, canWrite: false });
    const store = resolveStore([env], { requireSecureStorage: false });
    await expect(store.setApiBaseUrl("https://x.example")).rejects.toBeInstanceOf(
      SecureStorageRequiredError,
    );
  });
});

describe("resolveStore — keychain composition (D7)", () => {
  const secureKeychain = (over: { unavailable?: boolean } = {}) =>
    memoryBackend("keychain", {
      secure: true,
      canWrite: true,
      persistsConfig: false,
      unavailable: over.unavailable,
    });
  const fileBackend = () =>
    memoryBackend("file", { secure: false, canWrite: true, persistsConfig: true });

  it("writes the credential to the secure backend ahead of the file (default policy)", async () => {
    const keychain = secureKeychain();
    const file = fileBackend();
    const store = resolveStore([keychain, file], { requireSecureStorage: false });
    await store.set({ apiKey: "whk_secure" });
    await expect(keychain.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_secure" });
    await expect(file.get(DEFAULT_PROFILE)).resolves.toBeNull();
  });

  it("routes config writes to a persistsConfig backend, skipping a secure non-config one ahead of it", async () => {
    const keychain = secureKeychain();
    const file = fileBackend();
    const store = resolveStore([keychain, file], { requireSecureStorage: false });
    await store.setApiBaseUrl("https://api.example");
    await store.setActiveProfile?.("staging");
    await expect(file.getApiBaseUrl(DEFAULT_PROFILE)).resolves.toBe("https://api.example");
    await expect(file.getActiveProfile()).resolves.toBe("staging");
    await expect(keychain.getApiBaseUrl(DEFAULT_PROFILE)).resolves.toBeUndefined();
  });

  it("falls back to the file when the secure backend is unavailable (default policy)", async () => {
    const keychain = secureKeychain({ unavailable: true });
    const file = fileBackend();
    const store = resolveStore([keychain, file], { requireSecureStorage: false });
    await store.set({ apiKey: "whk_fallback" });
    await expect(file.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_fallback" });
  });

  it("fails loud (no insecure fallback) when secure is required but the keychain is unavailable", async () => {
    const keychain = secureKeychain({ unavailable: true });
    const file = fileBackend();
    const store = resolveStore([keychain, file], { requireSecureStorage: true });
    await expect(store.set({ apiKey: "x" })).rejects.toBeInstanceOf(KeychainUnavailableError);
    await expect(file.get(DEFAULT_PROFILE)).resolves.toBeNull(); // nothing written insecurely
  });

  it("allowInsecure overrides require-secure → writes to the file when the keychain is unavailable", async () => {
    const keychain = secureKeychain({ unavailable: true });
    const file = fileBackend();
    const store = resolveStore([keychain, file], { requireSecureStorage: true });
    await store.set({ apiKey: "whk_forced" }, DEFAULT_PROFILE, { allowInsecure: true });
    await expect(file.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_forced" });
  });

  it("erase tolerates a missing keychain — logout still clears the file (no stale secret left behind)", async () => {
    const keychain = secureKeychain({ unavailable: true });
    const file = memoryBackend("file", {
      secure: false,
      canWrite: true,
      persistsConfig: true,
      seed: { [DEFAULT_PROFILE]: { apiKey: "whk_stale" } },
    });
    const store = resolveStore([keychain, file], { requireSecureStorage: false });
    await store.erase(); // must NOT throw despite the unavailable keychain
    await expect(file.get(DEFAULT_PROFILE)).resolves.toBeNull();
  });

  it("read tolerates a missing keychain — skips it and reads the file (no-keychain box)", async () => {
    const keychain = secureKeychain({ unavailable: true });
    const file = memoryBackend("file", {
      secure: false,
      canWrite: true,
      persistsConfig: true,
      seed: { [DEFAULT_PROFILE]: { apiKey: "whk_from_file" } },
    });
    const store = resolveStore([keychain, file], { requireSecureStorage: false });
    // get() iterates [keychain(throws unavailable), file] → must skip the keychain, not throw.
    await expect(store.get()).resolves.toEqual({ apiKey: "whk_from_file" });
  });

  it("propagates a non-availability failure (e.g. denied) without silently falling back", async () => {
    // A backend that throws a NON-KeychainUnavailable error must NOT fall back to the insecure file.
    const denied: CredentialBackend = {
      ...fileBackend(),
      id: "keychain",
      secure: true,
      persistsConfig: false,
      set: async () => {
        throw new Error("keychain access denied by the user");
      },
    };
    const file = fileBackend();
    const store = resolveStore([denied, file], { requireSecureStorage: false });
    await expect(store.set({ apiKey: "x" })).rejects.toThrow("denied");
    await expect(file.get(DEFAULT_PROFILE)).resolves.toBeNull();
  });
});

describe("resolveStore — getWithSource (accurate credential source)", () => {
  const KEY = (k: string): StoredCredential => ({ apiKey: k });
  const mk = (id: string, seed?: Record<string, StoredCredential>, unavailable = false) =>
    memoryBackend(id, { secure: id === "keychain", canWrite: id !== "env", seed, unavailable });

  it("reports WHICH backend served the credential (env › keychain › file), not a guess", async () => {
    // file holds it (keychain unavailable) → "file"
    let store = resolveStore(
      [mk("env"), mk("keychain", undefined, true), mk("file", { [DEFAULT_PROFILE]: KEY("whk_f") })],
      { requireSecureStorage: false },
    );
    expect(await store.getWithSource!()).toEqual({ cred: KEY("whk_f"), source: "file" });

    // keychain holds it AHEAD of the file → "keychain" (the bug was reporting this as "file")
    store = resolveStore(
      [
        mk("env"),
        mk("keychain", { [DEFAULT_PROFILE]: KEY("whk_k") }),
        mk("file", { [DEFAULT_PROFILE]: KEY("whk_f") }),
      ],
      { requireSecureStorage: false },
    );
    expect(await store.getWithSource!()).toEqual({ cred: KEY("whk_k"), source: "keychain" });

    // env wins (highest precedence)
    store = resolveStore(
      [mk("env", { [DEFAULT_PROFILE]: KEY("whk_e") }), mk("keychain"), mk("file")],
      { requireSecureStorage: false },
    );
    expect(await store.getWithSource!()).toEqual({ cred: KEY("whk_e"), source: "env" });

    // nothing anywhere (keychain unavailable) → null
    store = resolveStore([mk("env"), mk("keychain", undefined, true), mk("file")], {
      requireSecureStorage: false,
    });
    expect(await store.getWithSource!()).toBeNull();
  });
});
