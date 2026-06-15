import { describe, expect, it } from "vitest";

import { BackendNotWritableError } from "./errors.js";
import { createEnvBackend, ENV_API_KEY_VAR } from "./env-store.js";
import { DEFAULT_PROFILE } from "./schema.js";

describe("env-store backend", () => {
  it("resolves a credential from the env var for any profile", async () => {
    const backend = createEnvBackend({ [ENV_API_KEY_VAR]: "whk_from_env" });
    await expect(backend.get(DEFAULT_PROFILE)).resolves.toEqual({ apiKey: "whk_from_env" });
    await expect(backend.get("staging")).resolves.toEqual({ apiKey: "whk_from_env" });
  });

  it("returns null when the env var is unset or empty", async () => {
    await expect(createEnvBackend({}).get(DEFAULT_PROFILE)).resolves.toBeNull();
    await expect(
      createEnvBackend({ [ENV_API_KEY_VAR]: "" }).get(DEFAULT_PROFILE),
    ).resolves.toBeNull();
  });

  it("is read-only — it never persists a credential", async () => {
    const backend = createEnvBackend({});
    expect(backend.canWrite).toBe(false);
    await expect(backend.set(DEFAULT_PROFILE, { apiKey: "x" })).rejects.toBeInstanceOf(
      BackendNotWritableError,
    );
    await expect(backend.erase(DEFAULT_PROFILE)).rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(backend.list()).resolves.toEqual([]);
  });

  it("carries no base URL and refuses to persist one (WBHK_API_URL is resolved elsewhere)", async () => {
    const backend = createEnvBackend({ [ENV_API_KEY_VAR]: "whk_x" });
    await expect(backend.getApiBaseUrl(DEFAULT_PROFILE)).resolves.toBeUndefined();
    await expect(
      backend.setApiBaseUrl(DEFAULT_PROFILE, "https://x.example"),
    ).rejects.toBeInstanceOf(BackendNotWritableError);
  });
});
