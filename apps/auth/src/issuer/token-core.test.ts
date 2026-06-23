import { describe, expect, it, vi } from "vitest";

import {
  redeemAuthCode,
  redeemRefresh,
  type AuthCodeDeps,
  type ConsentProps,
  type RefreshDeps,
} from "./token-core";

// A2a — the Option-B `/token` redemption + mint core (pure logic, injected seams; ADR-0010 r5/r7).
// These tests are the riskiest-assumption de-risk: they prove the redeem → unwrap → mint → frozen-body
// chain + the mandatory security gates (audience-from-consent, scope-cannot-widen on BOTH paths,
// tenancy bind, revoke-provider-grant-after-mint, consume-refresh-BEFORE-mint, compensate-on-partial-
// failure, no token material in logs) with FAKE provider/mint/store deps. The real provider wiring is
// A2b. The frozen body is the C↔D contract (lane-c plan §10).

const API_RESOURCE = "https://api.webhook.co";
const MCP_RESOURCE = "https://mcp.webhook.co";
const CAPABILITY_SCOPES = ["endpoints:read", "events:read", "events:replay", "audit:read"] as const;
const KEY_TTL = 86_400;

function consent(overrides: Partial<ConsentProps> = {}): ConsentProps {
  return {
    orgId: "org_1",
    userId: "user_1",
    scopes: ["events:read", "events:replay"],
    audience: API_RESOURCE,
    ...overrides,
  };
}

/** A minted whk_ fake (the plaintext is fake-shaped, never a literal token — gitleaks). */
const FAKE_WHK = `whk_${"a".repeat(40)}`;
const FAKE_REFRESH = `rt_${"b".repeat(40)}`;

function authCodeDeps(overrides: Partial<AuthCodeDeps> = {}): AuthCodeDeps {
  return {
    allowedAudiences: [API_RESOURCE, MCP_RESOURCE],
    allowedScopes: CAPABILITY_SCOPES,
    keyTtlSeconds: KEY_TTL,
    exchangeAuthCode: vi.fn(async () => ({ ok: true as const, opaque: "opaque_xyz" })),
    unwrapToken: vi.fn(async () => ({ providerGrantId: "pg_1", props: consent() })),
    revokeProviderGrant: vi.fn(async () => {}),
    rollbackMint: vi.fn(async () => {}),
    isOrgMember: vi.fn(async () => true),
    mintScopedKey: vi.fn(async () => ({
      status: "minted" as const,
      grantId: "g_1",
      plaintext: FAKE_WHK,
      keyId: "k_1",
      expiresAt: new Date(0),
    })),
    issueRefreshToken: vi.fn(async () => FAKE_REFRESH),
    defaultPendingInterval: 5,
    ...overrides,
  };
}

const mintMock = (deps: AuthCodeDeps) => deps.mintScopedKey as ReturnType<typeof vi.fn>;

const authCodeReq = {
  grant_type: "authorization_code" as const,
  code: "code_1",
  code_verifier: "verifier_1",
  redirect_uri: "http://127.0.0.1:53123/cb",
  client_id: "wbhk",
  resource: API_RESOURCE,
};

describe("redeemAuthCode — happy path", () => {
  it("returns the frozen C↔D /token body with the minted whk_ as access_token", async () => {
    const deps = authCodeDeps();
    const result = await redeemAuthCode(deps, authCodeReq);

    expect(result).toEqual({
      kind: "token",
      body: {
        access_token: FAKE_WHK,
        token_type: "Bearer",
        expires_in: KEY_TTL,
        refresh_token: FAKE_REFRESH,
        scope: "events:read events:replay",
        resource: API_RESOURCE,
      },
    });
    // The refresh handle is issued for the minted grant with the consent org + audience (so the store
    // embeds the org + denormalizes the audience — never from the request body).
    expect(deps.issueRefreshToken).toHaveBeenCalledWith("g_1", "org_1", API_RESOURCE);
  });

  it("passes the configured ttl + the consent device to the mint", async () => {
    const deps = authCodeDeps({
      unwrapToken: vi.fn(async () => ({
        providerGrantId: "pg_1",
        props: consent({ device: { name: "wbhk on a laptop" } }),
      })),
    });
    await redeemAuthCode(deps, authCodeReq);
    expect(mintMock(deps).mock.calls[0][0]).toMatchObject({
      ttlSeconds: KEY_TTL,
      device: { name: "wbhk on a laptop" },
    });
  });
});

describe("redeemAuthCode — audience binding (BLOCKER-2)", () => {
  it("mints for the CONSENT-recorded props.audience, never the request resource", async () => {
    // Consent recorded mcp.; the request asks for api. — the mint must use props.audience (mcp.).
    const deps = authCodeDeps({
      unwrapToken: vi.fn(async () => ({
        providerGrantId: "pg_1",
        props: consent({ audience: MCP_RESOURCE }),
      })),
    });
    const result = await redeemAuthCode(deps, { ...authCodeReq, resource: API_RESOURCE });

    expect(result.kind).toBe("token");
    expect(mintMock(deps).mock.calls[0][0]).toMatchObject({ audience: MCP_RESOURCE });
    if (result.kind === "token") expect(result.body.resource).toBe(MCP_RESOURCE);
  });

  it("rejects when props.audience is not one of the allowed resources", async () => {
    const deps = authCodeDeps({
      unwrapToken: vi.fn(async () => ({
        providerGrantId: "pg_1",
        props: consent({ audience: "https://evil.example" }),
      })),
    });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result).toMatchObject({ kind: "error", error: "invalid_target" });
    expect(deps.mintScopedKey).not.toHaveBeenCalled();
  });

  it("rejects an empty/absent props.audience (never mint with a blank audience — NIT-1)", async () => {
    const deps = authCodeDeps({
      unwrapToken: vi.fn(async () => ({
        providerGrantId: "pg_1",
        props: consent({ audience: "" }),
      })),
    });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result).toMatchObject({ kind: "error", error: "invalid_target" });
    expect(deps.mintScopedKey).not.toHaveBeenCalled();
  });
});

describe("redeemAuthCode — scope cannot widen on first issuance (MAJOR-C)", () => {
  it("mints only the intersection of consent ∩ capability (drops non-capability scopes)", async () => {
    const deps = authCodeDeps({
      unwrapToken: vi.fn(async () => ({
        providerGrantId: "pg_1",
        props: consent({ scopes: ["events:read", "keys:manage"] }),
      })),
    });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result.kind).toBe("token");
    expect(mintMock(deps).mock.calls[0][0]).toMatchObject({ scopes: ["events:read"] });
    if (result.kind === "token") expect(result.body.scope).toBe("events:read");
  });

  it("rejects when no consented scope survives the capability intersection", async () => {
    const deps = authCodeDeps({
      unwrapToken: vi.fn(async () => ({
        providerGrantId: "pg_1",
        props: consent({ scopes: ["keys:manage"] }),
      })),
    });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result).toMatchObject({ kind: "error", error: "invalid_scope" });
    expect(deps.mintScopedKey).not.toHaveBeenCalled();
    expect(deps.revokeProviderGrant).not.toHaveBeenCalled();
  });
});

describe("redeemAuthCode — tenancy bind (MAJOR-5)", () => {
  it("rejects when props.orgId is not an org the token user belongs to", async () => {
    const deps = authCodeDeps({ isOrgMember: vi.fn(async () => false) });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result).toMatchObject({ kind: "error" });
    expect(deps.mintScopedKey).not.toHaveBeenCalled();
  });
});

describe("redeemAuthCode — revoke the provider grant after mint (G1 / R4)", () => {
  it("revokes the provider's grant once the whk_ is minted (kills the opaque access+refresh)", async () => {
    const deps = authCodeDeps();
    await redeemAuthCode(deps, authCodeReq);
    // Provider grant is keyed by user → revoked with (providerGrantId, consent userId).
    expect(deps.revokeProviderGrant).toHaveBeenCalledWith("pg_1", "user_1");
  });

  it("does NOT revoke the provider grant if the mint did not succeed", async () => {
    const deps = authCodeDeps({ isOrgMember: vi.fn(async () => false) });
    await redeemAuthCode(deps, authCodeReq);
    expect(deps.revokeProviderGrant).not.toHaveBeenCalled();
  });
});

describe("redeemAuthCode — partial failure compensation (MAJOR-B)", () => {
  it("rolls back the minted key and errors if the refresh token cannot be issued", async () => {
    const deps = authCodeDeps({
      issueRefreshToken: vi.fn(async () => {
        throw new Error("kv down");
      }),
    });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result).toMatchObject({ kind: "error", error: "server_error" });
    expect(deps.rollbackMint).toHaveBeenCalledWith("g_1", "org_1");
    // The provider grant is revoked AFTER the refresh is issued, so a refresh failure must not have
    // killed it (it will TTL out; the opaque token was never delivered to the caller).
    expect(deps.revokeProviderGrant).not.toHaveBeenCalled();
  });

  it("still returns the token when the best-effort provider-grant revoke fails (no orphaned client)", async () => {
    const log = vi.fn();
    const deps = authCodeDeps({
      log,
      revokeProviderGrant: vi.fn(async () => {
        throw new Error("revoke down");
      }),
    });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result.kind).toBe("token");
    if (result.kind === "token") expect(result.body.access_token).toBe(FAKE_WHK);
    expect(deps.rollbackMint).not.toHaveBeenCalled();
    // The failure is recorded so the vestigial provider grant can be reaped.
    const events = (log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("issuer.provider_grant_revoke_failed");
  });

  it("emits the revoke-failed counter on the SILENT no-op branch (consent userId != provider-grant userId)", async () => {
    // G1: the provider keys grants by user, so revokeGrant(grantId, consentUserId) silently no-ops when the
    // consent-written userId differs from the userId the provider grant is actually stored under — leaving a
    // vestigial (never-delivered) opaque grant to TTL out. The revoke dep doesn't throw, so without this
    // counter the no-op was invisible. The mint still succeeds (the opaque was never delivered to the caller).
    const log = vi.fn();
    const deps = authCodeDeps({
      log,
      unwrapToken: vi.fn(async () => ({
        providerGrantId: "pg_1",
        props: consent({ userId: "user_consent" }),
        grantUserId: "user_provider", // the grant is keyed under a DIFFERENT user → revoke will no-op
      })),
      // Tenancy + scope checks use the CONSENT userId, so keep them passing for this user.
      isOrgMember: vi.fn(async () => true),
    });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result.kind).toBe("token"); // the client still gets its credentials
    const events = (log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("issuer.provider_grant_revoke_failed");
    // The counter carries no token/PII material — only a short machine-readable reason.
    const logged = JSON.stringify((log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain("user_consent");
    expect(logged).not.toContain("user_provider");
  });
});

describe("redeemAuthCode — pending approval (R1, dormant v1)", () => {
  it("returns authorization_pending with NO token + does not issue a refresh when the mint is pending", async () => {
    const deps = authCodeDeps({
      mintScopedKey: vi.fn(async () => ({
        status: "pending_approval" as const,
        grantId: "g_pending",
      })),
    });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result).toEqual({ kind: "pending", grantId: "g_pending", interval: 5 });
    expect(deps.issueRefreshToken).not.toHaveBeenCalled();
    expect(deps.revokeProviderGrant).not.toHaveBeenCalled();
  });
});

describe("redeemAuthCode — provider exchange / unwrap failures", () => {
  it("propagates the OAuth error code but NOT the provider's free-text description (MINOR-E)", async () => {
    const deps = authCodeDeps({
      exchangeAuthCode: vi.fn(async () => ({
        ok: false as const,
        error: "invalid_grant" as const,
        description: "sensitive-provider-internal-detail",
      })),
    });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result).toMatchObject({ kind: "error", error: "invalid_grant" });
    if (result.kind === "error") {
      expect(result.description ?? "").not.toContain("sensitive-provider-internal-detail");
    }
    expect(deps.unwrapToken).not.toHaveBeenCalled();
    expect(deps.mintScopedKey).not.toHaveBeenCalled();
  });

  it("rejects when the opaque token does not unwrap (invalid/expired)", async () => {
    const deps = authCodeDeps({ unwrapToken: vi.fn(async () => null) });
    const result = await redeemAuthCode(deps, authCodeReq);
    expect(result).toMatchObject({ kind: "error" });
    expect(deps.mintScopedKey).not.toHaveBeenCalled();
  });
});

describe("redeemAuthCode — no token material in logs (MINOR-1)", () => {
  it("never logs the access_token, refresh_token, code, code_verifier, or opaque token", async () => {
    const log = vi.fn();
    const deps = authCodeDeps({ log });
    await redeemAuthCode(deps, authCodeReq);
    const logged = JSON.stringify((log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain(FAKE_WHK);
    expect(logged).not.toContain(FAKE_REFRESH);
    expect(logged).not.toContain("code_1");
    expect(logged).not.toContain("verifier_1");
    expect(logged).not.toContain("opaque_xyz");
  });
});

function refreshDeps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    allowedAudiences: [API_RESOURCE, MCP_RESOURCE],
    allowedScopes: CAPABILITY_SCOPES,
    keyTtlSeconds: KEY_TTL,
    consumeRefresh: vi.fn(async () => ({
      grantId: "g_1",
      orgId: "org_1",
      audience: API_RESOURCE,
      newRefresh: FAKE_REFRESH,
    })),
    listGrantScopes: vi.fn(async () => ["events:read", "events:replay"]),
    mintKeyForGrant: vi.fn(async () => ({
      plaintext: FAKE_WHK,
      keyId: "k_2",
      expiresAt: new Date(0),
    })),
    ...overrides,
  };
}

const mintForGrantMock = (deps: RefreshDeps) => deps.mintKeyForGrant as ReturnType<typeof vi.fn>;

const refreshReq = {
  grant_type: "refresh_token" as const,
  refresh_token: FAKE_REFRESH,
  client_id: "wbhk",
  resource: API_RESOURCE,
  scope: "events:read events:replay",
};

describe("redeemRefresh — silent re-mint", () => {
  it("re-mints a fresh whk_ on the grant and returns the frozen body with the grant audience", async () => {
    const deps = refreshDeps();
    const result = await redeemRefresh(deps, refreshReq);
    expect(result).toEqual({
      kind: "token",
      body: {
        access_token: FAKE_WHK,
        token_type: "Bearer",
        expires_in: KEY_TTL,
        refresh_token: FAKE_REFRESH,
        scope: "events:read events:replay",
        resource: API_RESOURCE,
      },
    });
    // The grant's org + audience (from the consumed handle) are threaded into both seams — never the request.
    expect(mintForGrantMock(deps).mock.calls[0][0]).toMatchObject({
      grantId: "g_1",
      orgId: "org_1",
      audience: API_RESOURCE,
      ttlSeconds: KEY_TTL,
    });
    expect(deps.listGrantScopes).toHaveBeenCalledWith("g_1", "org_1");
  });

  it("keeps the full consented set when the request omits scope", async () => {
    const deps = refreshDeps();
    const { scope: _drop, ...noScope } = refreshReq;
    const result = await redeemRefresh(deps, noScope);
    expect(result.kind).toBe("token");
    if (result.kind === "token") expect(result.body.scope).toBe("events:read events:replay");
  });
});

describe("redeemRefresh — consume-before-mint / replay (BLOCKER-A)", () => {
  it("rejects with invalid_grant when the refresh token is unknown or already consumed", async () => {
    const deps = refreshDeps({ consumeRefresh: vi.fn(async () => null) });
    const result = await redeemRefresh(deps, refreshReq);
    expect(result).toMatchObject({ kind: "error", error: "invalid_grant" });
    expect(deps.mintKeyForGrant).not.toHaveBeenCalled();
  });

  it("consumes the presented token exactly once before minting (no concurrent double-mint)", async () => {
    // The store yields the grant on first consume, then null (already used). A replay must not mint.
    let consumed = false;
    const deps = refreshDeps({
      consumeRefresh: vi.fn(async () => {
        if (consumed) return null;
        consumed = true;
        return { grantId: "g_1", orgId: "org_1", audience: API_RESOURCE, newRefresh: FAKE_REFRESH };
      }),
    });
    const first = await redeemRefresh(deps, refreshReq);
    const replay = await redeemRefresh(deps, refreshReq);
    expect(first.kind).toBe("token");
    expect(replay).toMatchObject({ kind: "error", error: "invalid_grant" });
    expect(deps.mintKeyForGrant).toHaveBeenCalledTimes(1);
  });
});

describe("redeemRefresh — scope cannot widen (BLOCKER-3 / R5)", () => {
  it("mints only the intersection of requested ∩ grant-consented ∩ capability (no widening)", async () => {
    // The grant consented only {events:read}; the request asks for events:read + keys:manage.
    const deps = refreshDeps({ listGrantScopes: vi.fn(async () => ["events:read"]) });
    const result = await redeemRefresh(deps, { ...refreshReq, scope: "events:read keys:manage" });
    expect(result.kind).toBe("token");
    expect(mintForGrantMock(deps).mock.calls[0][0]).toMatchObject({ scopes: ["events:read"] });
    if (result.kind === "token") expect(result.body.scope).toBe("events:read");
  });

  it("de-duplicates repeated scopes", async () => {
    const deps = refreshDeps({ listGrantScopes: vi.fn(async () => ["events:read"]) });
    const result = await redeemRefresh(deps, { ...refreshReq, scope: "events:read events:read" });
    expect(result.kind).toBe("token");
    if (result.kind === "token") expect(result.body.scope).toBe("events:read");
  });

  it("rejects with invalid_scope when nothing survives the intersection", async () => {
    const deps = refreshDeps({ listGrantScopes: vi.fn(async () => ["events:read"]) });
    const result = await redeemRefresh(deps, { ...refreshReq, scope: "keys:manage" });
    expect(result).toMatchObject({ kind: "error", error: "invalid_scope" });
    expect(deps.mintKeyForGrant).not.toHaveBeenCalled();
  });
});

describe("redeemRefresh — audience integrity (M2)", () => {
  it("rejects when the grant's stored audience is not an allowed resource", async () => {
    const deps = refreshDeps({
      consumeRefresh: vi.fn(async () => ({
        grantId: "g_1",
        orgId: "org_1",
        audience: "https://evil.example",
        newRefresh: FAKE_REFRESH,
      })),
    });
    const result = await redeemRefresh(deps, refreshReq);
    expect(result).toMatchObject({ kind: "error", error: "invalid_target" });
    expect(deps.mintKeyForGrant).not.toHaveBeenCalled();
  });
});

describe("redeemRefresh — no token material in logs", () => {
  it("never logs the access_token or refresh_token", async () => {
    const log = vi.fn();
    const deps = refreshDeps({ log });
    await redeemRefresh(deps, refreshReq);
    const logged = JSON.stringify((log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain(FAKE_WHK);
    expect(logged).not.toContain(FAKE_REFRESH);
  });
});
