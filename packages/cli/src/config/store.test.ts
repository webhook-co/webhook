import { describe, expect, it } from "vitest";

import { BackendNotWritableError, SecureStorageRequiredError } from "./errors.js";
import { DEFAULT_PROFILE, type StoredCredential } from "./schema.js";
import { type CredentialBackend, resolveStore } from "./store.js";

/** Minimal in-memory backend for exercising the resolver in isolation (no fs). */
function memoryBackend(
  id: string,
  opts: { secure: boolean; canWrite: boolean; seed?: Record<string, StoredCredential> },
): CredentialBackend {
  const store = new Map<string, StoredCredential>(Object.entries(opts.seed ?? {}));
  const baseUrls = new Map<string, string>();
  return {
    id,
    secure: opts.secure,
    canWrite: opts.canWrite,
    async get(profile) {
      return store.get(profile) ?? null;
    },
    async set(profile, cred) {
      if (!opts.canWrite) throw new BackendNotWritableError(id);
      store.set(profile, cred);
    },
    async erase(profile) {
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
