import { AudienceMismatchError } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { type Sql } from "./client";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "./credential";
import { InMemoryCredentialCache } from "./credential-cache";
import { API_RESOURCE, makeApiKeyAuthDeps, MCP_RESOURCE } from "./auth-deps";

const ORG = "22222222-2222-7222-8222-222222222222";
const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xd4) });

// A stand-in authn `Sql`: the cold lookup runs `authn`select ... from api_keys where key_hash = ${h}``,
// so this returns one row whose key_hash matches the plaintext's hash. The factory's resolver +
// coldLookup chain then resolves with NO database — exercising exactly the wiring the factory owns.
function mockAuthn(plaintext: string): Sql {
  const keyHash = hasher.hash(plaintext);
  const row = {
    org_id: ORG,
    scopes: [] as string[],
    expires_at: null,
    revoked_at: null,
    key_hash: keyHash,
  };
  return ((..._args: unknown[]) => Promise.resolve([row])) as unknown as Sql;
}

function depsFor(resource: string, plaintext: string) {
  return makeApiKeyAuthDeps({
    hasher,
    authn: mockAuthn(plaintext),
    cache: new InMemoryCredentialCache(),
    resource,
  });
}

describe("makeApiKeyAuthDeps (single-sourced api-key auth wiring)", () => {
  it("exposes the resource it was built with", () => {
    expect(depsFor(API_RESOURCE, "whk_x").resource).toBe(API_RESOURCE);
  });

  it("returns a verifyBearer that resolves a valid key to its org", async () => {
    const ctx = await depsFor(API_RESOURCE, "whk_good").verifyBearer("whk_good", API_RESOURCE);
    expect(ctx.orgId).toBe(ORG);
  });

  it("binds the audience: a key from an api-resource factory is rejected at the mcp audience", async () => {
    const deps = depsFor(API_RESOURCE, "whk_good");
    await expect(deps.verifyBearer("whk_good", MCP_RESOURCE)).rejects.toBeInstanceOf(
      AudienceMismatchError,
    );
  });

  it("exports the canonical surface audiences (single-sourced for api/engine/mcp)", () => {
    expect(API_RESOURCE).toBe("https://api.webhook.co");
    expect(MCP_RESOURCE).toBe("https://mcp.webhook.co");
  });
});
