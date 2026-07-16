import { describe, expect, it } from "vitest";

import type { Org } from "./config/schema.js";
import { DEFAULT_PROFILE } from "./config/schema.js";
import {
  AmbiguousOrgError,
  InvalidProfileNameError,
  OrgNotFoundError,
  OrgProfileConflictError,
  OrgSelectorWithEnvKeyError,
} from "./errors.js";
import {
  hasEnvApiKey,
  isEnvCredential,
  resolveActiveProfile,
  resolveColorFlag,
  resolveEffectiveOrg,
  resolveGlobals,
  resolveOrgSlugToProfile,
  resolveProfile,
  resolveRequestProfile,
} from "./global-flags.js";

describe("resolveColorFlag", () => {
  it("--no-color (color=false) forces color off, even when the env says on", () => {
    expect(resolveColorFlag({ color: false }, true)).toBe(false);
  });

  it("--color (color=true) forces color on, even when not a TTY", () => {
    expect(resolveColorFlag({ color: true }, false)).toBe(true);
  });

  it("falls back to the env/TTY-resolved default when the flag is unset", () => {
    expect(resolveColorFlag({ color: undefined }, true)).toBe(true);
    expect(resolveColorFlag({}, false)).toBe(false);
  });
});

describe("resolveGlobals", () => {
  it("resolves the output format and the effective color (flag over context)", () => {
    expect(
      resolveGlobals({ colorEnabled: true }, { output: "json", apiUrl: undefined, color: false }),
    ).toEqual({ format: "json", color: false });
    expect(
      resolveGlobals({ colorEnabled: false }, { output: "text", apiUrl: undefined, color: true }),
    ).toEqual({ format: "text", color: true });
    expect(resolveGlobals({ colorEnabled: true }, { output: "text", apiUrl: undefined })).toEqual({
      format: "text",
      color: true,
    });
  });
});

describe("resolveProfile", () => {
  const ctxWith = (env: Record<string, string | undefined>, active?: string) => ({
    process: { env },
    store: { getActiveProfile: async () => active },
  });

  it("prefers --profile, then WBHK_PROFILE, then the persisted active profile, then the default", async () => {
    expect(
      await resolveProfile(ctxWith({ WBHK_PROFILE: "envp" }, "activep"), { profile: "flagp" }),
    ).toBe("flagp");
    expect(await resolveProfile(ctxWith({ WBHK_PROFILE: "envp" }, "activep"), {})).toBe("envp");
    expect(await resolveProfile(ctxWith({}, "activep"), {})).toBe("activep");
    expect(await resolveProfile(ctxWith({}, undefined), {})).toBe(DEFAULT_PROFILE);
  });

  it("ignores an empty --profile or WBHK_PROFILE (treats it as unset)", async () => {
    expect(await resolveProfile(ctxWith({ WBHK_PROFILE: "" }, undefined), { profile: "" })).toBe(
      DEFAULT_PROFILE,
    );
  });

  it("works when the store has no getActiveProfile (optional method)", async () => {
    expect(await resolveProfile({ process: { env: {} }, store: {} }, {})).toBe(DEFAULT_PROFILE);
  });

  it("rejects a reserved/unsafe profile name (prototype-pollution-prone object keys)", async () => {
    // `--profile __proto__` would otherwise make a `login` write silently no-op (a bracket-write hits
    // the prototype, not an own key) while still reporting success — fail loud instead, from any source.
    await expect(
      resolveProfile(ctxWith({}, undefined), { profile: "__proto__" }),
    ).rejects.toBeInstanceOf(InvalidProfileNameError);
    await expect(
      resolveProfile(ctxWith({ WBHK_PROFILE: "constructor" }, undefined), {}),
    ).rejects.toBeInstanceOf(InvalidProfileNameError);
    await expect(resolveProfile(ctxWith({}, "prototype"), {})).rejects.toBeInstanceOf(
      InvalidProfileNameError,
    );
  });
});

const ORG_ACME: Org = { id: "org_1", slug: "acme", name: "Acme, Inc." };
const ORG_GLOBEX: Org = { id: "org_2", slug: "globex", name: "Globex" };

/** A ctx whose store scans a fixed profile→org map (the local login metadata) + an active profile. */
const orgCtx = (
  orgs: Record<string, Org>,
  env: Record<string, string | undefined> = {},
  active?: string,
) => ({
  process: { env },
  store: {
    list: async () => Object.keys(orgs),
    getOrg: async (p: string) => orgs[p],
    getActiveProfile: async () => active,
  },
});

describe("resolveOrgSlugToProfile (strict, explicit-slug scan)", () => {
  it("resolves an explicit slug to its profile (case-insensitive)", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME, p_globex: ORG_GLOBEX });
    await expect(resolveOrgSlugToProfile(ctx, "ACME")).resolves.toEqual({
      profile: "p_acme",
      org: ORG_ACME,
    });
  });

  it("throws OrgNotFoundError for an unmatched slug — NEVER falls through to a default", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME });
    await expect(resolveOrgSlugToProfile(ctx, "nope")).rejects.toBeInstanceOf(OrgNotFoundError);
  });

  it("throws AmbiguousOrgError when the same org matches two profiles", async () => {
    const ctx = orgCtx({ p_prod: ORG_ACME, p_stg: ORG_ACME });
    await expect(resolveOrgSlugToProfile(ctx, "acme")).rejects.toBeInstanceOf(AmbiguousOrgError);
  });
});

describe("resolveActiveProfile is DISPLAY-SAFE (profile-only, never reads WBHK_ORG, never throws)", () => {
  it("ignores a stale/typo'd WBHK_ORG entirely — does not throw (F1: recovery commands stay usable)", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_ORG: "nonexistent" }, "activep");
    // A bad WBHK_ORG would brick display/discovery if it were consulted here — it must be inert.
    await expect(resolveActiveProfile(ctx, {})).resolves.toEqual({
      name: "activep",
      source: "active profile",
    });
  });

  it("resolves --profile › WBHK_PROFILE › active › default, org selector NEVER involved", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_PROFILE: "envp", WBHK_ORG: "acme" }, "activep");
    // Even with WBHK_ORG=acme (a REAL org), display resolution stays on the profile ladder.
    await expect(resolveActiveProfile(ctx, {})).resolves.toEqual({
      name: "envp",
      source: "WBHK_PROFILE",
    });
    await expect(resolveActiveProfile(ctx, { profile: "flagp" })).resolves.toEqual({
      name: "flagp",
      source: "--profile",
    });
  });
});

describe("resolveRequestProfile (authed path: --org FLAG > --profile FLAG > WBHK_ORG env > WBHK_PROFILE > active > default)", () => {
  it("--org FLAG resolves strictly to the matching profile and rides the org along", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME, p_globex: ORG_GLOBEX }, {}, "p_globex");
    await expect(resolveRequestProfile(ctx, { org: "acme" })).resolves.toEqual({
      profile: "p_acme",
      org: ORG_ACME,
    });
  });

  it("--profile FLAG BEATS an ambient WBHK_ORG — uses the profile, no conflict, no WBHK_ORG read (F3)", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_ORG: "acme" }, "activep");
    await expect(resolveRequestProfile(ctx, { profile: "staging" })).resolves.toEqual({
      profile: "staging",
    });
  });

  it("WBHK_ORG env (no flags) resolves strictly — throws OrgNotFound for a stale value (F: actionable error)", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_ORG: "nonexistent" });
    await expect(resolveRequestProfile(ctx, {})).rejects.toBeInstanceOf(OrgNotFoundError);
  });

  it("WBHK_ORG env (no flags) resolves to its profile when it matches", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_ORG: "acme" });
    await expect(resolveRequestProfile(ctx, {})).resolves.toEqual({
      profile: "p_acme",
      org: ORG_ACME,
    });
  });

  it("--org FLAG + a DISAGREEING --profile FLAG → OrgProfileConflictError", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME });
    await expect(
      resolveRequestProfile(ctx, { org: "acme", profile: "p_acme_wrong" }),
    ).rejects.toBeInstanceOf(OrgProfileConflictError);
  });

  it("--org FLAG + an AGREEING --profile FLAG → resolves the named profile (disambiguates a multi-profile org)", async () => {
    // The org `acme` is bound under TWO profiles; `--org acme` alone would be ambiguous, but `--org acme
    // --profile prod` names which one — and must RESOLVE (not dead-end on AmbiguousOrgError, whose own
    // message tells the user to add --profile).
    const ctx = orgCtx({ prod: ORG_ACME, staging: ORG_ACME });
    await expect(resolveRequestProfile(ctx, { org: "acme", profile: "prod" })).resolves.toEqual({
      profile: "prod",
      org: ORG_ACME,
    });
  });

  it("an ambient WBHK_ORG NEVER conflicts with an explicit --profile (only two FLAGS conflict)", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_ORG: "acme" });
    await expect(resolveRequestProfile(ctx, { profile: "other" })).resolves.toEqual({
      profile: "other",
    });
  });

  it("no selector at all → the profile-only fallback (WBHK_PROFILE › active › default)", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_PROFILE: "envp" }, "activep");
    await expect(resolveRequestProfile(ctx, {})).resolves.toEqual({ profile: "envp" });
  });

  it("guards a reserved resolved profile name", async () => {
    const ctx = orgCtx({});
    await expect(resolveRequestProfile(ctx, { profile: "__proto__" })).rejects.toBeInstanceOf(
      InvalidProfileNameError,
    );
  });

  it("an explicitly-empty --org / --profile is treated as ABSENT (not a selector for '')", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_PROFILE: "envp" }, "activep");
    await expect(resolveRequestProfile(ctx, { org: "", profile: "" })).resolves.toEqual({
      profile: "envp",
    });
  });
});

describe("hasEnvApiKey / isEnvCredential (the shared env-credential guard)", () => {
  it("hasEnvApiKey is true iff WBHK_API_KEY is set non-empty", () => {
    expect(hasEnvApiKey({ process: { env: { WBHK_API_KEY: "whk_x" } } })).toBe(true);
    expect(hasEnvApiKey({ process: { env: { WBHK_API_KEY: "" } } })).toBe(false);
    expect(hasEnvApiKey({ process: { env: {} } })).toBe(false);
  });

  it("isEnvCredential is true when the env key is set OR getWithSource reports source 'env'", async () => {
    const envKeyCtx = { process: { env: { WBHK_API_KEY: "whk_x" } }, store: {} };
    await expect(isEnvCredential(envKeyCtx, "default")).resolves.toBe(true);

    const envSourceCtx = {
      process: { env: {} },
      store: { getWithSource: async () => ({ source: "env" }) },
    };
    await expect(isEnvCredential(envSourceCtx, "default")).resolves.toBe(true);

    const fileCtx = {
      process: { env: {} },
      store: { getWithSource: async () => ({ source: "file" }) },
    };
    await expect(isEnvCredential(fileCtx, "default")).resolves.toBe(false);
  });
});

describe("resolveRequestProfile — WBHK_API_KEY short-circuits the org selector (C2)", () => {
  it("refuses an --org FLAG while WBHK_API_KEY is set → OrgSelectorWithEnvKeyError (not OrgNotFound)", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_API_KEY: "whk_env" });
    await expect(resolveRequestProfile(ctx, { org: "acme" })).rejects.toBeInstanceOf(
      OrgSelectorWithEnvKeyError,
    );
  });

  it("IGNORES an ambient WBHK_ORG while WBHK_API_KEY is set (weak env: leftover vars never brick a command)", async () => {
    // Only an EXPLICIT --org FLAG is refused; an ambient WBHK_ORG is ignored (the env key serves the
    // credential regardless), so the command resolves profile-only instead of hard-failing.
    const ctx = orgCtx(
      { p_acme: ORG_ACME },
      { WBHK_API_KEY: "whk_env", WBHK_ORG: "acme" },
      "activep",
    );
    await expect(resolveRequestProfile(ctx, {})).resolves.toEqual({ profile: "activep" });
  });

  it("with WBHK_API_KEY set and NO --org flag → resolves the profile-only name, no scan/throw (an explicit --profile still wins)", async () => {
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_API_KEY: "whk_env" }, "activep");
    await expect(resolveRequestProfile(ctx, {})).resolves.toEqual({ profile: "activep" });
    await expect(resolveRequestProfile(ctx, { profile: "staging" })).resolves.toEqual({
      profile: "staging",
    });
  });

  it("WBHK_API_KEY + ambient WBHK_ORG + explicit --profile → honors --profile, never the env-key refusal", async () => {
    // The exact R3 regression: an explicit --profile must rescue a command even with both env vars set.
    const ctx = orgCtx({ p_acme: ORG_ACME }, { WBHK_API_KEY: "whk_env", WBHK_ORG: "nonexistent" });
    await expect(resolveRequestProfile(ctx, { profile: "staging" })).resolves.toEqual({
      profile: "staging",
    });
  });
});

// resolveEffectiveOrg decides which org a command treats as its target for LOCAL display + deep-linking
// (the dashboard event URL's slug). It was previously covered only INDIRECTLY, through the `targeting org`
// banner's tests — so removing that banner would have dropped these invariants' coverage while they stay
// load-bearing for the deep-link. Pinned directly here instead.
describe("resolveEffectiveOrg", () => {
  const ACME: Org = { id: "org_1", slug: "acme", name: "Acme, Inc." };
  const OTHER: Org = { id: "org_2", slug: "other", name: "Other Co" };

  /** A store whose getOrg records that it was consulted — the env case must never reach it. */
  function makeCtx(opts: {
    env?: Record<string, string | undefined>;
    storeOrg?: Org;
    source?: string;
    reads?: string[];
  }) {
    return {
      process: { env: opts.env ?? {} },
      store: {
        getWithSource: async () => (opts.source !== undefined ? { source: opts.source } : null),
        getOrg: async (profile: string) => {
          opts.reads?.push(profile);
          return opts.storeOrg;
        },
      },
    };
  }

  // THE guard. An env key's real org is server-determined, so the local store's org (left by some unrelated
  // login) does not describe it — trusting it built a WRONG-ORG dashboard deep-link.
  it("WBHK_API_KEY → envCredential, no org, and NEVER reads the local store", async () => {
    const reads: string[] = [];
    const ctx = makeCtx({ env: { WBHK_API_KEY: "whk_live_x" }, storeOrg: ACME, reads });
    await expect(resolveEffectiveOrg(ctx, "default")).resolves.toEqual({ envCredential: true });
    expect(reads).toEqual([]); // the store's org must not even be consulted
  });

  it("an env-SOURCED credential (getWithSource → 'env') gets the same guard", async () => {
    const reads: string[] = [];
    const ctx = makeCtx({ source: "env", storeOrg: ACME, reads });
    await expect(resolveEffectiveOrg(ctx, "default")).resolves.toEqual({ envCredential: true });
    expect(reads).toEqual([]);
  });

  it("an env key ignores even an explicit selector org (its org is server-side)", async () => {
    const ctx = makeCtx({ env: { WBHK_API_KEY: "whk_live_x" }, storeOrg: ACME });
    await expect(resolveEffectiveOrg(ctx, "default", OTHER)).resolves.toEqual({
      envCredential: true,
    });
  });

  it("a selector org wins over the profile's stored org", async () => {
    const ctx = makeCtx({ storeOrg: ACME });
    await expect(resolveEffectiveOrg(ctx, "default", OTHER)).resolves.toEqual({
      org: OTHER,
      envCredential: false,
    });
  });

  it("falls back to the profile's stored org when there's no selector", async () => {
    const ctx = makeCtx({ storeOrg: ACME });
    await expect(resolveEffectiveOrg(ctx, "default")).resolves.toEqual({
      org: ACME,
      envCredential: false,
    });
  });

  it("a fresh install (no stored org) yields no org rather than throwing", async () => {
    const ctx = makeCtx({});
    await expect(resolveEffectiveOrg(ctx, "default")).resolves.toEqual({
      org: undefined,
      envCredential: false,
    });
  });

  // A CORRUPT config must stay fail-loud: masking it as `no org` would send the user to `whoami` instead of
  // telling them to fix the real, actionable fault.
  it("propagates a corrupt-config throw instead of masking it as `no org`", async () => {
    const ctx = {
      process: { env: {} },
      store: {
        getOrg: async () => {
          throw new Error("config is corrupt");
        },
      },
    };
    await expect(resolveEffectiveOrg(ctx, "default")).rejects.toThrow(/corrupt/);
  });
});
