import type { CreatedApiKey } from "@webhook-co/db/api-keys";
import type { Sql } from "@webhook-co/db/client";
import { describe, expect, it, vi } from "vitest";

import { mintApiKey, type MintApiKeyDeps } from "./credential-mint";

// A direct, injected unit test of the credential-mint web glue — the exact surface whose imports once
// resolved to `undefined` under the bundler ("(void 0) is not a function"). The hasher + audit-key
// transforms (createCredentialHasherFromBase64 / importAuditKey) run for REAL here, so an undefined
// import would throw; only the boundaries (DB pool, secrets, the DB write) are injected.

// A 32-byte key as standard base64 — what CREDENTIAL_PEPPER / AUDIT_CHAIN_HMAC_KEY hold.
const B64_32 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

const CREATED: CreatedApiKey = {
  id: "key_db_1",
  orgId: "o",
  name: "CI deploy",
  scopes: ["events:read"],
  start: "whk_3f9a…7c1d",
  expiresAt: null,
  plaintext: `whk_${"a".repeat(40)}`,
};

function makeDeps(over: Partial<MintApiKeyDeps> = {}): {
  deps: MintApiKeyDeps;
  end: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn().mockResolvedValue(undefined);
  const deps: MintApiKeyDeps = {
    getDb: vi.fn().mockResolvedValue({ end } as unknown as Sql),
    getPepper: vi.fn().mockResolvedValue(B64_32),
    getAuditChainKey: vi.fn().mockResolvedValue(B64_32),
    createKey: vi.fn().mockResolvedValue(CREATED),
    ...over,
  };
  return { deps, end };
}

describe("mintApiKey (web glue)", () => {
  it("wires the tenant pool, real hasher + audit key, and the DB write, then returns the created key", async () => {
    const { deps, end } = makeDeps();
    const result = await mintApiKey(
      { orgId: "o", userId: "u", name: "CI deploy", scopes: ["events:read"] },
      deps,
    );

    expect(result).toBe(CREATED);
    // the DB write gets the narrowed input + a real hasher + a real audit key + the principal as actor
    expect(deps.createKey).toHaveBeenCalledWith(
      expect.anything(), // the pool from getDb
      { orgId: "o", name: "CI deploy", scopes: ["events:read"] },
      expect.anything(), // hasher (createCredentialHasherFromBase64 ran for real)
      expect.anything(), // audit key (importAuditKey ran for real)
      "u",
    );
    // It must NOT close the client. The REQUEST owns it now (server/db.ts): it is shared by every loader and
    // action in the request and closed once, after the response. A caller closing it would pull the connection
    // out from under everything else in the same render — so "does not close" is the invariant worth pinning,
    // and this assertion is the inverse of the one that used to be here.
    expect(end).not.toHaveBeenCalled();
  });

  // The old version of this test asserted the pool was released on the throw path. That was right when this
  // function OWNED the pool. It no longer does — so releasing it here would now be the bug, and a failed mint
  // must leave the shared client intact for the rest of the request (which still has a response to render,
  // including the error state this throw produces).
  it("leaves the shared client open when the DB write throws, and still surfaces the error", async () => {
    const { deps, end } = makeDeps({ createKey: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(
      mintApiKey({ orgId: "o", userId: "u", name: "k", scopes: ["events:read"] }, deps),
    ).rejects.toThrow("db down");
    expect(end).not.toHaveBeenCalled();
  });
});
