import { randomUUID } from "node:crypto";

import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeApiKeyColdLookup } from "../src/api-keys";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { InMemoryCredentialCache } from "../src/credential-cache";
import { createCredentialResolver } from "../src/credential-resolver";
import { approveGrant, createPendingGrant, mintKeyForGrant, mintScopedKey } from "../src/grants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

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
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"Org"})`;
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
}, 90_000);

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
    const [{ n }] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from api_keys where grant_id = ${res.grantId}`,
    );
    expect(n).toBe(0); // no key minted
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
    const [{ n }] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from api_keys where grant_id = ${first.grantId}`,
    );
    expect(n).toBe(2);
    const [{ g }] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ g: number }[]>`select count(*)::int as g from auth_grant where org_id = ${orgId}`,
    );
    expect(g).toBe(1);
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
