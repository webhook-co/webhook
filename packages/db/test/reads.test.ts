import { randomUUID } from "node:crypto";

import { importAuditKey, importCursorKey, newId, type Cursor } from "@webhook-co/shared";
import { type AuthContext } from "@webhook-co/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendAuditEntry } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { createReadHandlers, type ReadHandlers } from "../src/read-handlers";
import { getEndpoint, getEvent, listEndpoints, listEvents, tailEvents } from "../src/reads";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The read repos + the shared capability read-handlers, against a REAL Postgres with the
// non-owner webhook_app role under RLS. Proves: tenant scoping (RLS), keyset pagination,
// full-fidelity events.get, the audit.verify handler, and the CapabilityFault taxonomy
// (scope -> FORBIDDEN, bad input/cursor -> VALIDATION_ERROR, missing row -> NOT_FOUND).

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let cursorKey: CryptoKey;
let auditKey: CryptoKey;
let handlers: ReadHandlers;
let orgA: string;
let orgB: string;
let epA: string; // an endpoint in org A with several events
let epB: string; // an endpoint in org B (cross-org target)
let epTail: string; // org A endpoint with 3 events at controlled (backdated) receive times

const ctxA: AuthContext = { orgId: "", scopes: ["endpoints:read", "events:read", "audit:read"] };
const ctxB: AuthContext = { orgId: "", scopes: ["endpoints:read", "events:read", "audit:read"] };

// Deterministic receive times for the tail fixtures, far in the past so they're always well below
// the gapless watermark (now() - δ, computed Postgres-side). eTail1 < eTail2 < eTail3 by received_at.
const TAIL_BASE = new Date("2026-06-01T00:00:00.000Z");
const tailAt = (ms: number): Date => new Date(TAIL_BASE.getTime() + ms);
let eTail1: string;
let eTail2: string;
let eTail3: string;

async function seedEvent(
  orgId: string,
  endpointId: string,
  opts: { provider?: string | null } = {},
): Promise<string> {
  const id = newId();
  const externalId: string | null = null; // explicit typed NULL (no bare null in the SQL template)
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, provider_event_id, external_id, verified, verification)
      values
        (${id}, ${orgId}, ${endpointId}, ${`org/${orgId}/ep/${endpointId}/${id}`}, ${1234},
         ${"application/json"}, ${tx.json([
           ["content-type", "application/json"],
           ["x-test", "1"],
         ])},
         ${newId()}, ${"content_hash"}, ${opts.provider ?? null}, ${"evt_123"}, ${externalId},
         ${true}, ${tx.json({ ok: true, keyId: "key_1", scheme: "stripe" })})`;
  });
  return id;
}

// Seed an event, then backdate received_at to an exact time. The received_at trigger is
// `before insert` only (it stamps now() on insert), so a later UPDATE under the org's tenant
// context positions the row deterministically relative to a chosen watermark cutoff. webhook_app
// holds UPDATE on events + the events_update RLS policy (org_id = current_org_id()).
async function seedEventAt(
  orgId: string,
  endpointId: string,
  receivedAt: Date,
  provider: string | null = null,
): Promise<string> {
  const id = await seedEvent(orgId, endpointId, { provider });
  await withTenant(
    app,
    orgId,
    (tx) => tx`update events set received_at = ${receivedAt} where id = ${id}`,
  );
  return id;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  cursorKey = await importCursorKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)),
  );
  handlers = createReadHandlers({ tenant: app, cursorKey, auditKey });

  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
  ctxA.orgId = orgA;
  ctxB.orgId = orgB;

  epA = (await createEndpoint(app, { orgId: orgA, name: "ep-a" }, hasher)).id;
  epB = (await createEndpoint(app, { orgId: orgB, name: "ep-b" }, hasher)).id;

  // org A: 3 events on epA (2 stripe, 1 github); org B: 1 event on epB.
  await seedEvent(orgA, epA, { provider: "stripe" });
  await seedEvent(orgA, epA, { provider: "github" });
  await seedEvent(orgA, epA, { provider: "stripe" });
  await seedEvent(orgB, epB, { provider: "stripe" });

  // org A: a tail endpoint with 3 events at fixed, well-past receive times.
  epTail = (await createEndpoint(app, { orgId: orgA, name: "ep-tail" }, hasher)).id;
  eTail1 = await seedEventAt(orgA, epTail, tailAt(1000), "stripe");
  eTail2 = await seedEventAt(orgA, epTail, tailAt(2000), "github");
  eTail3 = await seedEventAt(orgA, epTail, tailAt(3000), "stripe");

  // org A: a small valid audit chain (genesis + 2).
  await withTenant(app, orgA, async (tx) => {
    await appendAuditEntry(tx, auditKey, {
      orgId: orgA,
      actor: "u1",
      action: "org.created",
      target: null,
    });
  });
  await withTenant(app, orgA, async (tx) => {
    await appendAuditEntry(tx, auditKey, {
      orgId: orgA,
      actor: "u1",
      action: "endpoint.created",
      target: epA,
    });
  });
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

function expectFault(p: Promise<unknown>, code: string): Promise<void> {
  return expect(p).rejects.toMatchObject({ name: "CapabilityFault", code });
}

describe("reads repos (RLS + keyset pagination)", () => {
  it("listEndpoints is org-scoped and getEndpoint returns null cross-org", async () => {
    const page = await withTenant(app, orgA, (tx) => listEndpoints(tx, { limit: 50 }));
    expect(page.items.map((e) => e.id)).toContain(epA);
    expect(page.items.map((e) => e.id)).not.toContain(epB);

    const own = await withTenant(app, orgA, (tx) => getEndpoint(tx, epA));
    expect(own?.id).toBe(epA);
    const cross = await withTenant(app, orgA, (tx) => getEndpoint(tx, epB));
    expect(cross).toBeNull(); // org B's endpoint invisible to org A (RLS)
  });

  it("listEvents paginates with a keyset cursor (advances + terminates, no dupes)", async () => {
    const seen = new Set<string>();
    let cursor: Cursor | undefined;
    let pages = 0;
    for (;;) {
      const page = await withTenant(app, orgA, (tx) =>
        listEvents(tx, { endpointId: epA, cursor, limit: 2 }),
      );
      for (const ev of page.items) seen.add(ev.id);
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10); // guard against a non-terminating cursor
    }
    expect(seen.size).toBe(3); // all of org A's events, each exactly once
    expect(pages).toBe(2); // 2 + 1 at limit 2
  });

  it("listEvents filters by provider", async () => {
    const page = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: epA, limit: 50, provider: "github" }),
    );
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.provider).toBe("github");
  });

  it("listEvents does not skip same-millisecond events across a backward keyset page", async () => {
    // The DESC sibling of the tail's stall: a ms cursor over µs storage skips a same-ms neighbour
    // whose true µs is below the boundary's truncated cursor. The ms-truncated keyset must surface both.
    const epPrec = (await createEndpoint(app, { orgId: orgA, name: "ep-precision-list" }, hasher))
      .id;
    const p1 = await seedEvent(orgA, epPrec, { provider: "stripe" });
    const p2 = await seedEvent(orgA, epPrec, { provider: "stripe" });
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-11T12:00:00.007300+00' where id = ${p1}`,
    );
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-11T12:00:00.007900+00' where id = ${p2}`,
    );
    const seen = new Set<string>();
    let cursor: Cursor | undefined;
    let pages = 0;
    for (;;) {
      const page = await withTenant(app, orgA, (tx) =>
        listEvents(tx, { endpointId: epPrec, cursor, limit: 1 }),
      );
      for (const ev of page.items) seen.add(ev.id);
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(6);
    }
    expect(seen).toEqual(new Set([p1, p2])); // both surfaced — no skip
  });

  it("getEvent returns the full-fidelity event (headers + verification + payload ref)", async () => {
    const id = (await withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: epA, limit: 1 })))
      .items[0]!.id;
    const ev = await withTenant(app, orgA, (tx) => getEvent(tx, id));
    expect(ev?.payloadR2Key).toContain(`ep/${epA}/`);
    expect(ev?.payloadBytes).toBe(1234);
    expect(ev?.headers).toEqual([
      ["content-type", "application/json"],
      ["x-test", "1"],
    ]);
    expect(ev?.verification).not.toBeNull();
  });
});

describe("read-handlers (scope, validation, NOT_FOUND, audit.verify)", () => {
  it("endpoints.list round-trips an opaque cursor and is org-scoped", async () => {
    const first = (await handlers.get("endpoints.list")!(ctxA, { limit: 50 })) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.items.some((e) => e.id === epA)).toBe(true);
    const bView = (await handlers.get("endpoints.list")!(ctxB, { limit: 50 })) as {
      items: { id: string }[];
    };
    expect(bView.items.some((e) => e.id === epA)).toBe(false); // org B can't see org A's endpoint
  });

  it("endpoints.get returns NOT_FOUND across the org boundary", async () => {
    await expectFault(handlers.get("endpoints.get")!(ctxA, { endpointId: epB }), "NOT_FOUND");
  });

  it("events.list returns NOT_FOUND for an endpoint the org does not own", async () => {
    await expectFault(handlers.get("events.list")!(ctxA, { endpointId: epB }), "NOT_FOUND");
  });

  it("events.tail returns a forward page of summaries up to the watermark", async () => {
    const page = (await handlers.get("events.tail")!(ctxA, { endpointId: epTail })) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(page.items.map((e) => e.id)).toEqual([eTail1, eTail2, eTail3]); // oldest-first
    expect(page.nextCursor).toBeNull(); // 3 events < the default page size
  });

  it("events.tail returns NOT_FOUND for an endpoint the org does not own", async () => {
    await expectFault(handlers.get("events.tail")!(ctxA, { endpointId: epB }), "NOT_FOUND");
  });

  it("events.tail rejects an under-scoped caller (FORBIDDEN) and a tampered cursor", async () => {
    const noScope: AuthContext = { orgId: orgA, scopes: [] };
    await expectFault(handlers.get("events.tail")!(noScope, { endpointId: epTail }), "FORBIDDEN");
    await expectFault(
      handlers.get("events.tail")!(ctxA, { endpointId: epTail, sinceCursor: "garbage.deadbeef" }),
      "VALIDATION_ERROR",
    );
  });

  it("rejects an under-scoped caller with FORBIDDEN", async () => {
    const noScope: AuthContext = { orgId: orgA, scopes: [] };
    await expectFault(handlers.get("endpoints.list")!(noScope, {}), "FORBIDDEN");
  });

  it("rejects malformed input and a tampered cursor with VALIDATION_ERROR", async () => {
    await expectFault(
      handlers.get("events.get")!(ctxA, { eventId: "not-a-uuid" }),
      "VALIDATION_ERROR",
    );
    await expectFault(
      handlers.get("endpoints.list")!(ctxA, { cursor: "garbage.deadbeef" }),
      "VALIDATION_ERROR",
    );
  });

  it("audit.verify reports ok for a valid chain and a break for the wrong key", async () => {
    const ok = (await handlers.get("audit.verify")!(ctxA, {})) as {
      ok: boolean;
      rowsVerified: number;
    };
    expect(ok.ok).toBe(true);
    expect(ok.rowsVerified).toBe(2);

    // A handler built with a DIFFERENT audit key must surface a hash_mismatch break
    // (the chain can't be tampered in place — audit_log is immutable — so we vary the key).
    const wrongKey = await importAuditKey(new Uint8Array(32).fill(9));
    const wrong = createReadHandlers({ tenant: app, cursorKey, auditKey: wrongKey });
    const broken = (await wrong.get("audit.verify")!(ctxA, {})) as {
      ok: boolean;
      break?: { kind: string };
    };
    expect(broken.ok).toBe(false);
    expect(broken.break?.kind).toBe("hash_mismatch");
  });
});

describe("tailEvents (forward, watermark-bounded)", () => {
  it("returns events oldest-first up to the watermark", async () => {
    const page = await withTenant(app, orgA, (tx) =>
      tailEvents(tx, { endpointId: epTail, limit: 50 }),
    );
    expect(page.items.map((e) => e.id)).toEqual([eTail1, eTail2, eTail3]);
  });

  it("paginates forward with a keyset cursor (advances + terminates, no dupes)", async () => {
    const seen: string[] = [];
    let cursor: Cursor | undefined;
    let pages = 0;
    for (;;) {
      const page = await withTenant(app, orgA, (tx) =>
        tailEvents(tx, { endpointId: epTail, sinceCursor: cursor, limit: 2 }),
      );
      for (const ev of page.items) seen.push(ev.id);
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10); // guard against a non-terminating cursor
    }
    expect(seen).toEqual([eTail1, eTail2, eTail3]); // forward order, each exactly once
    expect(pages).toBe(2); // 2 + 1 at limit 2
  });

  it("resumes strictly after sinceCursor", async () => {
    const first = await withTenant(app, orgA, (tx) =>
      tailEvents(tx, { endpointId: epTail, limit: 1 }),
    );
    expect(first.items.map((e) => e.id)).toEqual([eTail1]);
    expect(first.nextCursor).not.toBeNull();
    const rest = await withTenant(app, orgA, (tx) =>
      tailEvents(tx, { endpointId: epTail, sinceCursor: first.nextCursor!, limit: 50 }),
    );
    expect(rest.items.map((e) => e.id)).toEqual([eTail2, eTail3]);
  });

  it("withholds events newer than the Postgres-side watermark (now() - δ)", async () => {
    // The watermark is computed DB-side, so position rows relative to the DB clock: a row ~2s old is
    // inside the 5s window (withheld); a row ~30s old has cleared it (returned). δ = WATERMARK_DELTA_MS
    // (5s), so these offsets sit ~3s / ~25s from the boundary — no timing flakiness.
    const epWm = (await createEndpoint(app, { orgId: orgA, name: "ep-watermark" }, hasher)).id;
    const recent = await seedEvent(orgA, epWm, { provider: "stripe" });
    const old = await seedEvent(orgA, epWm, { provider: "stripe" });
    await withTenant(app, orgA, async (tx) => {
      await tx`update events set received_at = now() - interval '2 seconds' where id = ${recent}`;
      await tx`update events set received_at = now() - interval '30 seconds' where id = ${old}`;
    });
    const page = await withTenant(app, orgA, (tx) =>
      tailEvents(tx, { endpointId: epWm, limit: 50 }),
    );
    expect(page.items.map((e) => e.id)).toEqual([old]); // the cleared row only
    expect(page.items.map((e) => e.id)).not.toContain(recent); // still inside the watermark window
  });

  it("is org-scoped: a cross-org endpoint yields no rows under RLS", async () => {
    const page = await withTenant(app, orgA, (tx) =>
      tailEvents(tx, { endpointId: epB, limit: 50 }),
    );
    expect(page.items).toEqual([]);
  });

  it("isolates CONCURRENT tenant polls — no cross-tenant leakage under set_config(local)", async () => {
    // The watermark+cursor are pooling-safe only if each poll's org context (set_config(..., local))
    // stays pinned to its own transaction. Race two orgs' tails on the shared pool and assert neither
    // sees the other's rows — the regression that would fire if the GUC leaked across connections.
    const epIsoA = (await createEndpoint(app, { orgId: orgA, name: "ep-iso-a" }, hasher)).id;
    const epIsoB = (await createEndpoint(app, { orgId: orgB, name: "ep-iso-b" }, hasher)).id;
    const aEvents = [
      await seedEventAt(orgA, epIsoA, tailAt(10_000)),
      await seedEventAt(orgA, epIsoA, tailAt(11_000)),
    ];
    const bEvent = await seedEventAt(orgB, epIsoB, tailAt(10_000));

    const [aPage, bPage] = await Promise.all([
      withTenant(app, orgA, (tx) => tailEvents(tx, { endpointId: epIsoA, limit: 50 })),
      withTenant(app, orgB, (tx) => tailEvents(tx, { endpointId: epIsoB, limit: 50 })),
    ]);
    expect([...aPage.items.map((e) => e.id)].sort()).toEqual([...aEvents].sort());
    expect(bPage.items.map((e) => e.id)).toEqual([bEvent]);

    // Cross-org: org A polling org B's endpoint sees nothing, even concurrently.
    const cross = await withTenant(app, orgA, (tx) =>
      tailEvents(tx, { endpointId: epIsoB, limit: 50 }),
    );
    expect(cross.items).toEqual([]);
  });

  it("paginates same-millisecond events without duplicating or stalling (precision regression)", async () => {
    // Two events in the SAME millisecond with non-zero microsecond fractions — the exact case
    // a ms-resolution cursor over a µs-precision column gets wrong: the boundary row's true µs is
    // > its own truncated cursor, so a naive (received_at, id) > keyset re-emits it forever.
    const epPrec = (await createEndpoint(app, { orgId: orgA, name: "ep-precision-tail" }, hasher))
      .id;
    const p1 = await seedEvent(orgA, epPrec, { provider: "stripe" });
    const p2 = await seedEvent(orgA, epPrec, { provider: "stripe" });
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-10T12:00:00.005200+00' where id = ${p1}`,
    );
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-10T12:00:00.005800+00' where id = ${p2}`,
    );
    const seen: string[] = [];
    let cursor: Cursor | undefined;
    let pages = 0;
    for (;;) {
      const page = await withTenant(app, orgA, (tx) =>
        tailEvents(tx, { endpointId: epPrec, sinceCursor: cursor, limit: 1 }),
      );
      for (const ev of page.items) seen.push(ev.id);
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(6); // a precision stall would spin here forever
    }
    expect(seen.length).toBe(2); // each exactly once — no boundary duplicate
    expect([...seen].sort()).toEqual([p1, p2].sort()); // both surfaced (id orders within the ms)
    expect(pages).toBe(2);
  });
});
