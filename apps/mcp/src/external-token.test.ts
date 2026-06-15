import {
  AudienceMismatchError,
  UnauthenticatedError,
  type AuthContext,
  type VerifyBearer,
} from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { resolveApiKeyToProps } from "./external-token";

const RESOURCE = "https://mcp.webhook.co";

/** A verifyBearer that returns a fixed AuthContext, asserting it was called with our resource. */
function resolvesTo(ctx: AuthContext): VerifyBearer {
  return async (_token, audience) => {
    expect(audience).toBe(RESOURCE);
    return ctx;
  };
}

describe("resolveApiKeyToProps", () => {
  it("maps a resolved principal to grant props bound to this resource's audience", async () => {
    const result = await resolveApiKeyToProps(
      { verifyBearer: resolvesTo({ orgId: "org_1", scopes: ["events:read"] }), resource: RESOURCE },
      "whsk_live_abc",
    );
    expect(result).toEqual({
      props: { orgId: "org_1", scopes: ["events:read"] },
      audience: RESOURCE,
    });
  });

  it("carries a userId through when the principal has one", async () => {
    const result = await resolveApiKeyToProps(
      {
        verifyBearer: resolvesTo({ orgId: "org_1", userId: "usr_9", scopes: ["audit:read"] }),
        resource: RESOURCE,
      },
      "tok",
    );
    expect(result?.props).toEqual({ orgId: "org_1", userId: "usr_9", scopes: ["audit:read"] });
  });

  it("returns null when no credential resolves (provider answers 401)", async () => {
    const verifyBearer: VerifyBearer = async () => {
      throw new UnauthenticatedError();
    };
    expect(await resolveApiKeyToProps({ verifyBearer, resource: RESOURCE }, "bad")).toBeNull();
  });

  it("returns null on an audience mismatch (a replayed token), without leaking which", async () => {
    const verifyBearer: VerifyBearer = async () => {
      throw new AudienceMismatchError(RESOURCE, "https://api.webhook.co");
    };
    expect(await resolveApiKeyToProps({ verifyBearer, resource: RESOURCE }, "tok")).toBeNull();
  });

  it("re-throws an operational fault rather than masquerading it as a 401", async () => {
    const verifyBearer: VerifyBearer = async () => {
      throw new Error("hyperdrive connection reset");
    };
    await expect(
      resolveApiKeyToProps({ verifyBearer, resource: RESOURCE }, "tok"),
    ).rejects.toThrow("hyperdrive connection reset");
  });
});
