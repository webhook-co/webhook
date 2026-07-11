import { describe, expect, it } from "vitest";

import { CAPABILITY_SCOPES } from "./capability";
import { exceedsMintCeiling, mintableScopes } from "./mint-ceiling";

// A key must never be able to grant more than the human who created it. Without a ceiling, an org member
// blocked from the billing page can simply mint themselves a `billing:read` key and read billing over the
// API — which makes the owner/admin billing gate decorative — and can mint an `audit:read` key to read the
// org's tamper-evident compliance chain. Keys are DURABLE: one minted under permissive rules keeps working
// forever, so the ceiling has to exist before a second member does.

describe("mintableScopes", () => {
  it("owner and admin may mint every capability scope", () => {
    for (const role of ["owner", "admin"] as const) {
      expect([...mintableScopes(role)].sort()).toEqual([...CAPABILITY_SCOPES].sort());
    }
  });

  it("a member may mint the operational scopes — they legitimately have write", () => {
    const member = mintableScopes("member");
    for (const scope of [
      "endpoints:read",
      "endpoints:write",
      "events:read",
      "events:replay",
      "triggers:write",
    ] as const) {
      expect(member).toContain(scope);
    }
  });

  it("a member may NOT mint audit:read — reading the audit chain is admin-only", () => {
    expect(mintableScopes("member")).not.toContain("audit:read");
  });

  it("a member may NOT mint billing:read — or the owner/admin billing gate is decorative", () => {
    expect(mintableScopes("member")).not.toContain("billing:read");
  });

  it("a caller with NO membership may mint nothing (fails closed)", () => {
    expect(mintableScopes(null)).toEqual([]);
    expect(mintableScopes(undefined)).toEqual([]);
  });

  it("an UNKNOWN role mints nothing — a new role must be granted power deliberately", () => {
    // If a future migration adds a role and this file isn't updated, the safe answer is "no scopes",
    // never "all scopes".
    expect(mintableScopes("viewer" as never)).toEqual([]);
  });

  it("no role can mint outside the closed capability set", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      for (const scope of mintableScopes(role)) {
        expect(CAPABILITY_SCOPES).toContain(scope);
      }
    }
  });
});

describe("exceedsMintCeiling — the guard the mint chokepoint asserts", () => {
  it("reports the scopes a role may not grant", () => {
    expect(exceedsMintCeiling("member", ["events:read", "audit:read", "billing:read"])).toEqual([
      "audit:read",
      "billing:read",
    ]);
  });

  it("is empty when every requested scope is within the ceiling", () => {
    expect(exceedsMintCeiling("member", ["events:read", "endpoints:write"])).toEqual([]);
    expect(exceedsMintCeiling("owner", [...CAPABILITY_SCOPES])).toEqual([]);
  });

  it("a roleless caller exceeds the ceiling with ANY scope", () => {
    expect(exceedsMintCeiling(null, ["events:read"])).toEqual(["events:read"]);
  });

  it("an unknown scope is over the ceiling for every role (never silently accepted)", () => {
    expect(exceedsMintCeiling("owner", ["keys:manage"])).toEqual(["keys:manage"]);
  });
});
