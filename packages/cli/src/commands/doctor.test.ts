import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import { configFilePath } from "../config/file-store.js";
import { resolveConfigDir } from "../config/paths.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";
import {
  apiReachabilityCheck,
  clockCheck,
  configCheckFrom,
  credentialCheck,
  pathsCheck,
  summarizeChecks,
  terminalCheck,
  versionCheck,
} from "./doctor.js";

describe("doctor checks (pure)", () => {
  it("versionCheck reports the cli version", () => {
    const c = versionCheck("0.0.0 (dev)");
    expect(c).toMatchObject({ name: "cli", status: "ok" });
    expect(c.detail).toContain("0.0.0 (dev)");
  });

  it("terminalCheck reports color + tty state", () => {
    expect(terminalCheck({ colorEnabled: true, isInteractive: false })).toMatchObject({
      name: "terminal",
      status: "ok",
    });
    expect(terminalCheck({ colorEnabled: true, isInteractive: false }).detail).toContain(
      "color on",
    );
    expect(terminalCheck({ colorEnabled: false, isInteractive: true }).detail).toContain(
      "color off",
    );
  });

  it("credentialCheck: ok when logged in (with source + profile), warn otherwise", () => {
    const ok = credentialCheck({ loggedIn: true, source: "file", profile: "staging" });
    expect(ok.status).toBe("ok");
    expect(ok.detail).toContain("staging");
    expect(ok.detail).toContain("file");
    expect(credentialCheck({ loggedIn: false, source: null, profile: "default" }).status).toBe(
      "warn",
    );
  });

  it("apiReachabilityCheck: ok when reachable, warn (not fail) when not — unreachable is transient", () => {
    expect(
      apiReachabilityCheck({ reachable: true, status: 200, baseUrl: "https://api.webhook.co" })
        .status,
    ).toBe("ok");
    const down = apiReachabilityCheck({ reachable: false, baseUrl: "https://api.webhook.co" });
    expect(down.status).toBe("warn");
    expect(down.detail).toContain("https://api.webhook.co");
  });

  it("clockCheck: ok in sync, warn when skewed, warn when no server time", () => {
    const now = 1_700_000_000_000;
    expect(clockCheck({ serverDate: new Date(now + 1_000), now, thresholdMs: 60_000 }).status).toBe(
      "ok",
    );
    const skewed = clockCheck({ serverDate: new Date(now + 120_000), now, thresholdMs: 60_000 });
    expect(skewed.status).toBe("warn");
    expect(skewed.detail.toLowerCase()).toContain("skew");
    expect(clockCheck({ serverDate: undefined, now, thresholdMs: 60_000 }).status).toBe("warn");
  });

  it("configCheckFrom: ok/absent → ok, insecure/corrupt → fail", () => {
    expect(configCheckFrom({ kind: "ok" }).status).toBe("ok");
    expect(configCheckFrom({ kind: "absent" }).status).toBe("ok");
    expect(configCheckFrom({ kind: "insecure" }).status).toBe("fail");
    expect(configCheckFrom({ kind: "corrupt" }).status).toBe("fail");
  });

  it("pathsCheck lists the config/state/cache directories", () => {
    const c = pathsCheck({ configDir: "/c", stateDir: "/s", cacheDir: "/ca" });
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("/c");
    expect(c.detail).toContain("/s");
    expect(c.detail).toContain("/ca");
  });

  it("summarizeChecks: ok unless some check failed", () => {
    expect(
      summarizeChecks([
        { name: "a", status: "ok", detail: "" },
        { name: "b", status: "warn", detail: "" },
      ]),
    ).toEqual({ ok: true });
    expect(summarizeChecks([{ name: "a", status: "fail", detail: "" }])).toEqual({ ok: false });
  });
});

describe("wbhk doctor (command)", () => {
  function loggedInStore(): CredentialStore {
    return {
      get: async () => ({ apiKey: "whk_test" }),
      set: async () => undefined,
      erase: async () => undefined,
      list: async () => ["default"],
      getActiveProfile: async () => undefined,
      setActiveProfile: async () => undefined,
      getApiBaseUrl: async () => undefined,
      setApiBaseUrl: async () => undefined,
    };
  }
  const reachableFetch = (): typeof fetch =>
    (async () =>
      new Response(null, {
        status: 200,
        headers: { date: new Date().toUTCString() },
      })) as unknown as typeof fetch;
  const downFetch = (): typeof fetch =>
    (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

  it("runs every check and exits 0 when healthy", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: reachableFetch() });
    await run(app, ["doctor"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    const out = t.stdout();
    for (const name of ["cli", "terminal", "credential", "config", "api", "clock", "paths"]) {
      expect(out).toContain(name);
    }
  });

  it("treats an unreachable API as a warning, NOT a failure (stays exit 0 when offline)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: downFetch() });
    await run(app, ["doctor"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
  });

  it("reports the credential source as keychain (not file) when it lives in the OS keychain", async () => {
    // A working keychain fake holding the credential; no `store` override → the REAL store composes
    // [env, keychain, file], so doctor's getWithSource reports the actual backend.
    const m = new Map<string, string>();
    const keychain = {
      get: async (a: string) => m.get(a) ?? null,
      set: async (a: string, s: string) => void m.set(a, s),
      erase: async (a: string) => void m.delete(a),
    };
    await keychain.set("default", JSON.stringify({ apiKey: "whk_kc" })); // keychain stores serialized creds
    const t = makeTestContext({ keychain, fetch: reachableFetch() });
    await run(app, ["doctor"], t.ctx);
    const out = t.stdout();
    expect(out).toContain("via keychain"); // the fix: NOT mislabeled "via file"
    expect(out).not.toContain("via file");
  });

  it("exits non-zero when a check fails (a corrupt config — a must-fix local problem)", async () => {
    // A real homedir with an invalid-JSON, 0600 config → CorruptConfigError → the config check fails.
    const home = await mkdtemp(join(tmpdir(), "wbhk-doctor-"));
    const configDir = resolveConfigDir({}, home);
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(configFilePath(configDir), "{ not valid json", { mode: 0o600 });
    const t = makeTestContext({ store: loggedInStore(), fetch: reachableFetch(), homedir: home });
    await run(app, ["doctor"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.UNEXPECTED);
    expect(t.stdout().toLowerCase()).toContain("config");
  });

  it("emits a {checks, ok} envelope with --output json", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: reachableFetch() });
    await run(app, ["doctor", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout()) as { checks: unknown[]; ok: boolean };
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.ok).toBe(true);
  });
});
