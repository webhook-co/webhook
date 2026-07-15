import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { Org, StoredCredential } from "../config/schema.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

// A local-only credential store fake: profiles → { cred?, org? } + a persisted active profile. `wbhk org`
// is LOCAL by contract (never a network call), so these tests wire no fetch — a command that reached out
// would throw the unconfigured-fetch error and fail loudly.
function orgStore(
  profiles: Record<string, { cred?: StoredCredential; org?: Org }>,
  activeProfile?: string,
): { store: CredentialStore; active: () => string | undefined } {
  let active = activeProfile;
  return {
    store: {
      get: async (p = "default") => profiles[p]?.cred ?? null,
      set: async () => undefined,
      erase: async () => undefined,
      list: async () => Object.keys(profiles),
      getApiBaseUrl: async () => undefined,
      setApiBaseUrl: async () => undefined,
      getOrg: async (p = "default") => profiles[p]?.org,
      setOrg: async () => undefined,
      getActiveProfile: async () => active,
      setActiveProfile: async (name) => void (active = name),
    },
    active: () => active,
  };
}

const ORG_ACME: Org = { id: "org_1", slug: "acme", name: "Acme, Inc." };
const ORG_GLOBEX: Org = { id: "org_2", slug: "globex", name: "Globex" };
const KEY: StoredCredential = { apiKey: "whk_test" };

describe("wbhk org list", () => {
  it("lists each profile's bound org with the `*` active marker + (profile), and never calls the network", async () => {
    const s = orgStore(
      { prod: { cred: KEY, org: ORG_ACME }, staging: { cred: KEY, org: ORG_GLOBEX } },
      "prod",
    );
    const t = makeTestContext({ store: s.store }); // no fetch wired — must stay local
    await run(app, ["org", "list"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    const out = t.stdout();
    expect(out).toContain("* acme — Acme, Inc. (prod)"); // active
    expect(out).toContain("  globex — Globex (staging)"); // not active
  });

  it("shows an empty-state message when no profile has a bound org", async () => {
    const s = orgStore({ default: { cred: KEY } });
    const t = makeTestContext({ store: s.store });
    await run(app, ["org", "list"], t.ctx);
    expect(t.stdout().toLowerCase()).toContain("no orgs");
  });

  it("emits a JSON shape with slug/name/profile/active under --output json", async () => {
    const s = orgStore({ prod: { cred: KEY, org: ORG_ACME } }, "prod");
    const t = makeTestContext({ store: s.store });
    await run(app, ["org", "list", "--output", "json"], t.ctx);
    expect(JSON.parse(t.stdout())).toEqual({
      orgs: [{ slug: "acme", name: "Acme, Inc.", profile: "prod", active: true }],
    });
  });
});

describe("wbhk org current", () => {
  it("shows the effective org + the profile it came from", async () => {
    const s = orgStore({ prod: { cred: KEY, org: ORG_ACME } }, "prod");
    const t = makeTestContext({ store: s.store });
    await run(app, ["org", "current"], t.ctx);
    const out = t.stdout();
    expect(out).toContain("acme");
    expect(out).toContain("Acme, Inc.");
    expect(out).toContain("prod"); // the source profile
  });

  it("reports no bound org for the active profile when there is none", async () => {
    const s = orgStore({ default: { cred: KEY } });
    const t = makeTestContext({ store: s.store });
    await run(app, ["org", "current"], t.ctx);
    expect(t.stdout().toLowerCase()).toContain("no org");
  });
});

describe("wbhk org use <slug>", () => {
  it("sets the active profile to the one bound to the slug and echoes the org", async () => {
    const s = orgStore(
      { prod: { cred: KEY, org: ORG_ACME }, staging: { cred: KEY, org: ORG_GLOBEX } },
      "prod",
    );
    const t = makeTestContext({ store: s.store });
    await run(app, ["org", "use", "globex"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(s.active()).toBe("staging"); // switched to globex's profile
    expect(t.stdout()).toContain("globex");
  });

  it("errors (OrgNotFoundError → usage exit) for an unknown slug", async () => {
    const s = orgStore({ prod: { cred: KEY, org: ORG_ACME } }, "prod");
    const t = makeTestContext({ store: s.store });
    await run(app, ["org", "use", "nope"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("no local credential for org");
  });

  it('C5: `org use " acme"` (whitespace-padded) trims and resolves to the acme profile', async () => {
    const s = orgStore(
      { prod: { cred: KEY, org: ORG_ACME }, staging: { cred: KEY, org: ORG_GLOBEX } },
      "staging",
    );
    const t = makeTestContext({ store: s.store });
    await run(app, ["org", "use", " acme\n"], t.ctx); // padded $SLUG
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(s.active()).toBe("prod"); // trimmed → matched acme → prod
    expect(t.stdout()).toContain("acme");
  });

  it('F6: `org use ""` is a usage error and does NOT fall through to WBHK_ORG', async () => {
    const s = orgStore(
      { prod: { cred: KEY, org: ORG_ACME }, staging: { cred: KEY, org: ORG_GLOBEX } },
      "prod",
    );
    // WBHK_ORG points at a real org — an empty positional must NOT silently switch to it.
    const t = makeTestContext({ store: s.store, env: { WBHK_ORG: "globex" } });
    await run(app, ["org", "use", ""], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(s.active()).toBe("prod"); // unchanged — did NOT switch to globex/staging
    expect(t.stderr().toLowerCase()).toContain("invalid org slug");
  });
});

describe("wbhk org — display/discovery is unaffected by a stale WBHK_ORG (F1)", () => {
  it("`org list` still works with WBHK_ORG set to a nonexistent slug (does not throw)", async () => {
    const s = orgStore({ prod: { cred: KEY, org: ORG_ACME } }, "prod");
    const t = makeTestContext({ store: s.store, env: { WBHK_ORG: "nonexistent" } });
    await run(app, ["org", "list"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("* acme — Acme, Inc. (prod)");
  });

  it("`org current` still works with WBHK_ORG set to a nonexistent slug (does not throw)", async () => {
    const s = orgStore({ prod: { cred: KEY, org: ORG_ACME } }, "prod");
    const t = makeTestContext({ store: s.store, env: { WBHK_ORG: "nonexistent" } });
    await run(app, ["org", "current"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("acme");
  });
});
