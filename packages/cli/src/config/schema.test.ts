import { describe, expect, it } from "vitest";

import {
  CONFIG_VERSION,
  ConfigFileSchema,
  credentialAccessToken,
  isOAuthCredential,
  migrateConfigShape,
  OrgSchema,
  ProfileSchema,
  StoredCredentialSchema,
  type OAuthCredential,
} from "./schema.js";

const oauthCred: OAuthCredential = {
  oauth: {
    accessKey: "whk_access",
    refreshToken: "rtk_refresh",
    authMethod: "loopback",
    expiresAt: 1_700_000_000_000,
    audience: "https://api.webhook.co",
    clientId: "client_abc",
  },
};

describe("StoredCredential union", () => {
  it("accepts the legacy bare-api-key variant", () => {
    const r = StoredCredentialSchema.safeParse({ apiKey: "whk_legacy" });
    expect(r.success).toBe(true);
  });

  it("accepts the OAuth variant", () => {
    expect(StoredCredentialSchema.safeParse(oauthCred).success).toBe(true);
  });

  it("rejects an OAuth variant missing the refresh token", () => {
    const bad = { oauth: { ...oauthCred.oauth, refreshToken: "" } };
    expect(StoredCredentialSchema.safeParse(bad).success).toBe(false);
  });

  it("isOAuthCredential discriminates the two variants", () => {
    expect(isOAuthCredential(oauthCred)).toBe(true);
    expect(isOAuthCredential({ apiKey: "whk_x" })).toBe(false);
  });

  it("credentialAccessToken returns the whk_ bearer from either variant", () => {
    expect(credentialAccessToken({ apiKey: "whk_x" })).toBe("whk_x");
    expect(credentialAccessToken(oauthCred)).toBe("whk_access");
  });
});

describe("migrateConfigShape", () => {
  it("upgrades v1 → current (carrying profiles + adding no data)", () => {
    const out = migrateConfigShape({ version: 1, profiles: { default: {} } }) as {
      version: number;
      profiles: Record<string, unknown>;
    };
    expect(out.version).toBe(CONFIG_VERSION);
    expect(out.profiles.default).toEqual({});
  });

  it("upgrades v2 → v3 (the OAuth-credential bump, purely a version change)", () => {
    const out = migrateConfigShape({
      version: 2,
      activeProfile: "staging",
      profiles: { default: { credential: { apiKey: "whk_v2" } } },
    }) as { version: number; activeProfile: string; profiles: Record<string, unknown> };
    expect(out.version).toBe(3);
    expect(out.activeProfile).toBe("staging");
    expect(out.profiles.default).toEqual({ credential: { apiKey: "whk_v2" } });
  });

  it("leaves a current-version config untouched", () => {
    const cfg = { version: CONFIG_VERSION, profiles: {} };
    expect(migrateConfigShape(cfg)).toEqual(cfg);
  });

  it("leaves an unknown/future version untouched (so the schema rejects it)", () => {
    expect(migrateConfigShape({ version: 999 })).toEqual({ version: 999 });
  });

  it("STAYS at CONFIG_VERSION 3 — no v3→v4 rung (org is an additive optional field, not a version bump)", () => {
    // Bumping the version to add `org` would make a new-CLI config unreadable by any older/pinned CLI whose
    // `z.literal(3)` throws CorruptConfig — a downgrade-corruption for anyone running two CLI versions. An
    // optional additive field needs no bump; this guards against a future contributor adding a rung.
    expect(CONFIG_VERSION).toBe(3);
    const v3 = { version: 3 as const, profiles: {} };
    expect(migrateConfigShape(v3)).toEqual(v3); // v3 in → v3 out, untouched
  });
});

describe("ProfileSchema.org (additive, optional — no version bump)", () => {
  it("accepts a profile carrying an org {id,slug,name}", () => {
    const parsed = ProfileSchema.safeParse({
      credential: { apiKey: "whk_x" },
      org: { id: "org_1", slug: "acme", name: "Acme Inc" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.org).toEqual({ id: "org_1", slug: "acme", name: "Acme Inc" });
  });

  it("accepts a profile WITHOUT org (a pre-org config still parses at version 3)", () => {
    const parsed = ProfileSchema.safeParse({ credential: { apiKey: "whk_x" } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.org).toBeUndefined();
  });

  it("a version-3 config whose profile carries org validates (proving no bump is needed)", () => {
    const parsed = ConfigFileSchema.safeParse({
      version: 3,
      profiles: { acme: { org: { id: "o", slug: "acme", name: "Acme" } } },
    });
    expect(parsed.success).toBe(true);
  });

  it("OrgSchema rejects empty fields", () => {
    expect(OrgSchema.safeParse({ id: "o", slug: "acme", name: "" }).success).toBe(false);
    expect(OrgSchema.safeParse({ id: "", slug: "acme", name: "Acme" }).success).toBe(false);
  });
});
