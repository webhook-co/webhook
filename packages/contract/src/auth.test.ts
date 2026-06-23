import { describe, expect, it } from "vitest";

import {
  AudienceMismatchError,
  assertAudience,
  authenticateBearer,
  AuthContextSchema,
  authorizeBearer,
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  extractBearer,
  UnauthenticatedError,
  type AuthContext,
  type BearerAuthzDeps,
} from "./auth";
import { TargetSchema } from "./target";

const RESOURCE = "https://api.webhook.co";
const PRM_URL = "https://api.webhook.co/.well-known/oauth-protected-resource";

/** BearerAuthzDeps over a fake verifyBearer (asserts the resource it's called with). */
function deps(verifyBearer: BearerAuthzDeps["verifyBearer"]): BearerAuthzDeps {
  return { verifyBearer, resource: RESOURCE, resourceMetadataUrl: PRM_URL };
}

describe("audience binding (RFC 8707/9728)", () => {
  it("accepts a matching audience", () => {
    expect(() => assertAudience("https://mcp.webhook.co", "https://mcp.webhook.co")).not.toThrow();
  });

  it("rejects a mismatched or absent audience", () => {
    expect(() => assertAudience("https://api.webhook.co", "https://mcp.webhook.co")).toThrow(
      AudienceMismatchError,
    );
    expect(() => assertAudience(undefined, "https://mcp.webhook.co")).toThrow(
      AudienceMismatchError,
    );
  });
});

describe("RFC 9728 protected-resource metadata", () => {
  it("advertises the resource + authorization servers", () => {
    const prm = buildProtectedResourceMetadata({
      resource: "https://mcp.webhook.co",
      authorizationServers: ["https://auth.webhook.co"],
      scopesSupported: ["events:read"],
    });
    expect(prm.resource).toBe("https://mcp.webhook.co");
    expect(prm.authorization_servers).toEqual(["https://auth.webhook.co"]);
    expect(prm.bearer_methods_supported).toContain("header");
    expect(prm.scopes_supported).toEqual(["events:read"]);
  });

  it("builds a WWW-Authenticate challenge pointing at the PRM document", () => {
    const challenge = buildWwwAuthenticate(
      "https://mcp.webhook.co/.well-known/oauth-protected-resource",
      "invalid_token",
    );
    expect(challenge).toContain(
      'resource_metadata="https://mcp.webhook.co/.well-known/oauth-protected-resource"',
    );
    expect(challenge).toContain('error="invalid_token"');
  });
});

describe("authenticateBearer (scope-free identity auth)", () => {
  it("returns the AuthContext for a valid token (asserting the bound resource)", async () => {
    const ctx: AuthContext = { orgId: "org_1", scopes: ["events:read"] };
    const res = await authenticateBearer(
      deps(async (_token, audience) => {
        expect(audience).toBe(RESOURCE);
        return ctx;
      }),
      "Bearer tok",
    );
    expect(res).toEqual({ ok: true, ctx });
  });

  it("does not enforce any scope — an authenticated principal with no scopes still passes", async () => {
    const res = await authenticateBearer(
      deps(async () => ({ orgId: "org_1", scopes: [] })),
      "Bearer t",
    );
    expect(res.ok).toBe(true);
  });

  it("401s with an invalid_token challenge when no bearer is presented", async () => {
    const res = await authenticateBearer(
      deps(async () => {
        throw new Error("verifyBearer must not be called without a token");
      }),
      null,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.challenge).toContain('error="invalid_token"');
      expect(res.challenge).toContain("resource_metadata=");
    }
  });

  it("401s on an unauthenticated token (no principal resolves)", async () => {
    const res = await authenticateBearer(
      deps(async () => {
        throw new UnauthenticatedError();
      }),
      "Bearer bad",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it("401s on an audience mismatch (replayed token) without leaking which", async () => {
    const res = await authenticateBearer(
      deps(async () => {
        throw new AudienceMismatchError(RESOURCE, "https://mcp.webhook.co");
      }),
      "Bearer replayed",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it("rethrows an operational fault rather than masking it as a 401", async () => {
    await expect(
      authenticateBearer(
        deps(async () => {
          throw new Error("hyperdrive connection reset");
        }),
        "Bearer x",
      ),
    ).rejects.toThrow("hyperdrive connection reset");
  });
});

describe("AuthContextSchema", () => {
  it("accepts an org + scopes principal, with an optional userId", () => {
    expect(AuthContextSchema.safeParse({ orgId: "org_1", scopes: ["events:read"] }).success).toBe(
      true,
    );
    expect(
      AuthContextSchema.safeParse({ orgId: "org_1", userId: "usr_2", scopes: [] }).success,
    ).toBe(true);
  });

  it("rejects a principal missing orgId or scopes", () => {
    expect(AuthContextSchema.safeParse({ scopes: [] }).success).toBe(false);
    expect(AuthContextSchema.safeParse({ orgId: "org_1" }).success).toBe(false);
  });
});

describe("closed replay target", () => {
  it("accepts the localhost tunnel and rejects anything else", () => {
    expect(TargetSchema.safeParse({ kind: "localhost-tunnel", sessionId: "s1" }).success).toBe(
      true,
    );
    expect(TargetSchema.safeParse({ kind: "https", url: "https://evil.example" }).success).toBe(
      false,
    );
  });
});

// The WWW-Authenticate value is reflected into a response header; a resourceMetadataUrl with a
// control char or a quote/backslash could otherwise break out of the quoted-string and inject a
// second header. The URL is server-config (no live exploit today), but the encoder is the load-bearing
// guard, so pin it directly. (CS-01)
describe("buildWwwAuthenticate — header-injection encoder", () => {
  it("percent-encodes CR/LF/TAB, DEL, quote and backslash so nothing escapes the quoted-string", () => {
    const evil =
      'https://api.webhook.co/.well-known/oauth-protected-resource"\r\n\tX-Injected: 1\\\x7f';
    const challenge = buildWwwAuthenticate(evil, "invalid_token");

    // No raw control character survives anywhere in the header value (checked via includes, not a
    // control-char regex, to satisfy no-control-regex — mirroring the encoder's own char-code approach).
    for (const raw of ["\r", "\n", "\t", "\x00", "\x7f"]) {
      expect(challenge.includes(raw)).toBe(false);
    }
    // The dangerous bytes are present only in their percent-encoded form.
    expect(challenge).toContain("%0D%0A"); // CRLF
    expect(challenge).toContain("%09"); // TAB
    expect(challenge).toContain("%22"); // the injected double-quote
    expect(challenge).toContain("%5C"); // backslash
    expect(challenge).toContain("%7F"); // DEL
    // The structure is intact: exactly one challenge, the injected payload trapped inside the
    // quoted-string (no raw `"` inside resource_metadata="…"), with the error token appended.
    expect(challenge).toMatch(/^Bearer resource_metadata="[^"]*", error="invalid_token"$/);
  });

  it("omits the error param when none is given (still a single clean challenge)", () => {
    const challenge = buildWwwAuthenticate(PRM_URL);
    expect(challenge).toBe(`Bearer resource_metadata="${PRM_URL}"`);
  });
});

// extractBearer is the token-parsing front of every bearer surface; pin its RFC 6750/7235 contract
// directly (it was only covered transitively through authenticateBearer). (CS-02)
describe("extractBearer (RFC 6750/7235 scheme parsing)", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearer("Bearer tok")).toBe("tok");
  });

  it("treats the scheme case-insensitively", () => {
    expect(extractBearer("bearer tok")).toBe("tok");
    expect(extractBearer("BEARER tok")).toBe("tok");
  });

  it("accepts a multi-space separator and trims surrounding whitespace", () => {
    expect(extractBearer("Bearer    tok")).toBe("tok");
    expect(extractBearer("  Bearer tok  ")).toBe("tok");
  });

  it("returns null for absent, empty, or whitespace-only headers", () => {
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("")).toBeNull();
    expect(extractBearer("   ")).toBeNull();
  });

  it("returns null for a non-Bearer scheme or a bare token with no scheme", () => {
    expect(extractBearer("Basic abc123")).toBeNull();
    expect(extractBearer("token-without-a-scheme")).toBeNull();
  });

  it("returns null for a Bearer scheme with no token", () => {
    expect(extractBearer("Bearer")).toBeNull();
    expect(extractBearer("Bearer   ")).toBeNull();
  });
});

// authorizeBearer is the shared 401/403/ok decision both api and mcp run; pin it directly in the SoT
// package (previously only covered transitively by apps/api). `events.tail` requires `events:read`. (CS-02)
describe("authorizeBearer (scope-enforcing capability auth)", () => {
  const CAP = "events.tail";

  it("returns ok with the AuthContext when the token carries the capability's scope", async () => {
    const ctx: AuthContext = { orgId: "org_1", scopes: ["events:read"] };
    const res = await authorizeBearer(
      deps(async (_t, audience) => {
        expect(audience).toBe(RESOURCE);
        return ctx;
      }),
      "Bearer tok",
      CAP,
    );
    expect(res).toEqual({ ok: true, ctx });
  });

  it("403s insufficient_scope for an authenticated but under-scoped principal", async () => {
    const res = await authorizeBearer(
      deps(async () => ({ orgId: "org_1", scopes: ["endpoints:read"] })),
      "Bearer tok",
      CAP,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.challenge).toContain('error="insufficient_scope"');
    }
  });

  it("401s invalid_token when no bearer is presented (verifyBearer is never called)", async () => {
    const res = await authorizeBearer(
      deps(async () => {
        throw new Error("verifyBearer must not be called without a token");
      }),
      null,
      CAP,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.challenge).toContain('error="invalid_token"');
    }
  });

  it("401s on an unauthenticated token and on an audience mismatch, without leaking which", async () => {
    const unauth = await authorizeBearer(
      deps(async () => {
        throw new UnauthenticatedError();
      }),
      "Bearer bad",
      CAP,
    );
    const mismatch = await authorizeBearer(
      deps(async () => {
        throw new AudienceMismatchError(RESOURCE, "https://mcp.webhook.co");
      }),
      "Bearer replayed",
      CAP,
    );
    expect(unauth.ok).toBe(false);
    if (!unauth.ok) expect(unauth.status).toBe(401);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.status).toBe(401);
  });

  it("rethrows an operational fault rather than masking it as a 401", async () => {
    await expect(
      authorizeBearer(
        deps(async () => {
          throw new Error("kms timeout");
        }),
        "Bearer x",
        CAP,
      ),
    ).rejects.toThrow("kms timeout");
  });

  it("throws on an unknown capability (a programming error — fail closed, never a silent allow)", async () => {
    await expect(
      authorizeBearer(
        deps(async () => ({ orgId: "o", scopes: [] })),
        "Bearer x",
        "does.not.exist",
      ),
    ).rejects.toThrow(/unknown capability/);
  });
});
