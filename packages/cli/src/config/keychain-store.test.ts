import { describe, expect, it } from "vitest";

import { KeychainUnavailableError } from "./errors.js";
import { createKeychainBackend, type KeychainIo } from "./keychain-store.js";

/** An in-memory KeychainIo standing in for the OS keychain CLI (the real seam lives in io.ts). */
function mapKeychain(): KeychainIo {
  const store = new Map<string, string>();
  return {
    get: async (account) => store.get(account) ?? null,
    set: async (account, secret) => void store.set(account, secret),
    erase: async (account) => void store.delete(account),
  };
}

/** A KeychainIo that always reports the keychain is missing (no OS helper installed). */
const unavailableKeychain = (): KeychainIo => ({
  get: async () => {
    throw new KeychainUnavailableError();
  },
  set: async () => {
    throw new KeychainUnavailableError();
  },
  erase: async () => {
    throw new KeychainUnavailableError();
  },
});

describe("keychain backend", () => {
  it("is a secure, writable, config-less backend", () => {
    const b = createKeychainBackend({ keychainIo: mapKeychain() });
    expect(b.id).toBe("keychain");
    expect(b.secure).toBe(true);
    expect(b.canWrite).toBe(true);
    expect(b.persistsConfig).toBe(false);
  });

  it("round-trips a credential, keyed per profile", async () => {
    const b = createKeychainBackend({ keychainIo: mapKeychain() });
    await b.set("default", { apiKey: "whk_default" });
    await b.set("staging", { apiKey: "whk_staging" });
    await expect(b.get("default")).resolves.toEqual({ apiKey: "whk_default" });
    await expect(b.get("staging")).resolves.toEqual({ apiKey: "whk_staging" });
  });

  it("returns null when no credential is stored", async () => {
    const b = createKeychainBackend({ keychainIo: mapKeychain() });
    await expect(b.get("default")).resolves.toBeNull();
  });

  it("erases a stored credential", async () => {
    const b = createKeychainBackend({ keychainIo: mapKeychain() });
    await b.set("default", { apiKey: "whk_x" });
    await b.erase("default");
    await expect(b.get("default")).resolves.toBeNull();
  });

  it("propagates KeychainUnavailableError (the resolver uses it to fall back)", async () => {
    const b = createKeychainBackend({ keychainIo: unavailableKeychain() });
    await expect(b.set("default", { apiKey: "x" })).rejects.toBeInstanceOf(
      KeychainUnavailableError,
    );
    await expect(b.get("default")).rejects.toBeInstanceOf(KeychainUnavailableError);
  });

  it("carries no config: getActiveProfile/getApiBaseUrl undefined, list empty, config writes refused", async () => {
    const b = createKeychainBackend({ keychainIo: mapKeychain() });
    await expect(b.getActiveProfile()).resolves.toBeUndefined();
    await expect(b.getApiBaseUrl("default")).resolves.toBeUndefined();
    await expect(b.list()).resolves.toEqual([]);
    await expect(b.setActiveProfile("x")).rejects.toBeTruthy();
    await expect(b.setApiBaseUrl("default", "https://x")).rejects.toBeTruthy();
  });
});
