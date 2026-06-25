import { describe, expect, it } from "vitest";

import { insertApiKey } from "./api-keys";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "./credential";
import { verifyKeyChecksum } from "./key-checksum";
import type { TenantTx } from "./client";

const hasher = createCredentialHasher({
  current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xa1),
});

/**
 * A fake tenant tx: the tagged-template call resolves to no rows, and `.json` is identity.
 * Lets us exercise insertApiKey's mint+return contract without a real Postgres connection —
 * we only assert the minted plaintext shape, not the SQL.
 */
function fakeTx(): TenantTx {
  const tx = (() => Promise.resolve([])) as unknown as TenantTx & { json: (v: unknown) => unknown };
  tx.json = (v: unknown) => v;
  return tx;
}

describe("insertApiKey mint format (ADR-0073)", () => {
  it("mints a checksummed whk_ key (whk_ + 49 base62 chars) that self-verifies", async () => {
    const created = await insertApiKey(
      fakeTx(),
      { orgId: "8f3854f2-4aee-4357-80d1-e5d323a011b5", name: "test", scopes: ["events:read"] },
      hasher,
    );
    expect(created.plaintext).toMatch(/^whk_[0-9A-Za-z]{49}$/);
    expect(created.plaintext).toHaveLength(53);
    expect(verifyKeyChecksum("whk", created.plaintext)).toBe(true);
    // start stays an 11-char non-secret prefix; key_hash covers the full plaintext.
    expect(created.start).toHaveLength(11);
    expect(created.plaintext.startsWith(created.start)).toBe(true);
    expect(created.keyHash).toEqual(hasher.hash(created.plaintext));
  });
});
