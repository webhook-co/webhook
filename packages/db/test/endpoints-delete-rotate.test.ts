import { randomUUID } from "node:crypto";

import {
  CreatedEndpointSchema,
  DeletedEndpointSchema,
  type AuthContext,
} from "@webhook-co/contract";
import { importAuditKey, verifyAuditChain } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import {
  createEndpointWithAudit,
  deleteEndpointWithAudit,
  makeEndpointTokenColdLookup,
  rotateEndpointWithAudit,
} from "../src/endpoints";
import { credentialCacheKey } from "../src/credential";
import type { CredentialCache } from "../src/credential-cache";
import { makeIngestHashEvictor } from "../src/ingest-resolver";
import { createOrg } from "../src/orgs";
import { getEndpoint, listEndpoints } from "../src/reads";
import { createWriteHandlers } from "../src/write-handlers";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The endpoints.delete (SOFT) + endpoints.rotate (HARD cutover) WRITE paths against a REAL Postgres
// under the non-owner webhook_app + webhook_authn roles (RLS), ADR-0076. Proves: soft-delete stops the
// ingest cold lookup (the deleted_at filter + the migration-0021 webhook_authn grant) and relieves the
// per-org cap; rotate swaps the token in place (old hash stops resolving, new hash resolves, history
// preserved); in-tx audit rows; idempotent re-delete; NOT_FOUND for unknown/cross-org/deleted ids; and
// the shared write handlers' scope-FIRST authz + KV eviction + best-effort eviction semantics.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — tenant DML under RLS
let authn: Sql; // webhook_authn — by-hash ingest cold lookup
let auditKey: CryptoKey;
let orgA: string;
let orgB: string;

async function countLive(orgId: string): Promise<number> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<
        { count: number }[]
      >`select count(*)::int as count from endpoints where deleted_at is null`,
  );
  return rows[0]?.count ?? 0;
}
async function auditLen(orgId: string): Promise<number> {
  const rows = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
  return rows.length;
}
async function makeLiveEndpoint(
  orgId: string,
  name: string,
): Promise<{ id: string; plaintext: string }> {
  const created = await createEndpointWithAudit(
    app,
    { orgId, name, actor: null, maxEndpoints: 100 },
    hasher,
    auditKey,
  );
  return { id: created.id, plaintext: created.plaintext };
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)),
  );
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

describe("migration 0021 — webhook_authn may read deleted_at (so the cold-lookup filter is permitted)", () => {
  it("can select deleted_at (the additive grant), but still NOT name (least-privilege held)", async () => {
    await expect(authn`select deleted_at from endpoints limit 1`).resolves.toBeDefined();
    await expect(authn`select name from endpoints limit 1`).rejects.toThrow(/permission denied/i);
  });
});

describe("deleteEndpointWithAudit (soft delete)", () => {
  it("soft-deletes, appends one endpoint.deleted audit row, and the token stops resolving", async () => {
    const ep = await makeLiveEndpoint(orgA, "to-delete");
    const cold = makeEndpointTokenColdLookup(authn);
    // Live first: the token resolves.
    expect((await cold(hasher.hash(ep.plaintext)))?.endpointId).toBe(ep.id);

    const before = await auditLen(orgA);
    const deleted = await deleteEndpointWithAudit(
      app,
      { orgId: orgA, endpointId: ep.id, actor: "user_alice" },
      auditKey,
    );
    expect(deleted.id).toBe(ep.id);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.wasLive).toBe(true);
    expect(Buffer.isBuffer(deleted.tokenHash)).toBe(true);

    // The cold lookup no longer resolves (deleted_at filter) — the DURABLE ingest stop, no KV involved.
    expect(await cold(hasher.hash(ep.plaintext))).toBeNull();

    // Exactly one endpoint.deleted audit row; the chain still verifies.
    const rows = await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA));
    expect(rows.length).toBe(before + 1);
    const last = rows[rows.length - 1]!;
    expect(last.action).toBe("endpoint.deleted");
    expect(last.target).toBe(ep.id);
    expect(last.actor).toBe("user_alice");
    expect((await verifyAuditChain(auditKey, orgA, rows)).ok).toBe(true);
  });

  it("hides the deleted endpoint from endpoints.get and endpoints.list", async () => {
    const ep = await makeLiveEndpoint(orgA, "hide-me");
    await deleteEndpointWithAudit(app, { orgId: orgA, endpointId: ep.id, actor: null }, auditKey);
    const got = await withTenant(app, orgA, (tx) => getEndpoint(tx, ep.id));
    expect(got).toBeNull();
    const page = await withTenant(app, orgA, (tx) => listEndpoints(tx, { limit: 200 }));
    expect(page.items.find((e) => e.id === ep.id)).toBeUndefined();
  });

  it("stays resolvable via getEndpoint({includeDeleted}) so its retained events stay readable/replayable", async () => {
    // The event handlers (events.list/tail/replay) gate on getEndpoint(..., {includeDeleted:true}), so a
    // deleted endpoint's captured events remain listable + replayable by id (ADR-0076 retention) — while
    // endpoints.get (the default, filtered) 404s. This is the regression the code review caught.
    const ep = await makeLiveEndpoint(orgA, "events-stay-readable");
    await deleteEndpointWithAudit(app, { orgId: orgA, endpointId: ep.id, actor: null }, auditKey);
    const filtered = await withTenant(app, orgA, (tx) => getEndpoint(tx, ep.id));
    expect(filtered).toBeNull(); // endpoints.get hides it
    const included = await withTenant(app, orgA, (tx) =>
      getEndpoint(tx, ep.id, { includeDeleted: true }),
    );
    expect(included?.id).toBe(ep.id); // the event handlers' gate still resolves it
    expect(included?.name).toBe("events-stay-readable");
  });

  it("is idempotent — a re-delete returns the original deletedAt and appends NO second audit row", async () => {
    const ep = await makeLiveEndpoint(orgA, "re-delete");
    const first = await deleteEndpointWithAudit(
      app,
      { orgId: orgA, endpointId: ep.id, actor: null },
      auditKey,
    );
    const afterFirst = await auditLen(orgA);

    const second = await deleteEndpointWithAudit(
      app,
      { orgId: orgA, endpointId: ep.id, actor: null },
      auditKey,
    );
    expect(second.wasLive).toBe(false);
    expect(second.deletedAt.getTime()).toBe(first.deletedAt.getTime()); // preserved, not re-stamped
    expect(await auditLen(orgA)).toBe(afterFirst); // no extra audit row on the no-op re-delete
  });

  it("throws NOT_FOUND for an unknown id", async () => {
    await expect(
      deleteEndpointWithAudit(
        app,
        { orgId: orgA, endpointId: randomUUID(), actor: null },
        auditKey,
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "NOT_FOUND" });
  });

  it("is org-isolated — deleting org B's endpoint under org A is NOT_FOUND (RLS-invisible)", async () => {
    const epB = await makeLiveEndpoint(orgB, "borg-del");
    await expect(
      deleteEndpointWithAudit(app, { orgId: orgA, endpointId: epB.id, actor: null }, auditKey),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "NOT_FOUND" });
    // Untouched under its own org.
    const stillThere = await withTenant(app, orgB, (tx) => getEndpoint(tx, epB.id));
    expect(stillThere?.id).toBe(epB.id);
  });

  it("relieves the per-org create cap — a soft-deleted endpoint no longer counts", async () => {
    const capOrg = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "CapDel" })).id;
    const a = await createEndpointWithAudit(
      app,
      { orgId: capOrg, name: "c1", actor: null, maxEndpoints: 2 },
      hasher,
      auditKey,
    );
    await createEndpointWithAudit(
      app,
      { orgId: capOrg, name: "c2", actor: null, maxEndpoints: 2 },
      hasher,
      auditKey,
    );
    // At the cap: a third create is rejected.
    await expect(
      createEndpointWithAudit(
        app,
        { orgId: capOrg, name: "c3", actor: null, maxEndpoints: 2 },
        hasher,
        auditKey,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // Delete one → a slot frees → the create now succeeds (cap counts LIVE rows only).
    await deleteEndpointWithAudit(app, { orgId: capOrg, endpointId: a.id, actor: null }, auditKey);
    expect(await countLive(capOrg)).toBe(1);
    await expect(
      createEndpointWithAudit(
        app,
        { orgId: capOrg, name: "c3", actor: null, maxEndpoints: 2 },
        hasher,
        auditKey,
      ),
    ).resolves.toBeDefined();
  });
});

describe("rotateEndpointWithAudit (hard cutover)", () => {
  it("swaps the token in place: old stops resolving, new resolves, history+id preserved, audit appended", async () => {
    const ep = await makeLiveEndpoint(orgA, "to-rotate");
    const cold = makeEndpointTokenColdLookup(authn);
    const before = await auditLen(orgA);

    const rotated = await rotateEndpointWithAudit(
      app,
      { orgId: orgA, endpointId: ep.id, actor: "user_bob" },
      hasher,
      auditKey,
    );
    expect(rotated.id).toBe(ep.id); // same endpoint identity
    expect(rotated.name).toBe("to-rotate"); // name preserved
    expect(rotated.plaintext).not.toBe(ep.plaintext); // a fresh token
    expect(Buffer.isBuffer(rotated.oldTokenHash)).toBe(true);

    // HARD cutover: the OLD token no longer resolves; the NEW token resolves to the SAME endpoint.
    expect(await cold(hasher.hash(ep.plaintext))).toBeNull();
    expect((await cold(hasher.hash(rotated.plaintext)))?.endpointId).toBe(ep.id);

    // One endpoint.rotated audit row; the chain verifies.
    const rows = await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA));
    expect(rows.length).toBe(before + 1);
    expect(rows[rows.length - 1]!.action).toBe("endpoint.rotated");
    expect(rows[rows.length - 1]!.target).toBe(ep.id);
    expect((await verifyAuditChain(auditKey, orgA, rows)).ok).toBe(true);
  });

  it("throws NOT_FOUND for an unknown id and for a deleted endpoint", async () => {
    await expect(
      rotateEndpointWithAudit(
        app,
        { orgId: orgA, endpointId: randomUUID(), actor: null },
        hasher,
        auditKey,
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "NOT_FOUND" });

    const ep = await makeLiveEndpoint(orgA, "rotate-after-delete");
    await deleteEndpointWithAudit(app, { orgId: orgA, endpointId: ep.id, actor: null }, auditKey);
    await expect(
      rotateEndpointWithAudit(
        app,
        { orgId: orgA, endpointId: ep.id, actor: null },
        hasher,
        auditKey,
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "NOT_FOUND" });
  });
});

describe("createWriteHandlers — endpoints.delete + endpoints.rotate", () => {
  const writeCtx: AuthContext = { orgId: "", scopes: ["endpoints:write"] };
  function handlersWithEvictor() {
    const evicted: Buffer[] = [];
    const handlers = createWriteHandlers({
      tenant: app,
      hasher,
      auditKey,
      ingestBaseUrl: "https://wbhk.my",
      maxEndpoints: 100,
      invalidateIngestHash: async (h) => void evicted.push(h),
    });
    return { handlers, evicted };
  }

  it("delete handler soft-deletes, evicts the token hash, and returns a contract-shaped result", async () => {
    const ep = await makeLiveEndpoint(orgA, "handler-del");
    const { handlers, evicted } = handlersWithEvictor();
    const out = (await handlers.get("endpoints.delete")!(
      { ...writeCtx, orgId: orgA },
      { endpointId: ep.id },
    )) as Record<string, unknown>;
    expect(out.id).toBe(ep.id);
    expect(DeletedEndpointSchema.safeParse(out).success).toBe(true);
    expect(evicted).toHaveLength(1); // the stored token hash was evicted from the ingest cache
    // The endpoint is gone from reads.
    expect(await withTenant(app, orgA, (tx) => getEndpoint(tx, ep.id))).toBeNull();
  });

  it("rotate handler mints a NEW one-time ingestUrl, evicts the OLD hash, and the new url resolves", async () => {
    const ep = await makeLiveEndpoint(orgA, "handler-rotate");
    const { handlers, evicted } = handlersWithEvictor();
    const out = (await handlers.get("endpoints.rotate")!(
      { ...writeCtx, orgId: orgA },
      { endpointId: ep.id },
    )) as Record<string, unknown>;
    expect(out.id).toBe(ep.id);
    expect(String(out.ingestUrl)).toMatch(/^https:\/\/wbhk\.my\/whep_[A-Za-z0-9_-]{43}$/);
    expect(CreatedEndpointSchema.safeParse(out).success).toBe(true);
    expect(evicted).toHaveLength(1); // the OLD hash was evicted (hard cutover)
    // The new url's token resolves to the same endpoint via the cold lookup.
    const newToken = String(out.ingestUrl).split("/").pop()!;
    const principal = await makeEndpointTokenColdLookup(authn)(hasher.hash(newToken));
    expect(principal?.endpointId).toBe(ep.id);
  });

  it("both reject a caller without endpoints:write (FORBIDDEN) and mutate NOTHING", async () => {
    const ep = await makeLiveEndpoint(orgA, "handler-denied");
    const { handlers } = handlersWithEvictor();
    const readCtx: AuthContext = { orgId: orgA, scopes: ["endpoints:read"] };
    await expect(
      handlers.get("endpoints.delete")!(readCtx, { endpointId: ep.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      handlers.get("endpoints.rotate")!(readCtx, { endpointId: ep.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Still live + resolvable: the scope check ran FIRST, before any mutation.
    expect((await withTenant(app, orgA, (tx) => getEndpoint(tx, ep.id)))?.id).toBe(ep.id);
  });

  it("both reject a non-uuid endpointId with VALIDATION_ERROR", async () => {
    const { handlers } = handlersWithEvictor();
    await expect(
      handlers.get("endpoints.delete")!({ ...writeCtx, orgId: orgA }, { endpointId: "nope" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      handlers.get("endpoints.rotate")!({ ...writeCtx, orgId: orgA }, { endpointId: "nope" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("fails LOUD (not a CapabilityFault) if the evictor dep is missing — a write surface must wire it", async () => {
    const ep = await makeLiveEndpoint(orgA, "no-evictor");
    const handlers = createWriteHandlers({
      tenant: app,
      hasher,
      auditKey,
      ingestBaseUrl: "https://wbhk.my",
    });
    // No invalidateIngestHash → the delete/rotate handlers throw a plain Error at invocation (wiring bug).
    await expect(
      handlers.get("endpoints.delete")!({ ...writeCtx, orgId: orgA }, { endpointId: ep.id }),
    ).rejects.toThrow(/invalidateIngestHash/);
    // The guard throws BEFORE the mutation, so the endpoint is untouched.
    expect((await withTenant(app, orgA, (tx) => getEndpoint(tx, ep.id)))?.id).toBe(ep.id);
  });

  it("with the production best-effort evictor, a KV failure does NOT fail the delete (reveal-safe)", async () => {
    const ep = await makeLiveEndpoint(orgA, "evict-throws");
    let onErrorCalled = false;
    // The PRODUCTION wiring: the handler is given makeIngestHashEvictor over a cache whose delete throws.
    // The wrapper swallows the KV error (logging via onError), so the delete commits and never 500s —
    // critical for rotate, where a thrown eviction would lose the one-time URL reveal.
    const throwingCache: CredentialCache = {
      get: async () => null,
      put: async () => {},
      delete: async () => {
        throw new Error("kv down");
      },
    };
    const handlers = createWriteHandlers({
      tenant: app,
      hasher,
      auditKey,
      ingestBaseUrl: "https://wbhk.my",
      invalidateIngestHash: makeIngestHashEvictor(throwingCache, () => {
        onErrorCalled = true;
      }),
    });
    await expect(
      handlers.get("endpoints.delete")!({ ...writeCtx, orgId: orgA }, { endpointId: ep.id }),
    ).resolves.toMatchObject({ id: ep.id });
    expect(onErrorCalled).toBe(true); // the failure was reported (loud log at the surface), not thrown
    expect(await withTenant(app, orgA, (tx) => getEndpoint(tx, ep.id))).toBeNull(); // delete committed
  });
});

describe("makeIngestHashEvictor", () => {
  it("deletes by credentialCacheKey(hash) — the exact bare-hex key the ingest resolver caches under", async () => {
    const deleted: string[] = [];
    const cache: CredentialCache = {
      get: async () => null,
      put: async () => {},
      delete: async (key) => void deleted.push(key),
    };
    const hash = Buffer.from("abccafe0", "hex");
    await makeIngestHashEvictor(cache)(hash);
    expect(deleted).toEqual([credentialCacheKey(hash)]);
  });

  it("is best-effort — swallows a throwing cache.delete and reports it via onError", async () => {
    const cache: CredentialCache = {
      get: async () => null,
      put: async () => {},
      delete: async () => {
        throw new Error("kv down");
      },
    };
    let reported: unknown;
    await expect(
      makeIngestHashEvictor(cache, (err) => {
        reported = err;
      })(Buffer.from("00", "hex")),
    ).resolves.toBeUndefined();
    expect(String(reported)).toMatch(/kv down/);
  });
});
