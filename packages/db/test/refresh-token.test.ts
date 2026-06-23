import { randomUUID } from "node:crypto";

import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { mintScopedKey, revokeGrant } from "../src/grants";
import {
  consumeRefreshToken,
  findRefreshTokenGrant,
  mintRefreshToken,
  revokeRefreshTokensForGrant,
} from "../src/refresh-token";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Lane C A2b-2a — the auth_refresh_token store against a REAL Postgres. The opaque ~90d refresh handle
// embeds its org (rtk_<orgId>_<secret>) so the issuer resolves the tenant WITHOUT a cross-org role; the
// secret entropy (hashed with the credential pepper) is the only thing that authenticates it. Consume is
// a single atomic UPDATE…FROM auth_grant that enforces single-use + grant-active + not-expired, then
// rotates in the same tx. webhook_app only — RLS-org-scoped throughout.

const API = "https://api.webhook.co";
const MCP = "https://mcp.webhook.co";
const REFRESH_TTL = 7_776_000; // ~90d
const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x9a) });

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql; // webhook_owner — the better-auth "user" table is global + ungranted to webhook_app
let auditKey: CryptoKey;

function userOf(orgId: string): string {
  return `u_${orgId.slice(0, 8)}`;
}

async function seedOrg(orgId: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${userOf(orgId)}, ${"Seed"}, ${`${orgId.slice(0, 8)}@e.test`}, ${true}, now())`;
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"Org"})`;
  });
}

/** Seed an org + an active grant (approval off ⇒ minted/active), returning the grant id. */
async function seedGrant(orgId: string, audience = API): Promise<string> {
  await seedOrg(orgId);
  const res = await mintScopedKey(
    app,
    {
      orgId,
      userId: userOf(orgId),
      scopes: ["events:read"],
      audience,
      ttlSeconds: 3600,
      authMethod: "pkce_loopback",
    },
    hasher,
    auditKey,
  );
  if (res.status !== "minted") throw new Error("seedGrant: expected minted");
  return res.grantId;
}

async function rowState(
  orgId: string,
  tokenHash: Buffer,
): Promise<
  { used_at: Date | null; revoked_at: Date | null; replaced_by: string | null } | undefined
> {
  const [row] = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ used_at: Date | null; revoked_at: Date | null; replaced_by: string | null }[]>`
        select used_at, revoked_at, replaced_by from auth_refresh_token where token_hash = ${tokenHash}`,
  );
  return row;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 13) % 256)),
  );
}, 90_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await pg?.stop();
});

describe("mintRefreshToken", () => {
  it("mints an org-embedded, hashed handle bound to the grant + audience", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId, MCP);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: MCP, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    expect(minted.plaintext.startsWith(`rtk_${orgId}_`)).toBe(true);
    expect(minted.refreshTokenId).toMatch(/^[0-9a-f-]{36}$/);
    expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now() + REFRESH_TTL * 1000 - 60_000);
    // Only the hash is stored — never the plaintext.
    const [stored] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ grant_id: string; audience: string; prefix: string }[]>`
          select grant_id, audience, prefix from auth_refresh_token where id = ${minted.refreshTokenId}`,
    );
    expect(stored).toMatchObject({ grant_id: grantId, audience: MCP, prefix: "rtk" });
  });
});

describe("consumeRefreshToken", () => {
  it("consumes a valid handle once → returns grant/org/audience + a fresh rotated handle", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId, API);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    const result = await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ grantId, orgId, audience: API });
    expect(result!.newRefresh).not.toEqual(minted.plaintext);
    expect(result!.newRefresh.startsWith(`rtk_${orgId}_`)).toBe(true);

    // The consumed row is marked used + points at its replacement.
    const consumed = await rowState(orgId, hasher.hash(minted.plaintext));
    expect(consumed?.used_at).not.toBeNull();
    expect(consumed?.replaced_by).not.toBeNull();
  });

  it("is single-use — a replay of an already-consumed handle returns null", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    const first = await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL);
    expect(first).not.toBeNull();
    const replay = await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL);
    expect(replay).toBeNull();
  });

  it("two concurrent consumes of the same handle: exactly one wins", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    const [a, b] = await Promise.all([
      consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL),
      consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL),
    ]);
    const wins = [a, b].filter((r) => r !== null);
    expect(wins).toHaveLength(1);
  });

  it("the rotated handle is itself consumable; the old one stays dead", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    const first = await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL);
    const second = await consumeRefreshToken(app, first!.newRefresh, hasher, REFRESH_TTL);
    expect(second).not.toBeNull();
    expect(second).toMatchObject({ grantId, orgId });
    // The original is still dead.
    expect(await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL)).toBeNull();
  });

  it("rejects an unknown / malformed handle", async () => {
    const orgId = randomUUID();
    await seedGrant(orgId);
    expect(await consumeRefreshToken(app, "not-a-token", hasher, REFRESH_TTL)).toBeNull();
    expect(await consumeRefreshToken(app, `rtk_${orgId}_deadbeef`, hasher, REFRESH_TTL)).toBeNull();
    expect(await consumeRefreshToken(app, `rtk_${randomUUID()}_x`, hasher, REFRESH_TTL)).toBeNull();
    // Right shape, wrong prefix (not ours) → not parsed as a handle.
    expect(await consumeRefreshToken(app, `xyz_${orgId}_secret`, hasher, REFRESH_TTL)).toBeNull();
    // Empty org segment → not a UUID → rejected.
    expect(await consumeRefreshToken(app, "rtk__secret", hasher, REFRESH_TTL)).toBeNull();
  });

  it("rejects a handle whose embedded org was tampered (hash covers the org)", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    // Swap the org segment to another (existing) org — the hash no longer matches anything.
    const otherOrg = randomUUID();
    await seedGrant(otherOrg);
    const tampered = minted.plaintext.replace(orgId, otherOrg);
    expect(await consumeRefreshToken(app, tampered, hasher, REFRESH_TTL)).toBeNull();
    // …and the genuine handle is still usable (the tamper attempt didn't burn it).
    expect(await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL)).not.toBeNull();
  });

  it("rejects an expired handle", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: -10 },
      hasher,
    );
    expect(await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL)).toBeNull();
  });

  it("rejects a handle whose grant is no longer active (revoked grant can't refresh)", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    await revokeGrant(app, { orgId, grantId, reason: "test" }, auditKey);
    expect(await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL)).toBeNull();
    // The revoked grant's gate means the token wasn't consumed — it's simply unusable.
    expect((await rowState(orgId, hasher.hash(minted.plaintext)))?.used_at).toBeNull();
  });

  it("rejects a handle whose GRANT is past its expiry (refresh can't outlive the grant lifetime)", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );
    // The grant itself expires (status stays 'active' — no sweep flips it); the handle still has ~90d.
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`update auth_grant set expires_at = now() - interval '1 hour' where id = ${grantId}`,
    );
    expect(await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL)).toBeNull();
    expect((await rowState(orgId, hasher.hash(minted.plaintext)))?.used_at).toBeNull();
  });

  it("still consumes a handle minted under a PREVIOUS pepper (rotation-tolerant via candidates)", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    // Minted under the current pepper…
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );
    // …then the pepper rotates: the old one becomes `previous`. The outstanding handle must still work.
    const rotated = createCredentialHasher({
      current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xbb),
      previous: [Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x9a)],
    });
    const result = await consumeRefreshToken(app, minted.plaintext, rotated, REFRESH_TTL);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ grantId, orgId });
  });
});

describe("consumeRefreshToken — opportunistic expiry sweep", () => {
  // A consume opportunistically prunes the CURRENT org's already-expired handles (housekeeping,
  // org-scoped under the existing DELETE RLS — no cross-org role). It must NOT touch fresh rows
  // (including the just-rotated successor), and a prune failure must never fail the consume.

  /** Insert an already-expired handle directly (mints can't produce a past expiry without -ttl). */
  async function seedExpiredHandle(orgId: string, grantId: string): Promise<Buffer> {
    const hash = hasher.hash(`rtk_${orgId}_expired_${randomUUID()}`);
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into auth_refresh_token
             (id, org_id, grant_id, audience, token_hash, prefix, start, expires_at)
           values (${randomUUID()}, ${orgId}, ${grantId}, ${API}, ${hash}, ${"rtk"}, ${"rtk_expired"},
                   now() - interval '1 hour')`,
    );
    return hash;
  }

  async function exists(orgId: string, tokenHash: Buffer): Promise<boolean> {
    const [row] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ n: number }[]>`select 1 as n from auth_refresh_token where token_hash = ${tokenHash}`,
    );
    return row !== undefined;
  }

  it("prunes the org's expired handles on consume, keeping fresh + just-rotated rows", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const expiredHash = await seedExpiredHandle(orgId, grantId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    const result = await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL);
    expect(result).not.toBeNull();

    // The pre-existing expired handle is swept away.
    expect(await exists(orgId, expiredHash)).toBe(false);
    // The consumed (used-but-unexpired) handle survives — /revoke still resolves it.
    expect(await exists(orgId, hasher.hash(minted.plaintext))).toBe(true);
    // The freshly rotated successor survives — it has ~90d to live.
    expect(await exists(orgId, hasher.hash(result!.newRefresh))).toBe(true);
  });

  it("does not sweep another org's expired handles (org-scoped)", async () => {
    const otherOrg = randomUUID();
    const otherGrant = await seedGrant(otherOrg);
    const otherExpired = await seedExpiredHandle(otherOrg, otherGrant);

    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );
    await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL);

    // The OTHER org's expired handle is untouched — the sweep only sees current_org_id().
    expect(await exists(otherOrg, otherExpired)).toBe(true);
  });

  it("returns the consume result even when the sweep fails (non-fatal housekeeping)", async () => {
    // Inject a real prune failure: revoke webhook_app's DELETE on the table so the post-consume sweep
    // errors. The consume (the load-bearing op) MUST still commit + return; the sweep error is swallowed.
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    await owner`revoke delete on auth_refresh_token from webhook_app`;
    try {
      const result = await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL);
      // The consume committed + rotated despite the sweep being unable to delete.
      expect(result).toMatchObject({ grantId, orgId, audience: API });
      expect(result!.newRefresh.startsWith(`rtk_${orgId}_`)).toBe(true);
      expect((await rowState(orgId, hasher.hash(minted.plaintext)))?.used_at).not.toBeNull();
    } finally {
      // Restore the grant so the rest of the suite (and other orgs) keep their sweep behavior.
      await owner`grant delete on auth_refresh_token to webhook_app`;
    }
  });
});

describe("revokeRefreshTokensForGrant", () => {
  it("revokes all of a grant's handles so none can be consumed", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const a = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );
    const b = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );

    const count = await revokeRefreshTokensForGrant(app, { orgId, grantId });
    expect(count).toBe(2);
    expect(await consumeRefreshToken(app, a.plaintext, hasher, REFRESH_TTL)).toBeNull();
    expect(await consumeRefreshToken(app, b.plaintext, hasher, REFRESH_TTL)).toBeNull();
  });
});

describe("findRefreshTokenGrant (the /revoke rtk_ -> grant resolver)", () => {
  it("resolves a handle to its grant — even after it's consumed (no status filter, idempotent revoke)", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );
    expect(await findRefreshTokenGrant(app, minted.plaintext, hasher)).toEqual({ orgId, grantId });
    // After consume (used_at set) the handle still resolves to its grant — /revoke must find it.
    await consumeRefreshToken(app, minted.plaintext, hasher, REFRESH_TTL);
    expect(await findRefreshTokenGrant(app, minted.plaintext, hasher)).toEqual({ orgId, grantId });
  });

  it("returns null for a malformed / unknown / tampered-org handle", async () => {
    const orgId = randomUUID();
    const grantId = await seedGrant(orgId);
    const minted = await mintRefreshToken(
      app,
      { orgId, grantId, audience: API, ttlSeconds: REFRESH_TTL },
      hasher,
    );
    expect(await findRefreshTokenGrant(app, "not-a-handle", hasher)).toBeNull();
    expect(await findRefreshTokenGrant(app, `rtk_${randomUUID()}_x`, hasher)).toBeNull();
    // Swapping the embedded org breaks the hash (it covers the whole plaintext) → no match.
    const otherOrg = randomUUID();
    await seedGrant(otherOrg);
    expect(
      await findRefreshTokenGrant(app, minted.plaintext.replace(orgId, otherOrg), hasher),
    ).toBeNull();
  });
});
