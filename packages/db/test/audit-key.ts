import { importAuditKey } from "@webhook-co/shared";

/**
 * A fixed, non-secret audit-chain key for tests that must PASS an audit key (e.g. createOrgWithOwner, which
 * appends `org_created` in-tx and so requires one) but do not assert on the chain itself. Matches the constant
 * `new Uint8Array(32).fill(7)` used across the suite so audited rows are reproducible.
 */
export function testAuditKey(): Promise<CryptoKey> {
  return importAuditKey(new Uint8Array(32).fill(7));
}
