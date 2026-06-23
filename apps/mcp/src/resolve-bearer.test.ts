import { type AuthContext, UnauthenticatedError, type VerifyBearer } from "@webhook-co/contract";
import { describe, expect, it, vi } from "vitest";

import { hasMultipleCredentials, makeResourceVerifyBearer } from "./resolve-bearer";

// A8a — the two-validator front door: mcp accepts EITHER a first-party `whk_` access key (resolved by
// the api-key chain) OR an opaque OAuth provider token (validated by introspection). The validator is
// chosen by the token PREFIX — exactly one runs, never both (no fall-through that would let an attacker
// probe one validator with the other's reject). Both validators audience-bind internally.

const RESOURCE = "https://mcp.webhook.co";
const CTX: AuthContext = { orgId: "org_1", scopes: ["events:read"] };

describe("makeResourceVerifyBearer", () => {
  it("routes a `whk_` token to the api-key validator only", async () => {
    const apiKeyVerify = vi.fn<VerifyBearer>(async () => CTX);
    const introspectVerify = vi.fn<VerifyBearer>(async () => CTX);
    const verify = makeResourceVerifyBearer({ apiKeyVerify, introspectVerify });

    expect(await verify("whk_abc123", RESOURCE)).toEqual(CTX);
    expect(apiKeyVerify).toHaveBeenCalledWith("whk_abc123", RESOURCE);
    expect(introspectVerify).not.toHaveBeenCalled();
  });

  it("routes a non-`whk_` (opaque provider) token to the introspection validator only", async () => {
    const apiKeyVerify = vi.fn<VerifyBearer>(async () => CTX);
    const introspectVerify = vi.fn<VerifyBearer>(async () => CTX);
    const verify = makeResourceVerifyBearer({ apiKeyVerify, introspectVerify });

    expect(await verify("AbCdEf.opaque.token", RESOURCE)).toEqual(CTX);
    expect(introspectVerify).toHaveBeenCalledWith("AbCdEf.opaque.token", RESOURCE);
    expect(apiKeyVerify).not.toHaveBeenCalled();
  });

  it("does NOT fall back to introspection when the api-key validator rejects a `whk_` token", async () => {
    const apiKeyVerify = vi.fn<VerifyBearer>(async () => {
      throw new UnauthenticatedError();
    });
    const introspectVerify = vi.fn<VerifyBearer>(async () => CTX);
    const verify = makeResourceVerifyBearer({ apiKeyVerify, introspectVerify });

    await expect(verify("whk_revoked", RESOURCE)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(introspectVerify).not.toHaveBeenCalled();
  });

  it("does NOT fall back to the api-key validator when introspection rejects an opaque token", async () => {
    const apiKeyVerify = vi.fn<VerifyBearer>(async () => CTX);
    const introspectVerify = vi.fn<VerifyBearer>(async () => {
      throw new UnauthenticatedError();
    });
    const verify = makeResourceVerifyBearer({ apiKeyVerify, introspectVerify });

    await expect(verify("opaque", RESOURCE)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(apiKeyVerify).not.toHaveBeenCalled();
  });

  it("treats the bare prefix `whk` (no underscore) as opaque — only `whk_` is the api-key shape", async () => {
    const apiKeyVerify = vi.fn<VerifyBearer>(async () => CTX);
    const introspectVerify = vi.fn<VerifyBearer>(async () => CTX);
    const verify = makeResourceVerifyBearer({ apiKeyVerify, introspectVerify });

    await verify("whknotakey", RESOURCE);
    expect(introspectVerify).toHaveBeenCalledOnce();
    expect(apiKeyVerify).not.toHaveBeenCalled();
  });
});

describe("hasMultipleCredentials", () => {
  it("returns false for a single well-formed credential", () => {
    expect(hasMultipleCredentials("Bearer whk_token")).toBe(false);
  });

  it("returns false for an absent / empty header", () => {
    expect(hasMultipleCredentials(null)).toBe(false);
    expect(hasMultipleCredentials(undefined)).toBe(false);
    expect(hasMultipleCredentials("")).toBe(false);
    expect(hasMultipleCredentials("   ")).toBe(false);
  });

  it("returns true when the Fetch API coalesced two Authorization headers (comma-joined)", () => {
    // Duplicate `Authorization` headers are coalesced by the Fetch API into one comma-joined value.
    expect(hasMultipleCredentials("Bearer aaa, Bearer bbb")).toBe(true);
  });

  it("returns true for two credentials of different schemes", () => {
    expect(hasMultipleCredentials("Bearer aaa, Basic Zm9vOmJhcg==")).toBe(true);
  });

  it("ignores empty list members (a trailing comma is a single credential)", () => {
    expect(hasMultipleCredentials("Bearer whk_token,")).toBe(false);
    expect(hasMultipleCredentials(", Bearer whk_token")).toBe(false);
  });
});
