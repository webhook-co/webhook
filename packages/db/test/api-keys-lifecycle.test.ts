import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_KEY_PREFIX,
  createApiKey,
  listApiKeys,
  makeApiKeyColdLookup,
  revokeApiKeyInTx,
} from "../src/api-keys";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { expectNoSecretInSerialized } from "./secret-leak";
import { InMemoryCredentialCache } from "../src/credential-cache";
import { createCredentialResolver } from "../src/credential-resolver";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

/** Revoke a key by id under the org's RLS context (the tx-level primitive). Returns whether it flipped. */
async function revokeApiKey(app: Sql, orgId: string, id: string): Promise<boolean> {
  const { revoked } = await withTenant(app, orgId, (tx) => revokeApiKeyInTx(tx, id));
  return revoked;
}

// api-key lifecycle + verify-path suite. Exercises the ACTUAL shipped functions
// (createApiKey/listApiKeys/revokeApiKey + the webhook_authn cold lookup wired into a
// credential resolver) against a REAL Postgres with REAL non-owner roles, so the
// two-pool design, the column-level grant, RLS, and revocation->cache-invalidation
// are all validated on a real engine. (The DB-layer suite api_keys.test.ts
// validates the raw SQL contract; this validates the TS data-access.)

const API_RESOURCE = "https://api.webhook.co";
// A fixed test pepper (>=32 bytes). In prod the pepper is injected from a wrangler secret.
const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql; // webhook_app pool — create/list/revoke (tenant DML under RLS)
let authn: Sql; // webhook_authn pool — verify cold path (column-scoped SELECT)
let orgA: string;
let orgB: string;

async function seedOrg(orgId: string): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"Org"})`;
  });
}

/** A verify helper wiring the authn cold lookup behind a (fresh) in-memory cache. */
function makeResolver(cache = new InMemoryCredentialCache()) {
  return {
    cache,
    resolver: createCredentialResolver({
      hasher,
      cache,
      // The cold lookup returns the key's intrinsic audience (undefined for a legacy key); `resource`
      // is the surface audience the resolver conditionally stamps (A0b) — mirrors the real wiring.
      coldLookup: makeApiKeyColdLookup(authn),
      resource: API_RESOURCE,
    }),
  };
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  // TWO POOLS: a webhook_app pool and a SEPARATE webhook_authn pool. webhook_authn
  // cannot SET ROLE webhook_app — that's the whole point of least-privilege — so the
  // verify path uses its own connection. In prod the authn pool is wired to the
  // CACHE-DISABLED Hyperdrive binding; here both hit the ephemeral PG directly.
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));

  orgA = randomUUID();
  orgB = randomUUID();
  await seedOrg(orgA);
  await seedOrg(orgB);
}, 90_000);

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

describe("createApiKey -> verify -> list -> revoke", () => {
  it("creates a key, returns the plaintext once, and verify discovers its org", async () => {
    const created = await createApiKey(
      app,
      { orgId: orgA, name: "lifecycle", scopes: ["events:read"] },
      hasher,
    );
    expect(created.plaintext.startsWith(`${API_KEY_PREFIX}_`)).toBe(true);
    expect(created.orgId).toBe(orgA);

    const { resolver } = makeResolver();
    const principal = await resolver.resolve(created.plaintext);
    expect(principal?.orgId).toBe(orgA); // org DISCOVERED from the key
    expect(principal?.scopes).toEqual(["events:read"]);
    expect(principal?.audience).toBe(API_RESOURCE);
  });

  it("lists the org's keys with display metadata only (no hash, no plaintext)", async () => {
    const created = await createApiKey(
      app,
      { orgId: orgA, name: "listed", scopes: ["events:read"] },
      hasher,
    );
    const items = await listApiKeys(app, orgA);
    expect(items.length).toBeGreaterThan(0);
    const found = items.find((k) => k.id === created.id);
    expect(found?.name).toBe("listed");
    expect(found?.start.startsWith(API_KEY_PREFIX)).toBe(true);
    // The list item type carries no hash/plaintext field at all — assert the FULL plaintext
    // and the stored hash hex are absent from the serialized listing (not just a slice).
    expectNoSecretInSerialized(items, [
      created.plaintext,
      hasher.hash(created.plaintext).toString("hex"),
    ]);
  });

  it("revoke stamps revoked_at and the key stops verifying", async () => {
    const created = await createApiKey(app, { orgId: orgA, name: "revokeme", scopes: [] }, hasher);
    const { cache, resolver } = makeResolver();

    expect(await resolver.resolve(created.plaintext)).not.toBeNull(); // warms the cache

    const revoked = await revokeApiKey(app, orgA, created.id);
    expect(revoked).toBe(true);
    // Real revocation invalidates the cache too (the surface holds the plaintext/hash).
    await resolver.invalidate(created.plaintext);

    expect(await resolver.resolve(created.plaintext)).toBeNull();
    // A second revoke of an already-revoked key is a no-op.
    expect(await revokeApiKey(app, orgA, created.id)).toBe(false);
    expect(cache.gets).toBeGreaterThan(0);
  });
});

describe("expiry honored on verify", () => {
  it("an expired key does not resolve", async () => {
    const created = await createApiKey(
      app,
      { orgId: orgA, name: "expired", scopes: [], expiresAt: new Date(Date.now() - 60_000) },
      hasher,
    );
    const { resolver } = makeResolver();
    expect(await resolver.resolve(created.plaintext)).toBeNull();
  });

  it("a future-dated expiry still resolves", async () => {
    const created = await createApiKey(
      app,
      { orgId: orgA, name: "future", scopes: [], expiresAt: new Date(Date.now() + 3_600_000) },
      hasher,
    );
    const { resolver } = makeResolver();
    expect(await resolver.resolve(created.plaintext)).not.toBeNull();
  });
});

describe("two-pool design: webhook_authn cold lookup is least-privilege", () => {
  it("the authn pool resolves org via the granted columns (incl. audience)", async () => {
    const created = await createApiKey(
      app,
      { orgId: orgA, name: "authn", scopes: ["events:read"] },
      hasher,
    );
    const cold = makeApiKeyColdLookup(authn);
    const principal = await cold(hasher.hash(created.plaintext));
    expect(principal?.orgId).toBe(orgA);
  });

  it("the authn pool CANNOT read an ungranted column (name) — defense the verify path relies on", async () => {
    await expect(authn`select name from api_keys limit 1`).rejects.toThrow(/permission denied/i);
  });

  it("the authn pool CANNOT write api_keys (verify-only role)", async () => {
    await expect(
      authn`update api_keys set revoked_at = now() where org_id = ${orgA}`,
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("cross-org isolation (RLS) on the app pool", () => {
  it("org A's app context cannot revoke org B's key", async () => {
    const bKey = await createApiKey(app, { orgId: orgB, name: "borg", scopes: [] }, hasher);
    // Under org A's context the row is invisible -> nothing revoked.
    expect(await revokeApiKey(app, orgA, bKey.id)).toBe(false);
    // And it still verifies as org B's (org-discovery never crosses the boundary).
    const { resolver } = makeResolver();
    const principal = await resolver.resolve(bKey.plaintext);
    expect(principal?.orgId).toBe(orgB);
  });
});

describe("KV hot path vs cold path vs revocation", () => {
  it("hot-path hit avoids a second authn round-trip; revocation forces a cold miss", async () => {
    const created = await createApiKey(
      app,
      { orgId: orgA, name: "kv", scopes: ["events:read"] },
      hasher,
    );
    const cache = new InMemoryCredentialCache();
    // Count cold lookups by wrapping the real authn lookup.
    let coldCalls = 0;
    const baseCold = makeApiKeyColdLookup(authn);
    const resolver = createCredentialResolver({
      hasher,
      cache,
      coldLookup: async (h) => {
        coldCalls += 1;
        return baseCold(h);
      },
    });

    await resolver.resolve(created.plaintext); // cold (miss)
    await resolver.resolve(created.plaintext); // hot (hit)
    expect(coldCalls).toBe(1);

    await revokeApiKey(app, orgA, created.id);
    await resolver.invalidate(created.plaintext); // revocation invalidates KV
    expect(await resolver.resolve(created.plaintext)).toBeNull(); // cold again -> revoked
    expect(coldCalls).toBe(2);
  });
});

describe("per-key audience (A0b conditional stamp, real DB)", () => {
  it("a key with a stored audience resolves to THAT audience — not widened to the presenting surface", async () => {
    const created = await createApiKey(app, { orgId: orgA, name: "perkey", scopes: [] }, hasher);
    // Bind a per-key audience to mcp (A0c's mintScopedKey will set this at mint; here via SQL).
    await withTenant(app, orgA, async (tx) => {
      await tx`update api_keys set audience = ${"https://mcp.webhook.co"} where id = ${created.id}`;
    });
    // Resolve through an API-surface resolver (resource = api). The intrinsic mcp audience must win.
    const { resolver } = makeResolver();
    const principal = await resolver.resolve(created.plaintext);
    expect(principal?.audience).toBe("https://mcp.webhook.co"); // confined to mcp, not widened to api
  });

  it("a legacy key (no stored audience) is stamped with the presenting surface's audience", async () => {
    const created = await createApiKey(
      app,
      { orgId: orgA, name: "legacy-aud", scopes: [] },
      hasher,
    );
    const { resolver } = makeResolver(); // resource = API_RESOURCE
    expect((await resolver.resolve(created.plaintext))?.audience).toBe(API_RESOURCE);
  });

  it("an empty-string stored audience is treated as no binding (stamped per surface, not bricked)", async () => {
    // Defense-in-depth: a "" audience must coalesce to undefined in the cold lookup (`|| undefined`),
    // NOT survive as "" — else the resolver's `audience !== undefined` guard would skip the stamp and
    // assertAudience's strict `!==` would reject the key on EVERY surface (a silent fail-closed brick).
    const created = await createApiKey(app, { orgId: orgA, name: "empty-aud", scopes: [] }, hasher);
    await withTenant(app, orgA, async (tx) => {
      await tx`update api_keys set audience = ${""} where id = ${created.id}`;
    });
    const { resolver } = makeResolver(); // resource = API_RESOURCE
    expect((await resolver.resolve(created.plaintext))?.audience).toBe(API_RESOURCE);
  });
});
