import { randomUUID } from "node:crypto";

import {
  importAuditKey,
  importCursorKey,
  newId,
  parseSince,
  type Cursor,
} from "@webhook-co/shared";
import { type AuthContext } from "@webhook-co/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendAuditEntry } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { createReadHandlers, type CapabilityHandlers } from "../src/read-handlers";
import {
  getEndpoint,
  getEvent,
  latestTailCursor,
  likeContains,
  listEndpoints,
  listEvents,
  resolveSince,
  tailEvents,
  tailMeta,
} from "../src/reads";
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
let handlers: CapabilityHandlers;
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
  opts: {
    provider?: string | null;
    verified?: boolean;
    verification?: unknown;
    providerEventId?: string | null;
    externalId?: string | null;
    dedupKey?: string;
    headers?: [string, string][];
  } = {},
): Promise<string> {
  const id = newId();
  // Default = a verified event ({ok:true}); pass verified/verification to seed a failed (false + ok:false)
  // or unattempted (false + null) row; pass providerEventId/externalId/dedupKey for the search tests.
  const verified = opts.verified ?? true;
  const verification =
    opts.verification !== undefined
      ? opts.verification
      : { ok: true, keyId: "key_1", scheme: "stripe" };
  const providerEventId = opts.providerEventId !== undefined ? opts.providerEventId : "evt_123";
  const externalId = opts.externalId !== undefined ? opts.externalId : null;
  const dedupKey = opts.dedupKey ?? newId();
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, provider_event_id, external_id, verified, verification)
      values
        (${id}, ${orgId}, ${endpointId}, ${`org/${orgId}/ep/${endpointId}/${id}`}, ${1234},
         ${"application/json"}, ${tx.json(
           opts.headers ?? [
             ["content-type", "application/json"],
             ["x-test", "1"],
           ],
         )},
         ${dedupKey}, ${"content_hash"}, ${opts.provider ?? null}, ${providerEventId}, ${externalId},
         ${verified}, ${verification === null ? null : tx.json(verification)})`;
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

describe("likeContains (LIKE-metachar escaping)", () => {
  it("wraps a term as a CONTAINS pattern and escapes \\ % _", () => {
    expect(likeContains("acme")).toBe("%acme%");
    // %, _ and \ are escaped so they match literally (a user typing "50%" searches for "50%").
    expect(likeContains("50%_x\\y")).toBe("%50\\%\\_x\\\\y%");
  });
});

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
      listEvents(tx, { endpointId: epA, limit: 50, provider: ["github"] }),
    );
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.provider).toBe("github");
  });

  it("listEvents filters by a received-at range (>= after, < before)", async () => {
    // epTail's 3 events sit at tailAt(1000) < tailAt(2000) < tailAt(3000).
    const after = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: epTail, limit: 50, receivedAfter: tailAt(2000) }),
    );
    expect(new Set(after.items.map((e) => e.id))).toEqual(new Set([eTail2, eTail3])); // >= 2000

    const before = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: epTail, limit: 50, receivedBefore: tailAt(2000) }),
    );
    expect(before.items.map((e) => e.id)).toEqual([eTail1]); // strictly < 2000

    const between = await withTenant(app, orgA, (tx) =>
      listEvents(tx, {
        endpointId: epTail,
        limit: 50,
        receivedAfter: tailAt(1500),
        receivedBefore: tailAt(2500),
      }),
    );
    expect(between.items.map((e) => e.id)).toEqual([eTail2]); // only the middle one
  });

  it("listEvents composes a provider + received-at range filter (AND)", async () => {
    // stripe events on epTail are eTail1 (1000) + eTail3 (3000); the range keeps only eTail3.
    const page = await withTenant(app, orgA, (tx) =>
      listEvents(tx, {
        endpointId: epTail,
        limit: 50,
        provider: ["stripe"],
        receivedAfter: tailAt(2000),
      }),
    );
    expect(page.items.map((e) => e.id)).toEqual([eTail3]);
  });

  it("listEvents projects + filters the verification tri-state (verified | failed | unattempted)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-verif" }, hasher)).id;
    const vId = await seedEvent(orgA, ep, {
      provider: "stripe",
      verified: true,
      verification: { ok: true, keyId: "k", scheme: "stripe" },
    });
    const fId = await seedEvent(orgA, ep, {
      provider: "stripe",
      verified: false,
      verification: { ok: false, reason: { code: "WRONG_SECRET", confidence: "high" } },
    });
    const uId = await seedEvent(orgA, ep, {
      provider: "stripe",
      verified: false,
      verification: null,
    });

    const all = await withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: ep, limit: 50 }));
    const byId = new Map(all.items.map((e) => [e.id, e.verificationState]));
    expect(byId.get(vId)).toBe("verified");
    expect(byId.get(fId)).toBe("failed"); // verified=false AND verification non-null
    expect(byId.get(uId)).toBe("unattempted"); // verification IS NULL

    const failed = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, verificationState: ["failed"] }),
    );
    expect(failed.items.map((e) => e.id)).toEqual([fId]);

    const unattempted = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, verificationState: ["unattempted"] }),
    );
    expect(unattempted.items.map((e) => e.id)).toEqual([uId]);

    const verified = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, verificationState: ["verified"] }),
    );
    expect(verified.items.map((e) => e.id)).toEqual([vId]);
  });

  it("projects + filters the weaker 'authenticated' state (Tier-4 token/basic) disjoint from 'verified'", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-authn" }, hasher)).id;
    // A Tier-4 ok result carries `authenticity` in the stored verification jsonb → "authenticated".
    const aId = await seedEvent(orgA, ep, {
      provider: "gitlab",
      verified: true,
      verification: { ok: true, keyId: "secret_0", scheme: "gitlab", authenticity: "token" },
    });
    // A cryptographic ok (no authenticity) on the same endpoint stays "verified".
    const vId = await seedEvent(orgA, ep, {
      provider: "stripe",
      verified: true,
      verification: { ok: true, keyId: "k", scheme: "stripe" },
    });

    const all = await withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: ep, limit: 50 }));
    const byId = new Map(all.items.map((e) => [e.id, e.verificationState]));
    expect(byId.get(aId)).toBe("authenticated");
    expect(byId.get(vId)).toBe("verified");

    // The two buckets are disjoint: 'authenticated' returns ONLY the token row, 'verified' ONLY the crypto row.
    const authed = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, verificationState: ["authenticated"] }),
    );
    expect(authed.items.map((e) => e.id)).toEqual([aId]);

    const verifiedOnly = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, verificationState: ["verified"] }),
    );
    expect(verifiedOnly.items.map((e) => e.id)).toEqual([vId]);
  });

  it("the unattempted filter mirrors the CASE: a verified=true row with null verification stays 'verified'", async () => {
    // The invariant is verified=true ⇒ verification non-null, but nothing in the schema enforces it. A
    // pathological (verified=true, verification=null) row is labeled 'verified' by the CASE, so the
    // `unattempted` filter (`not verified and verification is null`) must NOT return it — else its pill
    // would contradict the filter. This guards the predicate↔CASE agreement.
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-verif-edge" }, hasher)).id;
    const pathId = await seedEvent(orgA, ep, { verified: true, verification: null });

    const all = await withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: ep, limit: 50 }));
    expect(all.items.find((e) => e.id === pathId)?.verificationState).toBe("verified");

    const unattempted = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, verificationState: ["unattempted"] }),
    );
    expect(unattempted.items.map((e) => e.id)).not.toContain(pathId);

    const verified = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, verificationState: ["verified"] }),
    );
    expect(verified.items.map((e) => e.id)).toContain(pathId);
  });

  it("getEvent derives the verificationState (failed = an adapter ran and rejected)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-verif-get" }, hasher)).id;
    const fId = await seedEvent(orgA, ep, {
      verified: false,
      verification: { ok: false, reason: { code: "SIGNATURE_MISMATCH" } },
    });
    const ev = await withTenant(app, orgA, (tx) => getEvent(tx, fId));
    expect(ev?.verificationState).toBe("failed");
  });

  it("listEvents searches across provider_event_id / external_id / dedup_key (+ uuid id exact)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-search" }, hasher)).id;
    const a = await seedEvent(orgA, ep, { providerEventId: "evt_STRIPE_abc", externalId: null });
    const b = await seedEvent(orgA, ep, { providerEventId: "pi_xyz", externalId: "order-9981" });
    const c = await seedEvent(orgA, ep, {
      providerEventId: null,
      externalId: null,
      dedupKey: "whid_special_777",
    });

    const search = (term: string) =>
      withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: ep, limit: 50, search: term }));

    // case-insensitive substring on provider_event_id
    expect((await search("stripe")).items.map((e) => e.id)).toEqual([a]);
    // substring on external_id
    expect((await search("9981")).items.map((e) => e.id)).toEqual([b]);
    // substring on dedup_key
    expect((await search("special")).items.map((e) => e.id)).toEqual([c]);
    // exact id match when the term is a uuid (the PK)
    expect((await search(b)).items.map((e) => e.id)).toEqual([b]);
    // no match → empty (a non-uuid term never reaches `id =`, so no 22P02)
    expect((await search("no-such-token")).items).toEqual([]);
  });

  it("listEvents search also matches the request headers (name + value, residual scan)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-hsearch" }, hasher)).id;
    const withHeader = await seedEvent(orgA, ep, {
      providerEventId: "evt_h1",
      headers: [
        ["content-type", "application/json"],
        ["x-shopify-topic", "orders/create"],
      ],
    });
    await seedEvent(orgA, ep, { providerEventId: "evt_h2" }); // default headers, no match
    const search = (term: string) =>
      withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: ep, limit: 50, search: term }));
    // a header VALUE
    expect((await search("orders/create")).items.map((e) => e.id)).toEqual([withHeader]);
    // a header NAME
    expect((await search("x-shopify-topic")).items.map((e) => e.id)).toEqual([withHeader]);
  });

  it("listEvents multi-selects provider (OR) and verificationState (OR)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-multi" }, hasher)).id;
    const s = await seedEvent(orgA, ep, { provider: "stripe", verified: true });
    const g = await seedEvent(orgA, ep, { provider: "github", verified: true });
    const x = await seedEvent(orgA, ep, {
      provider: "shopify",
      verified: false,
      verification: { ok: false, reason: { code: "WRONG_SECRET", confidence: "high" } },
    });
    const list = (opts: { provider?: string[]; verificationState?: VerificationState[] }) =>
      withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: ep, limit: 50, ...opts }));
    // provider OR: stripe + github (not shopify)
    expect(
      new Set((await list({ provider: ["stripe", "github"] })).items.map((e) => e.id)),
    ).toEqual(new Set([s, g]));
    // verificationState OR: verified + failed = all three
    expect(
      new Set((await list({ verificationState: ["verified", "failed"] })).items.map((e) => e.id)),
    ).toEqual(new Set([s, g, x]));
    // compose provider OR + verification OR: github(verified) only (shopify excluded by provider)
    expect(
      (await list({ provider: ["github", "stripe"], verificationState: ["failed"] })).items,
    ).toEqual([]); // stripe+github are verified, not failed
  });

  it("listEndpoints filters by a case-insensitive name substring", async () => {
    const tail = await withTenant(app, orgA, (tx) =>
      listEndpoints(tx, { limit: 50, name: "TAIL" }),
    );
    expect(tail.items.map((e) => e.id)).toEqual([epTail]); // matches "ep-tail", case-insensitively
    expect(tail.items.map((e) => e.id)).not.toContain(epA);

    const none = await withTenant(app, orgA, (tx) =>
      listEndpoints(tx, { limit: 50, name: "no-such-endpoint" }),
    );
    expect(none.items).toEqual([]);
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

  it("keyset is timezone-independent (µs cursor round-trips under a non-UTC session)", async () => {
    // The order key is UTC-anchored (`... at time zone 'UTC' ... "Z"`) and bound via `::text::timestamptz`,
    // so pagination must be identical regardless of the session TimeZone. Force a non-UTC zone and page two
    // same-millisecond, different-µs events within ONE tx (so `set local timezone` holds); both must surface.
    const epTz = (await createEndpoint(app, { orgId: orgA, name: "ep-tz" }, hasher)).id;
    const t1 = await seedEvent(orgA, epTz, { provider: "stripe" });
    const t2 = await seedEvent(orgA, epTz, { provider: "stripe" });
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-12T09:00:00.001100+00' where id = ${t1}`,
    );
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-12T09:00:00.001700+00' where id = ${t2}`,
    );
    const seen = await withTenant(app, orgA, async (tx) => {
      await tx`set local timezone = 'America/New_York'`; // UTC-4/5, definitely not UTC
      const acc = new Set<string>();
      let cursor: Cursor | undefined;
      for (let pages = 0; pages < 6; pages++) {
        const page = await listEvents(tx, { endpointId: epTz, cursor, limit: 1 });
        for (const ev of page.items) acc.add(ev.id);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return acc;
    });
    expect(seen).toEqual(new Set([t1, t2]));
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

  it("events.list coerces a received-at range filter (RFC3339 strings) and applies it", async () => {
    const page = (await handlers.get("events.list")!(ctxA, {
      endpointId: epTail,
      filter: { receivedAfter: tailAt(2000).toISOString() },
    })) as { items: { id: string }[] };
    expect(new Set(page.items.map((e) => e.id))).toEqual(new Set([eTail2, eTail3]));
  });

  it("events.list rejects a malformed range bound with VALIDATION_ERROR", async () => {
    await expectFault(
      handlers.get("events.list")!(ctxA, {
        endpointId: epTail,
        filter: { receivedBefore: "not-a-timestamp" },
      }),
      "VALIDATION_ERROR",
    );
  });

  it("events.list threads the verificationState filter (all tail fixtures are verified)", async () => {
    // The tail fixtures are seeded verified=true, so verificationState=verified returns all three and
    // failed/unattempted return none — proving the filter reaches listEvents through the handler.
    const verified = (await handlers.get("events.list")!(ctxA, {
      endpointId: epTail,
      filter: { verificationState: ["verified"] },
    })) as { items: { id: string }[] };
    expect(new Set(verified.items.map((e) => e.id))).toEqual(new Set([eTail1, eTail2, eTail3]));
    const failed = (await handlers.get("events.list")!(ctxA, {
      endpointId: epTail,
      filter: { verificationState: ["failed"] },
    })) as { items: unknown[] };
    expect(failed.items).toEqual([]);
  });

  it("events.list normalizes a SCALAR provider/verificationState to an array (backward-compat)", async () => {
    // The contract accepts a scalar (the pre-multi-select shape); the read-handler asArray-normalizes it,
    // so a single-string filter still reaches listEvents as a one-element array and filters correctly.
    const verified = (await handlers.get("events.list")!(ctxA, {
      endpointId: epTail,
      filter: { verificationState: "verified", provider: "stripe" },
    })) as { items: { id: string }[] };
    // epTail's stripe events are eTail1 + eTail3 (eTail2 is github); all are verified.
    expect(new Set(verified.items.map((e) => e.id))).toEqual(new Set([eTail1, eTail3]));
  });

  it("events.list rejects an unknown verificationState with VALIDATION_ERROR (closed enum)", async () => {
    await expectFault(
      handlers.get("events.list")!(ctxA, {
        endpointId: epTail,
        filter: { verificationState: ["bogus"] },
      }),
      "VALIDATION_ERROR",
    );
  });

  it("endpoints.list applies a name substring filter via the handler", async () => {
    const page = (await handlers.get("endpoints.list")!(ctxA, { filter: { name: "tail" } })) as {
      items: { id: string }[];
    };
    expect(page.items.map((e) => e.id)).toEqual([epTail]);
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

  it("events.tail resolves a server-side --since into a forward page (beginning = oldest)", async () => {
    const page = (await handlers.get("events.tail")!(ctxA, {
      endpointId: epTail,
      since: "beginning",
    })) as { items: { id: string }[] };
    expect(page.items.map((e) => e.id)).toEqual([eTail1, eTail2, eTail3]);
  });

  it("events.tail rejects since + sinceCursor together (mutually exclusive)", async () => {
    await expectFault(
      handlers.get("events.tail")!(ctxA, { endpointId: epTail, since: "now", sinceCursor: "a.b" }),
      "VALIDATION_ERROR",
    );
  });

  it("events.tail rejects an invalid --since value", async () => {
    await expectFault(
      handlers.get("events.tail")!(ctxA, { endpointId: epTail, since: "latest" }),
      "VALIDATION_ERROR",
    );
  });

  it("events.tail surfaces the cursor contract: headCursor + caughtUp + lag", async () => {
    const page = (await handlers.get("events.tail")!(ctxA, { endpointId: epTail })) as {
      items: { id: string }[];
      nextCursor: string | null;
      headCursor: string | null;
      caughtUp: boolean;
      lag: { backlogCount: number; headLagMs?: number };
    };
    expect(page.items.map((e) => e.id)).toEqual([eTail1, eTail2, eTail3]);
    expect(page.nextCursor).toBeNull();
    expect(page.caughtUp).toBe(true); // no more pages under the watermark
    expect(page.headCursor).not.toBeNull(); // a real (watermark-bounded) head exists
    expect(page.lag.backlogCount).toBe(3); // 3 events from the (oldest) request position to head
    // head is the 2026-06-01 fixture, so the lag is a real, large positive delta (not a floored 0).
    expect(page.lag.headLagMs).toBeGreaterThan(1_000_000);
  });

  it("events.tail on an empty endpoint reports caughtUp, a null head, zero backlog", async () => {
    const epEmpty = (await createEndpoint(app, { orgId: orgA, name: "ep-empty-tail-h" }, hasher))
      .id;
    const page = (await handlers.get("events.tail")!(ctxA, { endpointId: epEmpty })) as {
      items: unknown[];
      caughtUp: boolean;
      headCursor: string | null;
      lag: { backlogCount: number };
    };
    expect(page.items).toEqual([]);
    expect(page.caughtUp).toBe(true);
    expect(page.headCursor).toBeNull();
    expect(page.lag.backlogCount).toBe(0);
  });

  it("events.list surfaces headCursor only (no caughtUp/lag — it is a newest-first browse)", async () => {
    const page = (await handlers.get("events.list")!(ctxA, { endpointId: epTail })) as {
      items: { id: string }[];
      nextCursor: string | null;
      headCursor: string | null;
      caughtUp?: unknown;
      lag?: unknown;
    };
    expect(typeof page.headCursor).toBe("string"); // an encoded, watermark-bounded newest position
    expect(page.caughtUp).toBeUndefined();
    expect(page.lag).toBeUndefined();
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

describe("latestTailCursor (the ?since=now boundary)", () => {
  it("returns the latest event at/below the watermark (the newest of the tail set)", async () => {
    const c = await withTenant(app, orgA, (tx) => latestTailCursor(tx, { endpointId: epTail }));
    expect(c).not.toBeNull();
    expect(c!.id).toBe(eTail3); // eTail1 < eTail2 < eTail3 by received_at
  });

  it("returns null for an endpoint with no events", async () => {
    const epEmpty = (await createEndpoint(app, { orgId: orgA, name: "ep-empty-now" }, hasher)).id;
    const c = await withTenant(app, orgA, (tx) => latestTailCursor(tx, { endpointId: epEmpty }));
    expect(c).toBeNull();
  });

  it("excludes events newer than the watermark (a just-arrived event is not yet 'now')", async () => {
    const epRecent = (await createEndpoint(app, { orgId: orgA, name: "ep-recent-now" }, hasher)).id;
    const recent = await seedEvent(orgA, epRecent, { provider: "stripe" });
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = now() - interval '2 seconds' where id = ${recent}`,
    );
    // The only event is inside the 5s watermark window → not visible to the tail → no 'now' cursor.
    expect(
      await withTenant(app, orgA, (tx) => latestTailCursor(tx, { endpointId: epRecent })),
    ).toBeNull();
  });

  it("is org-scoped under RLS (a cross-org endpoint yields null)", async () => {
    const c = await withTenant(app, orgA, (tx) => latestTailCursor(tx, { endpointId: epB }));
    expect(c).toBeNull();
  });
});

describe("tailMeta (watermark head + capped backlog count)", () => {
  it("returns headCursor = latestTailCursor and the full visible backlog when no cursor", async () => {
    const meta = await withTenant(app, orgA, (tx) => tailMeta(tx, { endpointId: epTail }));
    const head = await withTenant(app, orgA, (tx) => latestTailCursor(tx, { endpointId: epTail }));
    expect(meta.headCursor).toEqual(head); // head == the watermark-bounded latest, never raw MAX
    expect(meta.backlogCount).toBe(3); // eTail1..3, all <= watermark, none seen yet
  });

  it("counts only events strictly after sinceCursor (exclusive resume)", async () => {
    const first = await withTenant(app, orgA, (tx) =>
      tailEvents(tx, { endpointId: epTail, limit: 1 }),
    );
    const meta = await withTenant(app, orgA, (tx) =>
      tailMeta(tx, { endpointId: epTail, sinceCursor: first.nextCursor! }),
    );
    expect(meta.backlogCount).toBe(2); // eTail2, eTail3 remain unseen
    expect(meta.headCursor?.id).toBe(eTail3); // head unaffected by the resume position
  });

  it("returns null head + zero backlog for an empty endpoint", async () => {
    const epEmpty = (await createEndpoint(app, { orgId: orgA, name: "ep-empty-meta" }, hasher)).id;
    const meta = await withTenant(app, orgA, (tx) => tailMeta(tx, { endpointId: epEmpty }));
    expect(meta.headCursor).toBeNull();
    expect(meta.backlogCount).toBe(0);
  });

  it("is org-scoped under RLS (cross-org endpoint → null head, zero backlog)", async () => {
    const meta = await withTenant(app, orgA, (tx) => tailMeta(tx, { endpointId: epB }));
    expect(meta.headCursor).toBeNull();
    expect(meta.backlogCount).toBe(0);
  });

  it("counts BOTH same-millisecond events — the count must not drop a µs sibling (R1)", async () => {
    // The COUNT bounds on the RAW watermark + the lower ms-keyset, NEVER on the ms-truncated headCursor:
    // an upper bound on headCursor would exclude a same-ms row whose true µs exceeds head's truncation.
    const epPrec = (await createEndpoint(app, { orgId: orgA, name: "ep-meta-precision" }, hasher))
      .id;
    const p1 = await seedEvent(orgA, epPrec, { provider: "stripe" });
    const p2 = await seedEvent(orgA, epPrec, { provider: "stripe" });
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-09T12:00:00.004200+00' where id = ${p1}`,
    );
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-09T12:00:00.004800+00' where id = ${p2}`,
    );
    const meta = await withTenant(app, orgA, (tx) => tailMeta(tx, { endpointId: epPrec }));
    expect(meta.backlogCount).toBe(2); // both counted — no same-ms drop
    expect(meta.headCursor?.id).toBe([p1, p2].sort()[1]); // newest (max (ms,id)) is the head
  });

  it("caps the backlog count in SQL via a limit cap+1 sentinel (R7)", async () => {
    // Seed MORE than cap+1 events, then cap=2: a true SQL `limit cap+1` returns cap+1 (3); an
    // unbounded count would return the full 5. This discriminates the in-SQL stop from a JS clamp.
    const epCap = (await createEndpoint(app, { orgId: orgA, name: "ep-meta-cap" }, hasher)).id;
    for (let i = 0; i < 5; i++) await seedEventAt(orgA, epCap, tailAt(20_000 + i * 1000), "stripe");
    const meta = await withTenant(app, orgA, (tx) => tailMeta(tx, { endpointId: epCap, cap: 2 }));
    expect(meta.backlogCount).toBe(3); // cap+1 = "more than 2" — NOT 5, so the scan stopped in SQL
  });
});

describe("resolveSince (Kinesis total-function via synthetic boundary)", () => {
  // Resolve a --since value to a synthetic cursor server-side, then tail from it. No time→cursor table
  // lookup: the synthetic `(date_trunc('ms', T), 0-uuid)` rides the existing tailEvents keyset, so the
  // clamp semantics (before-earliest → beginning, future → empty) emerge from the keyset + watermark.
  async function tailFrom(endpointId: string, sinceStr: string): Promise<string[]> {
    const parsed = parseSince(sinceStr);
    if (parsed.kind === "invalid") throw new Error(`unexpected invalid --since: ${sinceStr}`);
    return withTenant(app, orgA, async (tx) => {
      const cursor = await resolveSince(tx, { endpointId, since: parsed });
      const page = await tailEvents(tx, { endpointId, sinceCursor: cursor, limit: 50 });
      return page.items.map((e) => e.id);
    });
  }

  it("beginning → from the oldest event, inclusive", async () => {
    expect(await tailFrom(epTail, "beginning")).toEqual([eTail1, eTail2, eTail3]);
  });

  it("now → empty (only NEW events past the watermark head; the old backlog is skipped)", async () => {
    expect(await tailFrom(epTail, "now")).toEqual([]);
  });

  it("now skips the ENTIRE backlog including same-millisecond events (uses the head, not a synthetic ms)", async () => {
    const epNow = (await createEndpoint(app, { orgId: orgA, name: "ep-since-now" }, hasher)).id;
    const a = await seedEvent(orgA, epNow, { provider: "stripe" });
    const b = await seedEvent(orgA, epNow, { provider: "stripe" });
    // both in the same ms, well below the watermark — `now` must skip BOTH (a synthetic watermark-ms
    // boundary would re-surface them; the real head cursor excludes the whole same-ms backlog).
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-04T00:00:00.003100+00' where id = ${a}`,
    );
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-04T00:00:00.003900+00' where id = ${b}`,
    );
    expect(await tailFrom(epNow, "now")).toEqual([]);
  });

  it("a timestamp before the earliest event clamps to beginning ('whichever is greater')", async () => {
    expect(await tailFrom(epTail, "2026-05-01T00:00:00Z")).toEqual([eTail1, eTail2, eTail3]);
  });

  it("a future timestamp clamps to empty (resume live)", async () => {
    expect(await tailFrom(epTail, "2027-01-01T00:00:00Z")).toEqual([]);
  });

  it("a timestamp between events yields the events at/after it (>= T)", async () => {
    // eTail1@..01.000, eTail2@..02.000, eTail3@..03.000 → T=..01.500 selects eTail2, eTail3.
    expect(await tailFrom(epTail, "2026-06-01T00:00:01.500Z")).toEqual([eTail2, eTail3]);
  });

  it("a timestamp AT a same-millisecond cluster includes EVERY event at that ms (R4 — no skip)", async () => {
    const epMs = (await createEndpoint(app, { orgId: orgA, name: "ep-since-ms" }, hasher)).id;
    const m1 = await seedEvent(orgA, epMs, { provider: "stripe" });
    const m2 = await seedEvent(orgA, epMs, { provider: "stripe" });
    // both in the same ms (.007), µs differ; the synthetic (ms(T), 0-uuid) sorts below every real id
    // at that ms, so neither is skipped regardless of id order.
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-05T00:00:00.007200+00' where id = ${m1}`,
    );
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = '2026-06-05T00:00:00.007800+00' where id = ${m2}`,
    );
    const got = await tailFrom(epMs, "2026-06-05T00:00:00.007Z");
    expect([...got].sort()).toEqual([m1, m2].sort()); // both surfaced — no same-ms drop
  });

  it("resolve-once is stable for a timestamp (no clock drift between calls)", async () => {
    const parsed = parseSince("2026-06-01T00:00:01.500Z");
    if (parsed.kind === "invalid") throw new Error("x");
    const c1 = await withTenant(app, orgA, (tx) =>
      resolveSince(tx, { endpointId: epTail, since: parsed }),
    );
    const c2 = await withTenant(app, orgA, (tx) =>
      resolveSince(tx, { endpointId: epTail, since: parsed }),
    );
    expect(c1).toEqual(c2);
  });
});
