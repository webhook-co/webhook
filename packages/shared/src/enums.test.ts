import { describe, expect, it } from "vitest";

import { canGrantRole, MEMBERSHIP_ROLES, roleRank } from "./enums";

describe("roleRank", () => {
  it("ranks owner highest (0), member lowest, unknown as Infinity (fails safe)", () => {
    expect(roleRank("owner")).toBe(0);
    expect(roleRank("admin")).toBe(1);
    expect(roleRank("member")).toBe(2);
    expect(roleRank("bogus")).toBe(Number.POSITIVE_INFINITY);
    // The rank IS the array index — the enum order is the privilege order.
    expect(MEMBERSHIP_ROLES.map(roleRank)).toEqual([0, 1, 2]);
  });
});

describe("canGrantRole — you cannot hand out more than you hold", () => {
  it("lets an actor grant its own role or anything below", () => {
    expect(canGrantRole("owner", "owner")).toBe(true);
    expect(canGrantRole("owner", "admin")).toBe(true);
    expect(canGrantRole("owner", "member")).toBe(true);
    expect(canGrantRole("admin", "admin")).toBe(true);
    expect(canGrantRole("admin", "member")).toBe(true);
    expect(canGrantRole("member", "member")).toBe(true);
  });

  it("refuses granting a role above the actor's own", () => {
    expect(canGrantRole("admin", "owner")).toBe(false);
    expect(canGrantRole("member", "admin")).toBe(false);
    expect(canGrantRole("member", "owner")).toBe(false);
  });

  it("fails closed for unknown roles (actor or target)", () => {
    expect(canGrantRole("bogus", "member")).toBe(false); // unknown actor grants nothing
    expect(canGrantRole("owner", "bogus")).toBe(false); // unknown target is never grantable
    expect(canGrantRole("bogus", "bogus")).toBe(false);
  });
});
