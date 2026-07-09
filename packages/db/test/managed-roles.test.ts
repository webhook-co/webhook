import { describe, expect, it } from "vitest";

import { DB_ROLES } from "../src/constants";
import { ROLES_NEEDING_PASSWORDS } from "./migrate";
import { MANAGED_ROLES } from "./pg";

// The harness mints a per-run SCRAM password for every MANAGED_ROLE (pg.ts) and must then ALTER
// each one onto the role (migrate.ts). When those two lists were maintained by hand they drifted:
// `webhook_meter_audit` (migration 0046) and `webhook_billing` (migration 0047) got passwords minted
// into their connection URLs but never set on the role, so every connection as them failed with
// `28P01 password authentication failed`. That only reproduces in PASSWORD mode (the Neon nightly) —
// local/CI trust auth ignores passwords entirely, so the whole gate stayed green while three billing
// suites were broken against the real engine.
//
// Both lists are now DERIVED from DB_ROLES. These tests pin that derivation so a future role can
// never be added to DB_ROLES without also getting harness credentials.

describe("managed test roles", () => {
  it("mints a password for EVERY role in DB_ROLES (no role can be added without credentials)", () => {
    expect([...MANAGED_ROLES].sort()).toEqual(Object.values(DB_ROLES).sort());
  });

  it("sets a password on every managed role except the owner (bootstrapOwner sets that one)", () => {
    const expected = Object.values(DB_ROLES)
      .filter((r) => r !== DB_ROLES.owner)
      .sort();
    expect([...ROLES_NEEDING_PASSWORDS].sort()).toEqual(expected);
  });

  it("excludes the owner, whose password is set before the migrations run", () => {
    expect(ROLES_NEEDING_PASSWORDS).not.toContain(DB_ROLES.owner);
  });

  it("covers the billing roles that regressed the nightly (0046 meter_audit, 0047 billing)", () => {
    expect(ROLES_NEEDING_PASSWORDS).toContain(DB_ROLES.meterAudit);
    expect(ROLES_NEEDING_PASSWORDS).toContain(DB_ROLES.billing);
    expect(ROLES_NEEDING_PASSWORDS).toContain(DB_ROLES.meter);
  });
});
