import { describe, expect, it } from "vitest";

import { grantPropsToAuthContext, MalformedGrantError } from "./grant";

const ORG = "44444444-4444-7444-8444-444444444444";

describe("grantPropsToAuthContext", () => {
  it("maps well-formed props to an AuthContext (with userId)", () => {
    const ctx = grantPropsToAuthContext({ orgId: ORG, userId: "user_1", scopes: ["events:read"] });
    expect(ctx).toEqual({ orgId: ORG, userId: "user_1", scopes: ["events:read"] });
  });

  it("omits userId when absent (not present as undefined)", () => {
    const ctx = grantPropsToAuthContext({ orgId: ORG, scopes: [] });
    expect(ctx).toEqual({ orgId: ORG, scopes: [] });
    expect("userId" in ctx).toBe(false);
  });

  it.each([
    ["null", null],
    ["a non-object", "nope"],
    ["missing orgId", { scopes: [] }],
    ["an empty orgId", { orgId: "", scopes: [] }],
    ["a non-string orgId", { orgId: 123, scopes: [] }],
    ["missing scopes", { orgId: ORG }],
    ["non-array scopes", { orgId: ORG, scopes: "events:read" }],
    ["a non-string scope element", { orgId: ORG, scopes: ["events:read", 7] }],
    ["a non-string userId", { orgId: ORG, scopes: [], userId: 9 }],
  ])("throws MalformedGrantError on %s", (_label, props) => {
    expect(() => grantPropsToAuthContext(props)).toThrow(MalformedGrantError);
  });

  it("does not let a poisoned scopes array slip a non-string through to a scope check", () => {
    // A grant whose scopes array holds a non-string must be rejected wholesale, not silently
    // coerced — otherwise a later `scopes.includes(cap.scope)` could behave unexpectedly.
    expect(() => grantPropsToAuthContext({ orgId: ORG, scopes: [["events:read"]] })).toThrow(
      MalformedGrantError,
    );
  });
});
