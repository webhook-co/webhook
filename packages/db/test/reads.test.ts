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
import { getEndpoint, getEvent, listEndpoints, listEvents } from "../src/reads";
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

const ctxA: AuthContext = { orgId: "", scopes: ["endpoints:read", "events:read", "audit:read"] };
const ctxB: AuthContext = { orgId: "", scopes: ["endpoints:read", "events:read", "audit:read"] };

async function seedEvent(
  orgId: string,
  endpointId: string,
  opts: { provider?: string | null } = {},
): Promise<string> {
  const id = newId();
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
         ${newId()}, ${"content_hash"}, ${opts.provider ?? null}, ${"evt_123"}, ${null},
         ${true}, ${tx.json({ ok: true, keyId: "key_1", scheme: "stripe" })})`;
  });
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
