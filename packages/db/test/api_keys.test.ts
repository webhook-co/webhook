import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// api_keys DB-layer suite (WS-D1a, ADR-0008 Option B). Runs against a REAL Postgres
// with REAL non-owner roles so RLS, the column-level grant to webhook_authn, and the
// hash-at-rest discipline are all validated on a real engine (an in-memory/superuser
// PG would bypass RLS and the privilege system, invalidating every assertion).
//
// Two roles exercise the split (S2):
//   * webhook_app  — request-path create/list/revoke (full per-command RLS).
//   * webhook_authn — bearer-verify read path; a separate FOR SELECT policy + a
//     column-level grant on (key_hash, org_id, scopes, expires_at, revoked_at) only.

const PREFIX = "whk";

// Mint a key the way the request path does (ADR-0003 discipline): a CSPRNG >=256-bit
// secret, shown once, with ONLY its sha256 hash persisted. S4: sha256 is intentional —
// the secret is high-entropy random, so a slow/keyed hash would add nothing (same
// reasoning as endpoints.ingest_token_hash). The plaintext is never written to the DB.
function mintKey(): { plaintext: string; keyHash: Buffer; start: string } {
  const secret = randomBytes(32); // 256-bit CSPRNG
  const plaintext = `${PREFIX}_${secret.toString("base64url")}`;
  const keyHash = createHash("sha256").update(plaintext).digest();
  return { plaintext, keyHash, start: plaintext.slice(0, 11) };
}

function hashOf(plaintext: string): Buffer {
  return createHash("sha256").update(plaintext).digest();
}

interface VerifyRow {
  org_id: string;
  scopes: unknown;
  expires_at: Date | null;
  revoked_at: Date | null;
  key_hash: Buffer;
}

/**
 * The bearer-verify seam the authn role drives. API-key verification is
 * ORG-DISCOVERY-BY-HASH: there is no expected org before the lookup — the presented
 * key determines its org. So this looks up GLOBALLY by hash (that's why webhook_authn
 * holds a FOR SELECT USING(true) policy and a column-scoped grant), constant-time
 * compares the hash, then honors revocation/expiry. On success it returns the owning
 * org + scopes; the caller then pins the tenant context to THAT org. Returns null when
 * no key matches (wrong/forged plaintext), or the key is revoked/expired.
 */
async function verify(
  authn: Sql,
  plaintext: string,
): Promise<{ orgId: string; scopes: unknown } | null> {
  const candidate = hashOf(plaintext);
  const rows = await authn<VerifyRow[]>`
    select org_id, scopes, expires_at, revoked_at, key_hash
    from api_keys where key_hash = ${candidate}`;
  const row = rows[0];
  if (!row) return null;
  // Constant-time compare on the hash (defense-in-depth; the lookup already matched on
  // equality, but verification must never branch on a timing-leaky compare).
  if (row.key_hash.length !== candidate.length) return null;
  if (!timingSafeEqual(row.key_hash, candidate)) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) return null;
  return { orgId: row.org_id, scopes: row.scopes };
}

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — create/list/revoke
let authn: Sql; // webhook_authn — bearer verify (column-scoped SELECT)
let owner: Sql; // schema owner — assertions about at-rest storage
let orgA: string;
let orgB: string;

/** Create an org + an active api key under that org's context; return the plaintext. */
async function createKey(
  orgId: string,
  opts: { name?: string; expiresAt?: Date | null; scopes?: string[] } = {},
): Promise<{ id: string; plaintext: string; keyHash: Buffer }> {
  const { plaintext, keyHash, start } = mintKey();
  const id = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into api_keys (id, org_id, key_hash, prefix, start, name, scopes, expires_at)
      values (${id}, ${orgId}, ${keyHash}, ${PREFIX}, ${start},
              ${opts.name ?? "default"}, ${tx.json(opts.scopes ?? ["events:read"])},
              ${opts.expiresAt ?? null})`;
  });
  return { id, plaintext, keyHash };
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));

  orgA = randomUUID();
  orgB = randomUUID();
  for (const orgId of [orgA, orgB]) {
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"Org"})`;
    });
  }
}, 90_000);

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await owner?.end();
  await pg?.stop();
});

describe("api_keys lifecycle (create -> verify -> revoke -> list)", () => {
  it("creates a key, verifies it (discovering its org), then revocation makes verify fail", async () => {
    const { id, plaintext } = await createKey(orgA, { name: "lifecycle" });

    const ok = await verify(authn, plaintext);
    expect(ok).not.toBeNull();
    expect(ok?.orgId).toBe(orgA); // the key DISCOVERS its owning org

    // revoke (app-side): stamp revoked_at.
    await withTenant(app, orgA, async (tx) => {
      await tx`update api_keys set revoked_at = now() where id = ${id}`;
    });

    expect(await verify(authn, plaintext)).toBeNull();
  });

  it("lists the org's keys without ever exposing a hash or plaintext to the listing", async () => {
    const rows = await withTenant(app, orgA, async (tx) => {
      return tx<{ id: string; name: string; start: string }[]>`
        select id, name, start from api_keys order by created_at`;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Display columns are safe; the verify path uses key_hash, never the listing.
      expect(r.start.startsWith(PREFIX)).toBe(true);
    }
  });
});

describe("hash at rest (plaintext never stored)", () => {
  it("stores only the sha256 hash; the plaintext appears in no column", async () => {
    const { id, plaintext, keyHash } = await createKey(orgA, { name: "atrest" });

    // owner is FORCE-RLS-policed too, so read under org A's context to see the row.
    const [row] = await withTenant(owner, orgA, async (tx) => {
      return tx<{ key_hash: Buffer; start: string; name: string }[]>`
        select key_hash, start, name from api_keys where id = ${id}`;
    });
    // The stored hash equals sha256(plaintext)...
    expect(Buffer.compare(row.key_hash, keyHash)).toBe(0);
    // ...and the full plaintext secret never lands in any text column. (base64url can
    // itself contain '_', so strip the known "whk_" prefix rather than splitting on '_'.)
    const secret = plaintext.slice(PREFIX.length + 1);
    const dump = await withTenant(owner, orgA, async (tx) => {
      return tx<{ t: string }[]>`
        select coalesce(start,'') || '|' || coalesce(name,'') as t from api_keys where id = ${id}`;
    });
    expect(dump[0].t).not.toContain(secret);
    // `start` is a truncated, non-sensitive display prefix — never the full secret.
    expect(row.start.length).toBeLessThan(plaintext.length);
  });

  it("verifies via the hash, not the plaintext — a wrong plaintext fails", async () => {
    const { plaintext } = await createKey(orgA, { name: "wrongpw" });
    expect(await verify(authn, plaintext)).not.toBeNull();
    expect(await verify(authn, `${plaintext}tampered`)).toBeNull();
  });
});

describe("expiry and revocation honored on verify", () => {
  it("an expired key does not verify", async () => {
    const { plaintext } = await createKey(orgA, {
      name: "expired",
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await verify(authn, plaintext)).toBeNull();
  });

  it("a future-dated expiry still verifies", async () => {
    const { plaintext } = await createKey(orgA, {
      name: "future",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(await verify(authn, plaintext)).not.toBeNull();
  });
});

describe("cross-org isolation (webhook_app is RLS-bound to its own org's keys)", () => {
  it("org A's app context cannot see or revoke org B's keys (RLS)", async () => {
    const { id } = await createKey(orgB, { name: "borg" });

    // webhook_app under org A's context: org B's row is invisible and immutable.
    const visible = await withTenant(app, orgA, async (tx) => {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from api_keys where org_id = ${orgB}`;
      return n;
    });
    expect(visible).toBe(0);

    const revoked = await withTenant(app, orgA, async (tx) => {
      const res = await tx`update api_keys set revoked_at = now() where id = ${id}`;
      return res.count;
    });
    expect(revoked).toBe(0);
  });

  it("verify is org-discovery: B's key resolves to B's org, never A's", async () => {
    // A genuine key always discovers its TRUE owner; there is no way to make B's key
    // present as A's (the org is read straight off the matched row, not supplied).
    const { plaintext } = await createKey(orgB, { name: "bdiscover" });
    const result = await verify(authn, plaintext);
    expect(result?.orgId).toBe(orgB);
    expect(result?.orgId).not.toBe(orgA);
  });
});

describe("webhook_authn column-level grant (S2) and write denial", () => {
  it("can SELECT exactly the granted columns of api_keys", async () => {
    // Granted: key_hash, org_id, scopes, expires_at, revoked_at.
    await authn`select key_hash, org_id, scopes, expires_at, revoked_at from api_keys limit 1`;
  });

  it("cannot read the ungranted metadata columns (name, prefix, start, timestamps)", async () => {
    for (const col of ["name", "prefix", "start", "last_used_at", "created_at", "updated_at"]) {
      await expect(authn`select ${authn(col)} from api_keys limit 1`).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it("cannot select * (that would touch ungranted columns)", async () => {
    await expect(authn`select * from api_keys limit 1`).rejects.toThrow(/permission denied/i);
  });

  it("cannot INSERT, UPDATE, or DELETE api_keys (verify-only role)", async () => {
    await expect(
      authn`insert into api_keys (id, org_id, key_hash, prefix, start, name, scopes)
            values (${randomUUID()}, ${orgA}, ${randomBytes(32)}, ${PREFIX}, ${"whk_x"}, ${"x"}, ${authn.json([])})`,
    ).rejects.toThrow(/permission denied/i);
    await expect(
      authn`update api_keys set revoked_at = now() where org_id = ${orgA}`,
    ).rejects.toThrow(/permission denied/i);
    await expect(authn`delete from api_keys where org_id = ${orgA}`).rejects.toThrow(
      /permission denied/i,
    );
  });
});
