import {
  AudienceMismatchError,
  UnauthenticatedError,
  type IntrospectionResult,
} from "@webhook-co/contract";
import { describe, expect, it, vi } from "vitest";

import { makeIntrospectVerifyBearer } from "./introspect-client";

// A8a — the opaque-token validator: mcp (the resource server) can't validate a provider token locally
// (it's KV-bound to auth.), so it introspects it over the AUTH_ISSUER service binding and adapts the
// result to the shared VerifyBearer seam — including the RFC 8707 audience re-check mcp owns.

const RESOURCE = "https://mcp.webhook.co";

/** An introspector returning a fixed result. */
function introspectsTo(result: IntrospectionResult) {
  return makeIntrospectVerifyBearer({ introspect: async () => result });
}

describe("makeIntrospectVerifyBearer", () => {
  it("maps an active, audience-matching token to an AuthContext", async () => {
    const verify = introspectsTo({
      active: true,
      orgId: "org_1",
      scopes: ["events:read"],
      audience: RESOURCE,
    });
    expect(await verify("opaque-tok", RESOURCE)).toEqual({
      orgId: "org_1",
      scopes: ["events:read"],
    });
  });

  it("accepts an array audience bound solely to this resource", async () => {
    const verify = introspectsTo({
      active: true,
      orgId: "org_1",
      scopes: ["events:read"],
      audience: [RESOURCE],
    });
    expect(await verify("tok", RESOURCE)).toEqual({ orgId: "org_1", scopes: ["events:read"] });
  });

  it("carries a userId through when the principal has one", async () => {
    const verify = introspectsTo({
      active: true,
      orgId: "org_1",
      userId: "usr_9",
      scopes: ["audit:read"],
      audience: RESOURCE,
    });
    expect(await verify("tok", RESOURCE)).toEqual({
      orgId: "org_1",
      userId: "usr_9",
      scopes: ["audit:read"],
    });
  });

  it("passes the presented token to the introspector verbatim", async () => {
    const introspect = vi.fn(
      async (): Promise<IntrospectionResult> => ({
        active: true,
        orgId: "org_1",
        scopes: [],
        audience: RESOURCE,
      }),
    );
    await makeIntrospectVerifyBearer({ introspect })("the-opaque-token", RESOURCE);
    expect(introspect).toHaveBeenCalledWith("the-opaque-token");
  });

  it("rejects an inactive token as unauthenticated (401)", async () => {
    const verify = introspectsTo({ active: false });
    await expect(verify("tok", RESOURCE)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("rejects a token bound to a different resource (RFC 8707 audience re-check)", async () => {
    const verify = introspectsTo({
      active: true,
      orgId: "org_1",
      scopes: ["events:read"],
      audience: "https://api.webhook.co",
    });
    await expect(verify("tok", RESOURCE)).rejects.toBeInstanceOf(AudienceMismatchError);
  });

  it("rejects an active token with no audience (cannot confirm the binding)", async () => {
    const verify = introspectsTo({ active: true, orgId: "org_1", scopes: ["events:read"] });
    await expect(verify("tok", RESOURCE)).rejects.toBeInstanceOf(AudienceMismatchError);
  });

  it("rejects a multi-resource token even when it includes this resource (no parallel credential)", async () => {
    // A token also bound to api. would be usable there too — mcp doesn't honor it (RFC 8707 + R4),
    // and faithful (non-collapsed) audiences are what make this rejection possible.
    const verify = introspectsTo({
      active: true,
      orgId: "org_1",
      scopes: ["events:read"],
      audience: [RESOURCE, "https://api.webhook.co"],
    });
    await expect(verify("tok", RESOURCE)).rejects.toBeInstanceOf(AudienceMismatchError);
  });

  it("fails closed when an active result carries no usable org (never proceed with an undefined principal)", async () => {
    const verify = introspectsTo({ active: true, scopes: ["events:read"], audience: RESOURCE });
    await expect(verify("tok", RESOURCE)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("fails closed when an active result's scopes are not all strings", async () => {
    const verify = introspectsTo({
      active: true,
      orgId: "org_1",
      // a poisoned/garbled scope element must not slip past a later scope check
      scopes: ["events:read", 42 as unknown as string],
      audience: RESOURCE,
    });
    await expect(verify("tok", RESOURCE)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("fails closed when an active result's userId is present but not a string", async () => {
    const verify = introspectsTo({
      active: true,
      orgId: "org_1",
      scopes: ["events:read"],
      audience: RESOURCE,
      userId: 42 as unknown as string,
    });
    await expect(verify("tok", RESOURCE)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("re-throws an operational fault (binding down) rather than masking it as a 401", async () => {
    const verify = makeIntrospectVerifyBearer({
      introspect: async () => {
        throw new Error("service binding unreachable");
      },
    });
    await expect(verify("tok", RESOURCE)).rejects.toThrow("service binding unreachable");
  });
});
