import { describe, expect, it } from "vitest";

import { SecureStorageRequiredError } from "./config/errors.js";
import { buildContext } from "./context.js";

function fakeHostProcess(env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    proc: {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      env,
      platform: "linux" as const,
      exitCode: undefined as number | string | null | undefined,
    },
    out,
    err,
  };
}

describe("buildContext", () => {
  it("assembles a context with a credential store and color resolution", () => {
    const { proc } = fakeHostProcess({ NO_COLOR: "1" });
    const ctx = buildContext(proc, { homedir: "/nonexistent-home" });
    expect(typeof ctx.store.get).toBe("function");
    expect(ctx.colorEnabled).toBe(false); // NO_COLOR forces color off
    ctx.process.stdout.write("hi");
  });

  it("honors the env-var credential through the assembled store", async () => {
    const { proc } = fakeHostProcess({ WBHK_API_KEY: "whk_ctx_env" });
    const ctx = buildContext(proc, { homedir: "/nonexistent-home" });
    await expect(ctx.store.get()).resolves.toEqual({ apiKey: "whk_ctx_env" });
  });

  it("enables color when the stream reports a deep color terminal", () => {
    const out: string[] = [];
    const proc = {
      stdout: { write: (s: string) => void out.push(s), getColorDepth: () => 8 },
      stderr: { write: () => undefined },
      env: {} as Record<string, string | undefined>,
      platform: "linux" as const,
      exitCode: undefined as number | string | null | undefined,
    };
    expect(buildContext(proc, { homedir: "/nonexistent-home" }).colorEnabled).toBe(true);
  });

  it("disables color when NO_COLOR is present, even NO_COLOR=0 on a deep-color terminal", () => {
    const proc = {
      stdout: { write: () => undefined, getColorDepth: () => 8 },
      stderr: { write: () => undefined },
      env: { NO_COLOR: "0" } as Record<string, string | undefined>,
      platform: "linux" as const,
      exitCode: undefined as number | string | null | undefined,
    };
    // no-color.org: presence (non-empty) disables regardless of value — "0" still disables.
    expect(buildContext(proc, { homedir: "/nonexistent-home" }).colorEnabled).toBe(false);
  });

  it("wires the require-secure-storage policy from the environment", async () => {
    const { proc } = fakeHostProcess({ WBHK_REQUIRE_SECURE_STORAGE: "1" });
    const ctx = buildContext(proc, { homedir: "/nonexistent-home" });
    // only the insecure 0600-file backend can write → policy forces a hard fail
    await expect(ctx.store.set({ apiKey: "whk_x" })).rejects.toBeInstanceOf(
      SecureStorageRequiredError,
    );
  });
});
