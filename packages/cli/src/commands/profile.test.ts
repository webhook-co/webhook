import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

// An in-memory store that actually honors profiles + the active-profile pointer, so the `profile`
// command family can be driven end-to-end (the inline read-command fakes ignore the profile arg).
function profileStore(
  initial: { profiles?: readonly string[]; active?: string } = {},
): CredentialStore & { peekActive: () => string | undefined } {
  const profiles = new Set<string>(initial.profiles ?? []);
  let active = initial.active;
  return {
    get: async (p = "default") => (profiles.has(p) ? { apiKey: `whk_${p}` } : null),
    set: async (_c, p = "default") => void profiles.add(p),
    erase: async (p = "default") => void profiles.delete(p),
    list: async () => [...profiles],
    getActiveProfile: async () => active,
    setActiveProfile: async (n) => void (active = n),
    getApiBaseUrl: async () => undefined,
    setApiBaseUrl: async () => undefined,
    peekActive: () => active,
  };
}

describe("wbhk profile use", () => {
  it("persists the chosen profile as the active one", async () => {
    const store = profileStore({ profiles: ["staging"] });
    const t = makeTestContext({ store });
    await run(app, ["profile", "use", "staging"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(store.peekActive()).toBe("staging");
    expect(t.stdout()).toContain("staging");
  });

  it("warns on stderr when the profile has no credential yet (still switches)", async () => {
    const store = profileStore({});
    const t = makeTestContext({ store });
    await run(app, ["profile", "use", "staging"], t.ctx);
    expect(store.peekActive()).toBe("staging");
    expect(t.stderr().toLowerCase()).toContain("no credential");
  });

  it("rejects a reserved profile name as a usage error", async () => {
    const store = profileStore({});
    const t = makeTestContext({ store });
    await run(app, ["profile", "use", "__proto__"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(store.peekActive()).toBeUndefined(); // nothing persisted
  });
});

describe("wbhk profile current", () => {
  it("shows the persisted active profile", async () => {
    const t = makeTestContext({ store: profileStore({ active: "staging" }) });
    await run(app, ["profile", "current"], t.ctx);
    expect(t.stdout()).toContain("staging");
  });

  it("shows the default when none is set", async () => {
    const t = makeTestContext({ store: profileStore({}) });
    await run(app, ["profile", "current"], t.ctx);
    expect(t.stdout()).toContain("default");
  });

  it("reflects a --profile override and reports its source (json)", async () => {
    const t = makeTestContext({ store: profileStore({ active: "staging" }) });
    await run(app, ["profile", "current", "--profile", "prod", "--output", "json"], t.ctx);
    expect(JSON.parse(t.stdout())).toMatchObject({ active: "prod", source: "--profile" });
  });
});

describe("wbhk profile list", () => {
  it("lists profiles and marks the active one", async () => {
    const store = profileStore({ profiles: ["default", "staging"], active: "staging" });
    const t = makeTestContext({ store });
    await run(app, ["profile", "list"], t.ctx);
    expect(t.stdout()).toContain("staging");
    expect(t.stdout()).toContain("default");
    expect(t.stdout()).toContain("*"); // the active marker
  });

  it("emits the {profiles, active} envelope with --output json", async () => {
    const store = profileStore({ profiles: ["default"], active: "default" });
    const t = makeTestContext({ store });
    await run(app, ["profile", "list", "--output", "json"], t.ctx);
    expect(JSON.parse(t.stdout())).toMatchObject({ active: "default", profiles: ["default"] });
  });

  it("prints a friendly line when there are no profiles", async () => {
    const t = makeTestContext({ store: profileStore({}) });
    await run(app, ["profile", "list"], t.ctx);
    expect(t.stdout().toLowerCase()).toContain("no profiles");
  });

  it("marks the EFFECTIVE active profile (WBHK_PROFILE), agreeing with `profile current`", async () => {
    // persisted active is `default`, but WBHK_PROFILE=staging overrides it — the `*` must follow the
    // effective profile, matching what `profile current` reports (no list-vs-current disagreement).
    const store = profileStore({ profiles: ["default", "staging"], active: "default" });
    const t = makeTestContext({ store, env: { WBHK_PROFILE: "staging" } });
    await run(app, ["profile", "list", "--output", "json"], t.ctx);
    expect(JSON.parse(t.stdout())).toMatchObject({ active: "staging" });
  });
});

describe("wbhk profile remove", () => {
  it("removes a profile and clears it when it was the active one", async () => {
    const store = profileStore({ profiles: ["staging"], active: "staging" });
    const t = makeTestContext({ store });
    await run(app, ["profile", "remove", "staging"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    await expect(store.list()).resolves.not.toContain("staging");
    expect(store.peekActive()).toBeUndefined();
  });

  it("errors (usage) when the profile does not exist", async () => {
    const t = makeTestContext({ store: profileStore({ profiles: ["default"] }) });
    await run(app, ["profile", "remove", "ghost"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
  });
});
