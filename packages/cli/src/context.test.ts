import { describe, expect, it } from "vitest";

import { KeychainUnavailableError } from "./config/errors.js";
import type { KeychainIo } from "./config/keychain-store.js";
import { buildContext, type IoSeams } from "./context.js";

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

/** An "unavailable" keychain — buildContext composes a keychain backend, so tests MUST inject one rather
 *  than fall through to the real OS keychain (which would touch the developer's actual keychain). */
const unavailableKeychain: KeychainIo = {
  get: async () => {
    throw new KeychainUnavailableError();
  },
  set: async () => {
    throw new KeychainUnavailableError();
  },
  erase: async () => {
    throw new KeychainUnavailableError();
  },
};

/** A full fake IoSeams (everything throws if used) with an injectable keychain — keeps buildContext off
 *  the real `fetch`/keychain in these context tests. */
function fakeIo(keychain: KeychainIo = unavailableKeychain): IoSeams {
  const nope = (): never => {
    throw new Error("io seam not configured in this test");
  };
  return {
    fetch: nope as unknown as typeof fetch,
    isInteractive: false,
    promptSecret: nope,
    readStdin: nope,
    connectWebSocket: nope as unknown as IoSeams["connectWebSocket"],
    keychain,
    openBrowser: nope as unknown as IoSeams["openBrowser"],
    sleep: nope as unknown as IoSeams["sleep"],
    startLoopbackServer: nope as unknown as IoSeams["startLoopbackServer"],
    editText: nope as unknown as IoSeams["editText"],
    isTTY: false,
    terminalSize: nope as unknown as IoSeams["terminalSize"],
    startRawInput: nope as unknown as IoSeams["startRawInput"],
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

  it("wires the require-secure-storage policy: required but no keychain → fail loud (no insecure write)", async () => {
    const { proc } = fakeHostProcess({ WBHK_REQUIRE_SECURE_STORAGE: "1" });
    const ctx = buildContext(proc, { homedir: "/nonexistent-home", io: fakeIo() }); // keychain unavailable
    // The keychain (the only secure backend) is unavailable → fail loud rather than write the 0600 file.
    await expect(ctx.store.set({ apiKey: "whk_x" })).rejects.toBeInstanceOf(
      KeychainUnavailableError,
    );
  });

  it("composes the OS keychain ahead of the file: a credential lands in the keychain by default", async () => {
    const m = new Map<string, string>();
    const keychain: KeychainIo = {
      get: async (a) => m.get(a) ?? null,
      set: async (a, s) => void m.set(a, s),
      erase: async (a) => void m.delete(a),
    };
    const { proc } = fakeHostProcess({});
    const ctx = buildContext(proc, { homedir: "/nonexistent-home", io: fakeIo(keychain) });
    await ctx.store.set({ apiKey: "whk_kc" });
    // The credential is stored in the keychain (serialized as JSON, per D8a), not the 0600 file.
    expect(JSON.parse(m.get("default")!)).toEqual({ apiKey: "whk_kc" });
    await expect(ctx.store.get()).resolves.toEqual({ apiKey: "whk_kc" });
  });
});
