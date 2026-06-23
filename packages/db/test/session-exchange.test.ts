import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import {
  consumeSessionExchange,
  mintSessionExchange,
  parseSessionExchangeOrg,
} from "../src/session-exchange";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Lane C A-SX-1 — the auth_session_exchange store against a REAL Postgres. The single-use opaque ticket
// embeds its org (sxt_<orgId>_<secret>) so the redeem resolves the tenant WITHOUT a cross-org role; consume
// is one atomic UPDATE…used_at enforcing single-use + not-expired + audience-match. webhook_app only,
// RLS-org-scoped.

const APP = "https://app.webhook.co";
const OTHER = "https://evil.example.com";
const TTL = 300;
const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x5e) });

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql; // webhook_owner — seeds the better-auth "user" row (global, ungranted to webhook_app)

function userOf(orgId: string): string {
  return `u_${orgId.slice(0, 8)}`;
}

async function seedOrg(): Promise<{ orgId: string; userId: string }> {
  const orgId = randomUUID();
  const userId = userOf(orgId);
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${userId}, ${"Seed"}, ${`${orgId.slice(0, 8)}@e.test`}, ${true}, now())`;
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"Org"})`;
  });
  return { orgId, userId };
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
}, 90_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await pg?.stop();
});

describe("parseSessionExchangeOrg", () => {
  it("extracts the embedded org from a well-formed handle, rejects anything else", () => {
    const org = randomUUID();
    expect(parseSessionExchangeOrg(`sxt_${org}_secret`)).toBe(org);
    expect(parseSessionExchangeOrg(`rtk_${org}_secret`)).toBeNull(); // wrong prefix
    expect(parseSessionExchangeOrg("sxt_not-a-uuid_secret")).toBeNull();
    expect(parseSessionExchangeOrg("sxt_only")).toBeNull();
    expect(parseSessionExchangeOrg("")).toBeNull();
  });
});

describe("mint + consume", () => {
  it("mints a sxt_ ticket bound to the user + app origin, consumable exactly once", async () => {
    const { orgId, userId } = await seedOrg();
    const minted = await mintSessionExchange(
      app,
      { orgId, userId, audience: APP, ttlSeconds: TTL },
      hasher,
    );
    expect(minted.plaintext.startsWith(`sxt_${orgId}_`)).toBe(true);
    expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const first = await consumeSessionExchange(app, minted.plaintext, hasher, APP);
    expect(first).toEqual({ userId, orgId, audience: APP });
    // single-use: a replay finds the row already used → null.
    expect(await consumeSessionExchange(app, minted.plaintext, hasher, APP)).toBeNull();
  });

  it("does NOT consume (or burn) a ticket whose audience differs from the redeemer", async () => {
    const { orgId, userId } = await seedOrg();
    const minted = await mintSessionExchange(
      app,
      { orgId, userId, audience: APP, ttlSeconds: TTL },
      hasher,
    );
    // a wrong-origin redeem attempt matches nothing AND leaves the ticket usable.
    expect(await consumeSessionExchange(app, minted.plaintext, hasher, OTHER)).toBeNull();
    expect(await consumeSessionExchange(app, minted.plaintext, hasher, APP)).toEqual({
      userId,
      orgId,
      audience: APP,
    });
  });

  it("does not consume an expired ticket", async () => {
    const { orgId, userId } = await seedOrg();
    const minted = await mintSessionExchange(
      app,
      { orgId, userId, audience: APP, ttlSeconds: -10 },
      hasher,
    );
    expect(await consumeSessionExchange(app, minted.plaintext, hasher, APP)).toBeNull();
  });

  it("returns null for an unknown or malformed handle", async () => {
    const { orgId } = await seedOrg();
    expect(await consumeSessionExchange(app, `sxt_${orgId}_nope`, hasher, APP)).toBeNull();
    expect(await consumeSessionExchange(app, "not-a-ticket", hasher, APP)).toBeNull();
  });

  it("two concurrent redemptions: exactly one wins (atomic single-use)", async () => {
    const { orgId, userId } = await seedOrg();
    const minted = await mintSessionExchange(
      app,
      { orgId, userId, audience: APP, ttlSeconds: TTL },
      hasher,
    );
    const [a, b] = await Promise.all([
      consumeSessionExchange(app, minted.plaintext, hasher, APP),
      consumeSessionExchange(app, minted.plaintext, hasher, APP),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("prunes the org's expired tickets on a successful consume (org-scoped housekeeping)", async () => {
    const { orgId, userId } = await seedOrg();
    // An already-expired ticket lingering in this org's table.
    const expiredHash = hasher.hash(`sxt_${orgId}_expired_${randomUUID()}`);
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into auth_session_exchange
             (id, org_id, user_id, audience, token_hash, prefix, start, expires_at)
           values (${randomUUID()}, ${orgId}, ${userId}, ${APP}, ${expiredHash}, ${"sxt"}, ${"sxt_expired"},
                   now() - interval '1 hour')`,
    );
    // A fresh, valid ticket we will redeem.
    const minted = await mintSessionExchange(
      app,
      { orgId, userId, audience: APP, ttlSeconds: TTL },
      hasher,
    );

    const consumed = await consumeSessionExchange(app, minted.plaintext, hasher, APP);
    expect(consumed).toEqual({ userId, orgId, audience: APP });

    const present = async (h: Buffer): Promise<boolean> => {
      const [row] = await withTenant(
        app,
        orgId,
        (tx) =>
          tx<{ n: number }[]>`select 1 as n from auth_session_exchange where token_hash = ${h}`,
      );
      return row !== undefined;
    };
    // The expired ticket is swept; the just-consumed (used-but-unexpired) ticket lingers harmlessly.
    expect(await present(expiredHash)).toBe(false);
    expect(await present(hasher.hash(minted.plaintext))).toBe(true);
  });

  it("does not sweep another org's expired tickets on consume (org-scoped)", async () => {
    const other = await seedOrg();
    const otherExpired = hasher.hash(`sxt_${other.orgId}_x_${randomUUID()}`);
    await withTenant(
      app,
      other.orgId,
      (tx) =>
        tx`insert into auth_session_exchange
             (id, org_id, user_id, audience, token_hash, prefix, start, expires_at)
           values (${randomUUID()}, ${other.orgId}, ${other.userId}, ${APP}, ${otherExpired}, ${"sxt"},
                   ${"sxt_other"}, now() - interval '1 hour')`,
    );

    const { orgId, userId } = await seedOrg();
    const minted = await mintSessionExchange(
      app,
      { orgId, userId, audience: APP, ttlSeconds: TTL },
      hasher,
    );
    await consumeSessionExchange(app, minted.plaintext, hasher, APP);

    // The OTHER org's expired ticket is untouched — the sweep only sees current_org_id().
    const [row] = await withTenant(
      app,
      other.orgId,
      (tx) =>
        tx<
          { n: number }[]
        >`select 1 as n from auth_session_exchange where token_hash = ${otherExpired}`,
    );
    expect(row).not.toBeUndefined();
  });

  it("returns the redeem result even when the sweep fails (non-fatal housekeeping)", async () => {
    // Inject a real prune failure: revoke webhook_app's DELETE so the post-redeem sweep errors. The redeem
    // (the load-bearing op) MUST still commit + return; the swallowed sweep error never surfaces.
    const { orgId, userId } = await seedOrg();
    const minted = await mintSessionExchange(
      app,
      { orgId, userId, audience: APP, ttlSeconds: TTL },
      hasher,
    );

    await owner`revoke delete on auth_session_exchange from webhook_app`;
    try {
      const consumed = await consumeSessionExchange(app, minted.plaintext, hasher, APP);
      expect(consumed).toEqual({ userId, orgId, audience: APP });
      // The ticket was genuinely burned (single-use) despite the sweep being unable to delete.
      expect(await consumeSessionExchange(app, minted.plaintext, hasher, APP)).toBeNull();
    } finally {
      await owner`grant delete on auth_session_exchange to webhook_app`;
    }
  });

  it("stores only the hash — the plaintext secret is not in the row", async () => {
    const { orgId, userId } = await seedOrg();
    const minted = await mintSessionExchange(
      app,
      { orgId, userId, audience: APP, ttlSeconds: TTL },
      hasher,
    );
    const [row] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ token_hash: Buffer }[]>`
          select token_hash from auth_session_exchange where id = ${minted.exchangeId}`,
    );
    expect(Buffer.compare(row!.token_hash, hasher.hash(minted.plaintext))).toBe(0);
    // The plaintext secret must not be stored. Extract the FULL secret (everything after the
    // `sxt_<orgId>_` prefix) — NOT `split("_")[2]`, since the base64url secret can itself contain `_`,
    // which would leave only a short first chunk (e.g. a single char) and make this assertion flaky
    // against the raw hash bytes.
    const secret = minted.plaintext.slice(`sxt_${orgId}_`.length);
    expect(row!.token_hash.toString("utf8")).not.toContain(secret);
  });
});
