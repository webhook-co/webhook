import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ConfigNotFoundError,
  CorruptConfigError,
  InsecureConfigPermissionsError,
} from "./errors.js";
import { configFilePath, createFileBackend, loadConfigFile } from "./file-store.js";
import { CONFIG_VERSION, DEFAULT_PROFILE } from "./schema.js";

// Each test gets its own unique tmpdir, so there is no shared state to tear down;
// the OS reclaims them. No afterEach needed.
async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wbhk-cli-test-"));
}

describe("loadConfigFile", () => {
  it("throws ConfigNotFoundError when the file is absent", async () => {
    const dir = await freshDir();
    await expect(loadConfigFile(configFilePath(dir), { platform: "linux" })).rejects.toBeInstanceOf(
      ConfigNotFoundError,
    );
  });

  it("throws CorruptConfigError on invalid JSON", async () => {
    const dir = await freshDir();
    const path = configFilePath(dir);
    await writeFile(path, "{ not json", { mode: 0o600 });
    await expect(loadConfigFile(path, { platform: "linux" })).rejects.toBeInstanceOf(
      CorruptConfigError,
    );
  });

  it("throws CorruptConfigError when JSON does not match the schema", async () => {
    const dir = await freshDir();
    const path = configFilePath(dir);
    await writeFile(path, JSON.stringify({ version: 999 }), { mode: 0o600 });
    await expect(loadConfigFile(path, { platform: "linux" })).rejects.toBeInstanceOf(
      CorruptConfigError,
    );
  });

  it("rejects a file readable by group or other (POSIX)", async () => {
    const dir = await freshDir();
    const path = configFilePath(dir);
    await writeFile(path, JSON.stringify({ version: CONFIG_VERSION, profiles: {} }), {
      mode: 0o600,
    });
    await chmod(path, 0o644);
    await expect(loadConfigFile(path, { platform: "linux" })).rejects.toBeInstanceOf(
      InsecureConfigPermissionsError,
    );
  });

  it("does NOT enforce the permission check on win32", async () => {
    const dir = await freshDir();
    const path = configFilePath(dir);
    await writeFile(path, JSON.stringify({ version: CONFIG_VERSION, profiles: {} }), {
      mode: 0o644,
    });
    await expect(loadConfigFile(path, { platform: "win32" })).resolves.toMatchObject({
      version: CONFIG_VERSION,
    });
  });
});

describe("file-store backend", () => {
  it("round-trips a credential and creates the file 0600 / dir 0700", async () => {
    const dir = await freshDir();
    const childDir = join(dir, "webhook");
    const backend = createFileBackend({ dir: childDir, platform: "linux" });

    expect(backend.canWrite).toBe(true);
    expect(backend.secure).toBe(false); // honest: a 0600 file is the insecure fallback

    await backend.set(DEFAULT_PROFILE, { apiKey: "whk_round_trip" });
    await expect(backend.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_round_trip" });

    const fileMode = (await stat(configFilePath(childDir))).mode & 0o777;
    const dirMode = (await stat(childDir)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("get returns null when no config exists yet", async () => {
    const backend = createFileBackend({ dir: await freshDir(), platform: "linux" });
    await expect(backend.get(DEFAULT_PROFILE)).resolves.toBeNull();
  });

  it("never writes the plaintext key anywhere but the value field", async () => {
    const dir = await freshDir();
    const backend = createFileBackend({ dir, platform: "linux" });
    await backend.set(DEFAULT_PROFILE, { apiKey: "whk_only_here" });
    const raw = await readFile(configFilePath(dir), "utf8");
    // exactly one occurrence — inside the credential value, nowhere else
    expect(raw.split("whk_only_here").length - 1).toBe(1);
  });

  it("lists profiles and erases a credential", async () => {
    const dir = await freshDir();
    const backend = createFileBackend({ dir, platform: "linux" });
    await backend.set(DEFAULT_PROFILE, { apiKey: "whk_a" });
    await backend.set("staging", { apiKey: "whk_b" });
    await expect(backend.list()).resolves.toEqual(
      expect.arrayContaining([DEFAULT_PROFILE, "staging"]),
    );
    await backend.erase("staging");
    await expect(backend.get("staging")).resolves.toBeNull();
    await expect(backend.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_a" });
  });

  it("round-trips the per-profile apiBaseUrl alongside the credential", async () => {
    const dir = await freshDir();
    const backend = createFileBackend({ dir, platform: "linux" });

    await expect(backend.getApiBaseUrl(DEFAULT_PROFILE)).resolves.toBeUndefined();

    await backend.set(DEFAULT_PROFILE, { apiKey: "whk_with_url" });
    await backend.setApiBaseUrl(DEFAULT_PROFILE, "https://api.self.example");

    // The base URL persists, and setting it does NOT clobber the stored credential.
    await expect(backend.getApiBaseUrl(DEFAULT_PROFILE)).resolves.toBe("https://api.self.example");
    await expect(backend.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_with_url" });
  });

  it("setting a credential preserves an already-stored apiBaseUrl", async () => {
    const dir = await freshDir();
    const backend = createFileBackend({ dir, platform: "linux" });
    await backend.setApiBaseUrl(DEFAULT_PROFILE, "https://api.self.example");
    await backend.set(DEFAULT_PROFILE, { apiKey: "whk_later" });
    await expect(backend.getApiBaseUrl(DEFAULT_PROFILE)).resolves.toBe("https://api.self.example");
  });

  it("refuses to read or modify a pre-existing loose file (the user must fix it first)", async () => {
    const dir = await freshDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = configFilePath(dir);
    await writeFile(path, JSON.stringify({ version: CONFIG_VERSION, profiles: {} }), {
      mode: 0o644,
    });
    const backend = createFileBackend({ dir, platform: "linux" });
    // We never silently trust (or silently tighten) a world-readable config — fail loud.
    await expect(backend.get(DEFAULT_PROFILE)).rejects.toBeInstanceOf(
      InsecureConfigPermissionsError,
    );
    await expect(backend.set(DEFAULT_PROFILE, { apiKey: "x" })).rejects.toBeInstanceOf(
      InsecureConfigPermissionsError,
    );
  });
});
