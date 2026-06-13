import { AudienceMismatchError, type AuthContext } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "./credential";
import { InMemoryCredentialCache, type ResolvedPrincipal } from "./credential-cache";
import { createCredentialResolver } from "./credential-resolver";
import {
  InsufficientScopeError,
  UnauthenticatedError,
  makeVerifyBearer,
  requireScope,
} from "./verify-bearer";

const ORG = "22222222-2222-7222-8222-222222222222";
const API_RESOURCE = "https://api.webhook.co";
const MCP_RESOURCE = "https://mcp.webhook.co";

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xd4) });

function resolverFor(principal: ResolvedPrincipal | null) {
  const cache = new InMemoryCredentialCache();
  return createCredentialResolver({ hasher, cache, coldLookup: async () => principal });
}

describe("makeVerifyBearer (api-key path, §0.8)", () => {
  it("resolves a valid key to an AuthContext with org + scopes", async () => {
    const verify = makeVerifyBearer(
      resolverFor({ orgId: ORG, scopes: ["events:read"], audience: API_RESOURCE }),
    );
    const ctx = await verify("whk_good", API_RESOURCE);
    expect(ctx.orgId).toBe(ORG);
    expect(ctx.scopes).toEqual(["events:read"]);
  });

  it("throws UnauthenticatedError (-> 401) when no credential resolves", async () => {
    const verify = makeVerifyBearer(resolverFor(null));
    await expect(verify("whk_bad", API_RESOURCE)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("accepts a token presented at its bound audience (RFC 8707)", async () => {
    const verify = makeVerifyBearer(
      resolverFor({ orgId: ORG, scopes: [], audience: API_RESOURCE }),
    );
    await expect(verify("whk_good", API_RESOURCE)).resolves.toMatchObject({ orgId: ORG });
  });

  it("rejects a token replayed at a DIFFERENT resource (audience mismatch)", async () => {
    const verify = makeVerifyBearer(
      resolverFor({ orgId: ORG, scopes: [], audience: API_RESOURCE }),
    );
    await expect(verify("whk_good", MCP_RESOURCE)).rejects.toBeInstanceOf(AudienceMismatchError);
  });

  it("rejects a token with no audience binding", async () => {
    const verify = makeVerifyBearer(resolverFor({ orgId: ORG, scopes: [] }));
    await expect(verify("whk_good", API_RESOURCE)).rejects.toBeInstanceOf(AudienceMismatchError);
  });
});

describe("requireScope (authenticated-but-under-scoped -> 403)", () => {
  const ctx: AuthContext = { orgId: ORG, scopes: ["events:read"] };

  it("passes when the scope is present", () => {
    expect(() => requireScope(ctx, "events:read")).not.toThrow();
  });

  it("throws InsufficientScopeError (-> 403) when the scope is missing", () => {
    try {
      requireScope(ctx, "events:replay");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientScopeError);
      expect((err as InsufficientScopeError).requiredScope).toBe("events:replay");
    }
  });
});
