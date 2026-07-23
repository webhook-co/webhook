import { randomUUID } from "node:crypto";

import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createApiKey,
  createApiKeyWithAudit,
  findApiKeyGrant,
  listApiKeys,
  listApiKeysForGrant,
  listApiKeysForGrants,
  listStandaloneApiKeys,
  makeApiKeyColdLookup,
} from "../src/api-keys";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { InMemoryCredentialCache } from "../src/credential-cache";
import { createCredentialResolver } from "../src/credential-resolver";
import {
  approveGrant,
  createPendingGrant,
  listGrants,
  mintKeyForGrant,
  mintScopedKey,
  revokeApiKey,
  revokeGrant,
} from "../src/grants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Grant + scoped-key ISSUANCE against a REAL Postgres: mintScopedKey (approval off / on-pending /
// on-auto-approved), approveGrant, mintKeyForGrant (refresh), the atomic grant+key+aae1-audit tx,
// per-key audience confinement, and RLS. The HMAC key is from a binding, never the DB role.

const API = "https://api.webhook.co";
const MCP = "https://mcp.webhook.co";
const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x9a) });

let pg: EphemeralPostgres;
let app: Sql;
let authn: Sql;
let owner: Sql; // webhook_owner — the better-auth "user" table is global + ungranted to webhook_app
let auditKey: CryptoKey;

async function seedOrg(orgId: string): Promise<void> {
  const userId = userOf(orgId);
  // Identity rows are global + ungranted to webhook_app, so seed the user as the schema owner.
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${userId}, ${"Seed"}, ${`${orgId.slice(0, 8)}@e.test`}, ${true}, now())`;
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${"o-" + orgId.slice(0, 8)}, ${"Org"})`;
    // A grant always belongs to a MEMBER — that is what consent established. Seeding the membership makes
    // the fixture model reality: without it the fixture silently describes a user who was already removed,
    // and every mint would be (correctly) refused by the ceiling for the wrong reason.
    await tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  });
}

function userOf(orgId: string): string {
  return `u_${orgId.slice(0, 8)}`;
}

/** Resolve a minted plaintext through the real authn cold lookup (api surface unless overridden). */
function makeResolver(resource = API) {
  return createCredentialResolver({
    hasher,
    cache: new InMemoryCredentialCache(),
    coldLookup: makeApiKeyColdLookup(authn),
    resource,
  });
}

/** The audit event_type sequence for an org (ascending seq). */
async function auditTypes(orgId: string): Promise<string[]> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ event_type: string }[]>`
      select event_type from auth_audit_event where org_id = ${orgId} order by seq asc`,
  );
  return rows.map((r) => r.event_type);
}

async function grantStatus(orgId: string, grantId: string): Promise<string | undefined> {
  const [row] = await withTenant(
    app,
    orgId,
    (tx) => tx<{ status: string }[]>`select status from auth_grant where id = ${grantId}`,
  );
  return row?.status;
}

async function setPolicy(orgId: string, requireApproval: boolean, rules?: unknown): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into org_policy (org_id, require_device_approval, auto_approve_rules)
      values (${orgId}, ${requireApproval}, ${rules == null ? null : tx.json(rules as Parameters<typeof tx.json>[0])}::jsonb)`;
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 13) % 256)),
  );
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await owner?.end();
  await pg?.stop();
});

describe("mintScopedKey — approval OFF (founder default)", () => {
  it("mints an active grant + a key that resolves to the org with its audience", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const res = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    expect(res.status).toBe("minted");
    if (res.status !== "minted") throw new Error("unreachable");
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const principal = await makeResolver().resolve(res.plaintext);
    expect(principal?.orgId).toBe(orgId);
    expect(principal?.scopes).toEqual(["events:read"]);
    expect(principal?.audience).toBe(API);

    expect(await grantStatus(orgId, res.grantId)).toBe("active");
    expect(await auditTypes(orgId)).toEqual(["grant_created", "key_minted"]);
  });

  it("confines a per-key audience: an mcp-bound key resolved at api keeps audience=mcp", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const res = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: [],
        audience: MCP,
        ttlSeconds: 3600,
        authMethod: "device_code",
      },
      hasher,
      auditKey,
    );
    if (res.status !== "minted") throw new Error("unreachable");
    // Resolve through an API-surface resolver — the intrinsic mcp audience must NOT widen to api.
    expect((await makeResolver(API).resolve(res.plaintext))?.audience).toBe(MCP);
  });
});

describe("createApiKeyWithAudit", () => {
  it("mints a standalone key AND writes its key_minted audit row in one tx", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const created = await createApiKeyWithAudit(
      app,
      { orgId, name: "dashboard key", scopes: ["events:read"] },
      hasher,
      auditKey,
      userOf(orgId),
    );

    expect(created.plaintext).toMatch(/^whk_/);
    // it's standalone (no grant) → shows in the standalone list
    expect((await listStandaloneApiKeys(app, orgId)).map((k) => k.id)).toEqual([created.id]);
    // and the mint is audited
    expect(await auditTypes(orgId)).toEqual(["key_minted"]);
  });
});

describe("listStandaloneApiKeys", () => {
  it("returns only keys with no grant — excludes grant-backed keys (which show under their device)", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const minted = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (minted.status !== "minted") throw new Error("unreachable");
    const standalone = await createApiKey(
      app,
      { orgId, name: "standalone", scopes: ["events:read"] },
      hasher,
      userOf(orgId),
    );

    const items = await listStandaloneApiKeys(app, orgId);
    expect(items.map((k) => k.id)).toEqual([standalone.id]); // grant-backed key excluded

    // listApiKeys still returns BOTH (so the standalone filter is the meaningful difference)
    expect((await listApiKeys(app, orgId)).length).toBe(2);
  });
});

describe("mintScopedKey — approval ON", () => {
  it("with no matching rule, creates a pending grant and NO key", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    await setPolicy(orgId, true, null);
    const res = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "device_code",
        device: { ip: "203.0.113.5", geo: { country: "FR" } },
      },
      hasher,
      auditKey,
    );
    expect(res.status).toBe("pending_approval");
    if (res.status !== "pending_approval") throw new Error("unreachable");
    expect(await grantStatus(orgId, res.grantId)).toBe("pending_approval");
    const rows = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from api_keys where grant_id = ${res.grantId}`,
    );
    expect(rows[0]!.n).toBe(0); // no key minted
    expect(await auditTypes(orgId)).toEqual(["grant_created"]);
  });

  it("auto-approves when a rule matches, minting an approved grant + key", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    await setPolicy(orgId, true, [{ geoCountries: ["US"] }]);
    const res = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "device_code",
        device: { ip: "203.0.113.6", geo: { country: "US" } },
      },
      hasher,
      auditKey,
    );
    expect(res.status).toBe("minted");
    if (res.status !== "minted") throw new Error("unreachable");
    expect((await makeResolver().resolve(res.plaintext))?.orgId).toBe(orgId);
    expect(await grantStatus(orgId, res.grantId)).toBe("active");
    expect(await auditTypes(orgId)).toEqual(["grant_created", "grant_approved", "key_minted"]);
  });
});

describe("approveGrant", () => {
  it("approves a pending grant, mints its first key, and is not repeatable", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const { grantId } = await createPendingGrant(
      app,
      { orgId, userId: userOf(orgId), authMethod: "device_code" },
      auditKey,
    );
    expect(await grantStatus(orgId, grantId)).toBe("pending_approval");

    const minted = await approveGrant(
      app,
      {
        orgId,
        grantId,
        approvedBy: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
      },
      hasher,
      auditKey,
    );
    expect((await makeResolver().resolve(minted.plaintext))?.orgId).toBe(orgId);
    expect(await grantStatus(orgId, grantId)).toBe("active");
    expect(await auditTypes(orgId)).toEqual(["grant_created", "grant_approved", "key_minted"]);

    // A second approval of the now-active grant is rejected.
    await expect(
      approveGrant(
        app,
        { orgId, grantId, scopes: [], audience: API, ttlSeconds: 3600 },
        hasher,
        auditKey,
      ),
    ).rejects.toThrow(/not found or not pending/i);
  });
});

describe("mintKeyForGrant — refresh", () => {
  it("re-mints a fresh key on the existing active grant; both keys coexist (expire-naturally)", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const first = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (first.status !== "minted") throw new Error("unreachable");

    const second = await mintKeyForGrant(
      app,
      { orgId, grantId: first.grantId, scopes: ["events:read"], audience: API, ttlSeconds: 3600 },
      hasher,
      auditKey,
    );
    expect(second.keyId).not.toBe(first.keyId);
    // Both keys resolve — the prior key is NOT revoked on refresh (expire-naturally).
    expect((await makeResolver().resolve(first.plaintext))?.orgId).toBe(orgId);
    expect((await makeResolver().resolve(second.plaintext))?.orgId).toBe(orgId);

    // Same grant reused — both keys hang off first.grantId; no new grant created.
    const rows = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from api_keys where grant_id = ${first.grantId}`,
    );
    expect(rows[0]!.n).toBe(2);
    const grantRows = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ g: number }[]>`select count(*)::int as g from auth_grant where org_id = ${orgId}`,
    );
    expect(grantRows[0]!.g).toBe(1);
  });

  it("refuses to mint on a non-active (pending) grant", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const { grantId } = await createPendingGrant(
      app,
      { orgId, userId: userOf(orgId), authMethod: "device_code" },
      auditKey,
    );
    await expect(
      mintKeyForGrant(
        app,
        { orgId, grantId, scopes: [], audience: API, ttlSeconds: 3600 },
        hasher,
        auditKey,
      ),
    ).rejects.toThrow(/not active/i);
  });

  it("refuses to mint on an active grant whose expiry has passed (mints no key)", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    // An active grant — then force its expiry into the past (the refresh path's consumeRefreshToken
    // already gates this; a non-refresh mintKeyForGrant caller must be gated identically).
    const minted = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
        grantTtlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (minted.status !== "minted") throw new Error("unreachable");
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`update auth_grant set expires_at = now() - interval '1 second' where id = ${minted.grantId}`,
    );

    await expect(
      mintKeyForGrant(
        app,
        {
          orgId,
          grantId: minted.grantId,
          scopes: ["events:read"],
          audience: API,
          ttlSeconds: 3600,
        },
        hasher,
        auditKey,
      ),
    ).rejects.toThrow(/not active/i);

    // No second key was minted — the grant still has exactly the one key from the initial mint.
    const rows = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from api_keys where grant_id = ${minted.grantId}`,
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe("cross-org isolation (RLS)", () => {
  it("cannot mint on another org's grant (the grant is invisible)", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    await seedOrg(orgA);
    await seedOrg(orgB);
    const a = await mintScopedKey(
      app,
      {
        orgId: orgA,
        userId: userOf(orgA),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (a.status !== "minted") throw new Error("unreachable");
    // Org B's context cannot see org A's grant → mint refused.
    await expect(
      mintKeyForGrant(
        app,
        { orgId: orgB, grantId: a.grantId, scopes: [], audience: API, ttlSeconds: 3600 },
        hasher,
        auditKey,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("a composite FK forbids binding a key to another org's grant (defense in depth)", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    await seedOrg(orgA);
    await seedOrg(orgB);
    const b = await mintScopedKey(
      app,
      {
        orgId: orgB,
        userId: userOf(orgB),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (b.status !== "minted") throw new Error("unreachable");
    // Under org A's RLS context, try to bind a NEW key to org B's grant (org_id=A, grant_id=B's grant).
    // The composite FK (grant_id, org_id) -> auth_grant(id, org_id) makes this impossible.
    await expect(
      withTenant(
        app,
        orgA,
        (tx) =>
          tx`insert into api_keys (id, org_id, key_hash, prefix, start, name, scopes, grant_id)
           values (${randomUUID()}, ${orgA}, ${Buffer.alloc(32, 1)}, ${"whk"}, ${"whk_x"}, ${"x"},
                   ${tx.json([])}, ${b.grantId})`,
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe("issuance hardening", () => {
  it("rejects a non-positive ttlSeconds (never mints a pre-expired key)", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    await expect(
      mintScopedKey(
        app,
        {
          orgId,
          userId: userOf(orgId),
          scopes: [],
          audience: API,
          ttlSeconds: 0,
          authMethod: "pkce_loopback",
        },
        hasher,
        auditKey,
      ),
    ).rejects.toThrow(/positive/i);
  });

  it("auto-approval is recorded as a SYSTEM decision (approved_by null, audit auto:true)", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    await setPolicy(orgId, true, [{ geoCountries: ["US"] }]);
    const res = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "device_code",
        device: { geo: { country: "US" } },
      },
      hasher,
      auditKey,
    );
    if (res.status !== "minted") throw new Error("unreachable");
    const [grant] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ approved_by: string | null; approved_at: Date | null }[]>`
        select approved_by, approved_at from auth_grant where id = ${res.grantId}`,
    );
    expect(grant?.approved_by).toBeNull(); // system, not the user
    expect(grant?.approved_at).not.toBeNull();
    const [audit] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ actor: string | null; metadata: { auto?: boolean } }[]>`
        select actor, metadata from auth_audit_event
        where org_id = ${orgId} and event_type = 'grant_approved'`,
    );
    expect(audit?.actor).toBeNull(); // actor matches approved_by (system)
    expect(audit?.metadata?.auto).toBe(true);
  });

  it("a human approveGrant records auto:false with the approver as actor", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const { grantId } = await createPendingGrant(
      app,
      { orgId, userId: userOf(orgId), authMethod: "device_code" },
      auditKey,
    );
    await approveGrant(
      app,
      { orgId, grantId, approvedBy: userOf(orgId), scopes: [], audience: API, ttlSeconds: 3600 },
      hasher,
      auditKey,
    );
    const [audit] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ actor: string | null; metadata: { auto?: boolean } }[]>`
        select actor, metadata from auth_audit_event
        where org_id = ${orgId} and event_type = 'grant_approved'`,
    );
    expect(audit?.actor).toBe(userOf(orgId));
    expect(audit?.metadata?.auto).toBe(false);
  });

  it("persists ssoIdentityId and the grant's expires_at from grantTtlSeconds", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const res = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        grantTtlSeconds: 7200,
        authMethod: "pkce_loopback",
        ssoIdentityId: "sso_abc",
      },
      hasher,
      auditKey,
    );
    if (res.status !== "minted") throw new Error("unreachable");
    const [grant] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ sso_identity_id: string | null; expires_at: Date | null }[]>`
        select sso_identity_id, expires_at from auth_grant where id = ${res.grantId}`,
    );
    expect(grant?.sso_identity_id).toBe("sso_abc");
    expect(grant?.expires_at).not.toBeNull();
    expect(grant!.expires_at!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("revokeApiKey — single key", () => {
  it("revokes a key, returns its hash, stops resolution, audits, and is idempotent", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const res = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (res.status !== "minted") throw new Error("unreachable");
    expect((await makeResolver().resolve(res.plaintext))?.orgId).toBe(orgId); // resolves before

    const revoked = await revokeApiKey(
      app,
      { orgId, keyId: res.keyId, revokedBy: userOf(orgId) },
      auditKey,
    );
    expect(revoked.revoked).toBe(true);
    expect(revoked.keyHash).not.toBeNull();
    expect(Buffer.compare(revoked.keyHash!, hasher.hash(res.plaintext))).toBe(0); // caller can evict KV

    expect(await makeResolver().resolve(res.plaintext)).toBeNull(); // cold lookup honors revoked_at
    expect(await auditTypes(orgId)).toEqual(["grant_created", "key_minted", "key_revoked"]);

    // Idempotent: a second revoke flips nothing and writes no extra audit.
    const again = await revokeApiKey(app, { orgId, keyId: res.keyId }, auditKey);
    expect(again).toEqual({ revoked: false, keyHash: null });
    expect(await auditTypes(orgId)).toEqual(["grant_created", "key_minted", "key_revoked"]);
  });
});

describe("revokeGrant — cascade", () => {
  it("revokes the grant + all child keys, returns their hashes, and is idempotent", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const first = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (first.status !== "minted") throw new Error("unreachable");
    const second = await mintKeyForGrant(
      app,
      { orgId, grantId: first.grantId, scopes: [], audience: API, ttlSeconds: 3600 },
      hasher,
      auditKey,
    );

    const result = await revokeGrant(
      app,
      { orgId, grantId: first.grantId, revokedBy: userOf(orgId), reason: "compromised" },
      auditKey,
    );
    expect(result.revoked).toBe(true);
    expect(result.revokedKeyHashes).toHaveLength(2); // cascaded to both keys
    expect(await grantStatus(orgId, first.grantId)).toBe("revoked");
    // Both keys stop resolving.
    expect(await makeResolver().resolve(first.plaintext)).toBeNull();
    expect(await makeResolver().resolve(second.plaintext)).toBeNull();
    expect(await auditTypes(orgId)).toContain("grant_revoked");

    // Idempotent: re-revoking flips nothing and cascades to no keys.
    const again = await revokeGrant(app, { orgId, grantId: first.grantId }, auditKey);
    expect(again).toEqual({ revoked: false, revokedKeyHashes: [] });
  });

  it("returns { revoked: false } for a cross-org / unknown grant (RLS-invisible)", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    await seedOrg(orgA);
    await seedOrg(orgB);
    const a = await mintScopedKey(
      app,
      {
        orgId: orgA,
        userId: userOf(orgA),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (a.status !== "minted") throw new Error("unreachable");
    const result = await revokeGrant(app, { orgId: orgB, grantId: a.grantId }, auditKey);
    expect(result).toEqual({ revoked: false, revokedKeyHashes: [] });
    // Org A's key still resolves — org B's revoke could not touch it.
    expect((await makeResolver().resolve(a.plaintext))?.orgId).toBe(orgA);
  });
});

describe("read helpers", () => {
  it("listGrants returns the org's grants (newest first), RLS-scoped, no secrets", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    await seedOrg(orgA);
    await seedOrg(orgB);
    await mintScopedKey(
      app,
      {
        orgId: orgA,
        userId: userOf(orgA),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    await mintScopedKey(
      app,
      {
        orgId: orgB,
        userId: userOf(orgB),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "device_code",
      },
      hasher,
      auditKey,
    );
    const aGrants = await listGrants(app, orgA);
    expect(aGrants).toHaveLength(1); // only org A's grant (RLS)
    expect(aGrants[0]!.status).toBe("active");
    expect(aGrants[0]!.authMethod).toBe("pkce_loopback");
    expect(JSON.stringify(aGrants)).not.toContain("key_hash");
  });

  it("listApiKeysForGrant returns only that grant's keys (display metadata only)", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const g = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (g.status !== "minted") throw new Error("unreachable");
    await mintKeyForGrant(
      app,
      { orgId, grantId: g.grantId, scopes: ["events:read"], audience: API, ttlSeconds: 3600 },
      hasher,
      auditKey,
    );
    // A SECOND grant in the SAME org with its own key — its key must NOT appear in g's listing.
    const other = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: [],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "device_code",
      },
      hasher,
      auditKey,
    );
    if (other.status !== "minted") throw new Error("unreachable");

    const keys = await listApiKeysForGrant(app, orgId, g.grantId);
    expect(keys).toHaveLength(2); // exactly g's two keys — the grant_id filter excludes `other`'s key
    expect(keys.map((k) => k.id)).not.toContain(other.keyId); // proves the exclusion
    expect(keys.map((k) => k.scopes)).toEqual([["events:read"], ["events:read"]]);
    // The list item carries no hash/plaintext field.
    expect(JSON.stringify(keys)).not.toContain("key_hash");
    expect(JSON.stringify(keys)).not.toContain(g.plaintext);
  });
});

describe("findApiKeyGrant (the /revoke whk_ -> grant resolver)", () => {
  async function mintFor(orgId: string) {
    await seedOrg(orgId);
    const res = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    if (res.status !== "minted") throw new Error("unreachable");
    return res;
  }

  it("resolves a minted whk_ to its grant cross-org, even after the grant is revoked (idempotent)", async () => {
    const orgId = randomUUID();
    const res = await mintFor(orgId);
    expect(await findApiKeyGrant(authn, res.plaintext, hasher)).toEqual({
      orgId,
      grantId: res.grantId,
    });
    // No status filter: /revoke must still resolve a revoked key's grant so the cascade is idempotent.
    await revokeGrant(app, { orgId, grantId: res.grantId, reason: "test" }, auditKey);
    expect(await findApiKeyGrant(authn, res.plaintext, hasher)).toEqual({
      orgId,
      grantId: res.grantId,
    });
  });

  it("returns null for an unknown key and for a standalone (grantless) key", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    expect(await findApiKeyGrant(authn, `whk_${"z".repeat(43)}`, hasher)).toBeNull();
    const standalone = await createApiKey(
      app,
      { orgId, name: "standalone", scopes: ["events:read"] },
      hasher,
      userOf(orgId),
    );
    expect(await findApiKeyGrant(authn, standalone.plaintext, hasher)).toBeNull();
  });

  it("resolves a key minted under a PREVIOUS pepper (candidates loop)", async () => {
    const orgId = randomUUID();
    const res = await mintFor(orgId);
    const rotated = createCredentialHasher({
      current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xcc),
      previous: [Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x9a)],
    });
    expect(await findApiKeyGrant(authn, res.plaintext, rotated)).toEqual({
      orgId,
      grantId: res.grantId,
    });
  });
});

// A grant mint is a RENEWAL, so the ceiling NARROWS it — it does not refuse it.
//
// The distinction is the whole point. An explicit request for a scope you may not hold is refused BY NAME
// (insertApiKey throws; the dashboard says which scope). But a refresh is the client saying "give me my
// token again", against scopes consented to months ago. If the human has since been DEMOTED, the right
// outcome is that their token SHRINKS to what they may still exercise — not that their CLI and MCP start
// failing with an error they can neither understand nor fix. A token is a filter over its owner's
// authority: when the authority shrinks, so does the token.
describe("mint ceiling on a grant — demotion shrinks the token, it doesn't break it", () => {
  /** Change the seeded user's role in the org. */
  async function setRole(orgId: string, role: "owner" | "admin" | "member"): Promise<void> {
    await withTenant(app, orgId, async (tx) => {
      await tx`update memberships set role = ${role} where org_id = ${orgId} and user_id = ${userOf(orgId)}`;
    });
  }

  it("re-mints only the scopes the DEMOTED user may still exercise (audit:read is dropped)", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId); // seeded as owner
    const minted = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read", "audit:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    expect(minted.status).toBe("minted");
    const grantId = minted.status === "minted" ? minted.grantId : "";

    // The admin who consented to audit:read is demoted to a plain member.
    await setRole(orgId, "member");

    // Their next refresh still WORKS — it simply no longer carries audit:read.
    const renewed = await mintKeyForGrant(
      app,
      { orgId, grantId, scopes: ["events:read", "audit:read"], audience: API, ttlSeconds: 3600 },
      hasher,
      auditKey,
    );
    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ scopes: string[] }[]>`select scopes from api_keys where id = ${renewed.keyId}`,
    );
    expect(row?.scopes).toEqual(["events:read"]);
  });

  it("REFUSES the renewal when the user may exercise NOTHING the grant was for", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const minted = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["audit:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    const grantId = minted.status === "minted" ? minted.grantId : "";
    await setRole(orgId, "member");

    // Nothing left to mint — a powerless key would just fail confusingly at every call, so refuse instead.
    await expect(
      mintKeyForGrant(
        app,
        { orgId, grantId, scopes: ["audit:read"], audience: API, ttlSeconds: 3600 },
        hasher,
        auditKey,
      ),
    ).rejects.toThrow(/audit:read/);
  });

  it("attributes a grant-minted key to the grant's OWN user (created_by)", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    const minted = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    const keyId = minted.status === "minted" ? minted.keyId : "";
    const [row] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ created_by: string | null }[]>`select created_by from api_keys where id = ${keyId}`,
    );
    expect(row?.created_by).toBe(userOf(orgId));
  });
});

// The identity scope, through the REAL mint — the case that would have taken login down.
//
// `profile` is GRANTED on every OAuth/CLI/MCP login (it is advertised in scopes_supported and gates the
// whoami name+email read) but it is deliberately NOT a member of CAPABILITY_SCOPES, because it binds no
// tool. A mint ceiling built from CAPABILITY_SCOPES alone denies it to EVERY role — owner included — so
// every token exchange throws and login is dead. The auth-side tests could not catch this: they mock the
// mint. Only a mint against a real database can.
describe("the identity scope is mintable by every role (login must not break)", () => {
  it("mints an owner's key carrying `profile` alongside a capability scope", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId); // owner
    const minted = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read", "profile"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    expect(minted.status).toBe("minted");
    const keyId = minted.status === "minted" ? minted.keyId : "";
    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ scopes: string[] }[]>`select scopes from api_keys where id = ${keyId}`,
    );
    expect(row?.scopes).toEqual(["events:read", "profile"]);
  });

  it("a plain MEMBER keeps `profile` too — identity is not a privilege", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    await withTenant(app, orgId, async (tx) => {
      await tx`update memberships set role = 'member' where org_id = ${orgId} and user_id = ${userOf(orgId)}`;
    });
    const minted = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        scopes: ["events:read", "profile"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    const keyId = minted.status === "minted" ? minted.keyId : "";
    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ scopes: string[] }[]>`select scopes from api_keys where id = ${keyId}`,
    );
    expect(row?.scopes).toContain("profile");
  });
});

// INITIAL login, not just renewal. The narrowing lives in mintKeyOnGrantInTx, which serves both the first
// mint (mintScopedKey) and every refresh — but a test that only demotes an owner proves the refresh path and
// leaves the first-login path unproven. `wbhk login` requests the FULL advertised scope set, so a plain
// member's very first CLI login is exactly the case where the ceiling has to bite.
describe("mint ceiling on a member's FIRST login (not only on renewal)", () => {
  async function seedMemberOrg(orgId: string): Promise<void> {
    await seedOrg(orgId);
    await withTenant(app, orgId, async (tx) => {
      await tx`update memberships set role = 'member' where org_id = ${orgId} and user_id = ${userOf(orgId)}`;
    });
  }

  it("narrows a member's first login to what they may exercise (the CLI asks for everything)", async () => {
    const orgId = randomUUID();
    await seedMemberOrg(orgId);
    const minted = await mintScopedKey(
      app,
      {
        orgId,
        userId: userOf(orgId),
        // Exactly what `wbhk login` sends: the whole advertised set.
        scopes: ["events:read", "endpoints:write", "audit:read", "billing:read", "profile"],
        audience: API,
        ttlSeconds: 3600,
        authMethod: "pkce_loopback",
      },
      hasher,
      auditKey,
    );
    expect(minted.status).toBe("minted");
    const keyId = minted.status === "minted" ? minted.keyId : "";
    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ scopes: string[] }[]>`select scopes from api_keys where id = ${keyId}`,
    );
    // Logged in fine — and simply cannot exercise the two manager-only scopes.
    expect(row?.scopes).toEqual(["events:read", "endpoints:write", "profile"]);
    expect(row?.scopes).not.toContain("audit:read");
    expect(row?.scopes).not.toContain("billing:read");
  });

  it("REFUSES a member's first login that asks ONLY for manager-only scopes", async () => {
    const orgId = randomUUID();
    await seedMemberOrg(orgId);
    await expect(
      mintScopedKey(
        app,
        {
          orgId,
          userId: userOf(orgId),
          scopes: ["audit:read", "billing:read"],
          audience: API,
          ttlSeconds: 3600,
          authMethod: "pkce_loopback",
        },
        hasher,
        auditKey,
      ),
    ).rejects.toThrow(/audit:read|billing:read/);
  });

  it("a missing grant says so — it does not surface as a ceiling violation", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    await expect(
      mintKeyForGrant(
        app,
        { orgId, grantId: randomUUID(), scopes: ["events:read"], audience: API, ttlSeconds: 3600 },
        hasher,
        auditKey,
      ),
    ).rejects.toThrow(/grant not found/);
  });

  // The batched read that replaced the credentials page's N+1. It must be OBSERVATIONALLY IDENTICAL to
  // calling listApiKeysForGrant once per grant — same keys, same order, same RLS boundary — or it is not a
  // refactor, it is a new bug with better latency.
  describe("listApiKeysForGrants (batched)", () => {
    it("groups each grant's keys under its own id, and agrees with the per-grant query", async () => {
      const orgId = randomUUID();
      await seedOrg(orgId);

      const a = await mintScopedKey(
        app,
        {
          orgId,
          userId: userOf(orgId),
          scopes: ["events:read"],
          audience: API,
          ttlSeconds: 3600,
          authMethod: "pkce_loopback",
        },
        hasher,
        auditKey,
      );
      if (a.status !== "minted") throw new Error("unreachable");
      await mintKeyForGrant(
        app,
        { orgId, grantId: a.grantId, scopes: ["events:read"], audience: API, ttlSeconds: 3600 },
        hasher,
        auditKey,
      );

      const b = await mintScopedKey(
        app,
        {
          orgId,
          userId: userOf(orgId),
          scopes: [],
          audience: API,
          ttlSeconds: 3600,
          authMethod: "device_code",
        },
        hasher,
        auditKey,
      );
      if (b.status !== "minted") throw new Error("unreachable");

      const batched = await listApiKeysForGrants(app, orgId, [a.grantId, b.grantId]);

      // Same answer as N separate queries — asserted against the real per-grant function, not a hand-copy.
      for (const grantId of [a.grantId, b.grantId]) {
        const perGrant = await listApiKeysForGrant(app, orgId, grantId);
        expect(batched.get(grantId)).toEqual(perGrant);
      }
      expect(batched.get(a.grantId)).toHaveLength(2);
      expect(batched.get(b.grantId)).toHaveLength(1);
      // No key leaks across the grant boundary.
      expect(batched.get(b.grantId)!.map((k) => k.id)).not.toContain(a.keyId);
      expect(JSON.stringify([...batched.values()])).not.toContain("key_hash");
    });

    // A grant with no keys must be PRESENT and EMPTY, never absent — otherwise the caller cannot tell "this
    // device has no keys" from "I never asked about this device", and the page would silently omit a device.
    it("returns an empty list for a grant that has no keys", async () => {
      const orgId = randomUUID();
      await seedOrg(orgId);
      const g = await mintScopedKey(
        app,
        {
          orgId,
          userId: userOf(orgId),
          scopes: [],
          audience: API,
          ttlSeconds: 3600,
          authMethod: "device_code",
        },
        hasher,
        auditKey,
      );
      if (g.status !== "minted") throw new Error("unreachable");
      // Revoking leaves the grant with its minted key; use a fresh unrelated id to model "no keys".
      const orphan = randomUUID();

      const batched = await listApiKeysForGrants(app, orgId, [orphan]);

      expect(batched.has(orphan)).toBe(true);
      expect(batched.get(orphan)).toEqual([]);
    });

    // The bucket is keyed off what the DATABASE returns, not off what the caller passed. An earlier version
    // did `byGrant.get(id)?.push(...)` and justified the silent drop with a comment claiming an `= any(...)`
    // filter made a miss impossible — which was FALSE, because the query matches with `in`, i.e. plain string
    // equality on the uuid text. A caller whose id differed by so much as a character of case would have had
    // that device's keys land in no bucket at all, and the page would have shown a device with "no keys" while
    // its keys were live. A key you cannot see is a key you cannot revoke.
    it("groups by the database's own grant id, so no device's keys can silently vanish", async () => {
      const orgId = randomUUID();
      await seedOrg(orgId);
      const g = await mintScopedKey(
        app,
        {
          orgId,
          userId: userOf(orgId),
          scopes: ["events:read"],
          audience: API,
          ttlSeconds: 3600,
          authMethod: "pkce_loopback",
        },
        hasher,
        auditKey,
      );
      if (g.status !== "minted") throw new Error("unreachable");

      // Ask with the SAME id, upper-cased. Postgres matches it (uuid equality is not textual), but the
      // returned `grant_id` is rendered lower-case — so a caller-keyed bucket would miss and drop the key.
      const batched = await listApiKeysForGrants(app, orgId, [g.grantId.toUpperCase()]);

      const allKeys = [...batched.values()].flat();
      expect(allKeys.map((k) => k.id)).toContain(g.keyId);
    });

    it("is a no-op (and hits no database) for an org with no grants", async () => {
      const orgId = randomUUID();
      await seedOrg(orgId);
      expect(await listApiKeysForGrants(app, orgId, [])).toEqual(new Map());
    });

    // The whole point of RLS: batching must not become a way to ask about ANOTHER org's grant. Passing a
    // foreign grant id must return an empty bucket, never that org's keys.
    it("never returns another org's keys, even when its grant id is passed explicitly", async () => {
      const orgA = randomUUID();
      const orgB = randomUUID();
      await seedOrg(orgA);
      await seedOrg(orgB);

      const bGrant = await mintScopedKey(
        app,
        {
          orgId: orgB,
          userId: userOf(orgB),
          scopes: ["events:read"],
          audience: API,
          ttlSeconds: 3600,
          authMethod: "pkce_loopback",
        },
        hasher,
        auditKey,
      );
      if (bGrant.status !== "minted") throw new Error("unreachable");

      // Org A asks about org B's grant id, by id. RLS (org_id = current_org_id()) must starve it.
      const batched = await listApiKeysForGrants(app, orgA, [bGrant.grantId]);

      expect(batched.get(bGrant.grantId)).toEqual([]);
      expect(JSON.stringify([...batched.values()])).not.toContain(bGrant.keyId);
    });
  });
});
