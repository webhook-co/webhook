import { randomUUID } from "node:crypto";

import {
  importAuditKey,
  importCursorKey,
  msToOrderKey,
  newId,
  parseSince,
  type Cursor,
  type VerificationState,
  userActor,
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
  cursorBelowOldest,
  getEndpoint,
  getEvent,
  isIngestPaused,
  latestOrgTailCursor,
  latestTailCursor,
  likeContains,
  listEndpoints,
  listEvents,
  listEndpointNames,
  listOrgEvents,
  orgTailMeta,
  resolveSince,
  tailEvents,
  tailMeta,
  tailOrgEventsWithCursors,
} from "../src/reads";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

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

let ctxA: AuthContext = { orgId: "", scopes: ["endpoints:read", "events:read", "audit:read"] };
let ctxB: AuthContext = { orgId: "", scopes: ["endpoints:read", "events:read", "audit:read"] };

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
    dedupStrategy?: string;
    method?: string | null;
    eventType?: string | null;
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
         dedup_key, dedup_strategy, method, event_type, provider, provider_event_id, external_id,
         verified, verification)
      values
        (${id}, ${orgId}, ${endpointId}, ${`org/${orgId}/ep/${endpointId}/${id}`}, ${1234},
         ${"application/json"}, ${tx.json(
           opts.headers ?? [
             ["content-type", "application/json"],
             ["x-test", "1"],
           ],
         )},
         ${dedupKey}, ${opts.dedupStrategy ?? "content_hash"}, ${opts.method ?? null},
         ${opts.eventType ?? null}, ${opts.provider ?? null}, ${providerEventId}, ${externalId},
         ${verified}, ${verification === null ? null : tx.json(verification as Parameters<typeof tx.json>[0])})`;
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

  orgA = (await createOrg(app, { slug: `o-${randomUUID().slice(0, 8)}`, name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: `o-${randomUUID().slice(0, 8)}`, name: "Org B" })).id;
  ctxA = { ...ctxA, orgId: orgA };
  ctxB = { ...ctxB, orgId: orgB };

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
      actor: userActor("u1"),
      action: "org.created",
      target: null,
    });
  });
  await withTenant(app, orgA, async (tx) => {
    await appendAuditEntry(tx, auditKey, {
      orgId: orgA,
      actor: userActor("u1"),
      action: "endpoint.created",
      target: epA,
    });
  });
}, setupHookTimeoutMs());

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

  it("listEvents projects + filters the verification state (verified | failed | unattempted; authenticated has its own test)", async () => {
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

  // The search surface, as it now IS — two trigram-indexed columns plus an exact uuid id match.
  //
  // It used to OR in `external_id` and `headers::text` as well. Both are gone, and the reason is the same for
  // both: a disjunction is only index-usable when EVERY branch is index-backed, so those two branches forced
  // the whole search off the 0023 trigram GINs — which then paid ingest write-amp for zero read benefit.
  it("listEvents searches provider_event_id + dedup_key (+ exact uuid id)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-search" }, hasher)).id;
    const a = await seedEvent(orgA, ep, { providerEventId: "evt_STRIPE_abc" });
    const b = await seedEvent(orgA, ep, { providerEventId: "pi_xyz" });
    const c = await seedEvent(orgA, ep, { providerEventId: null, dedupKey: "whid_special_777" });

    const search = (term: string) =>
      withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: ep, limit: 50, search: term }));

    // case-insensitive substring on provider_event_id
    expect((await search("stripe")).items.map((e) => e.id)).toEqual([a]);
    // substring on dedup_key
    expect((await search("special")).items.map((e) => e.id)).toEqual([c]);
    // exact id match when the term is a uuid (the PK)
    expect((await search(b)).items.map((e) => e.id)).toEqual([b]);
    // no match → empty (a non-uuid term never reaches `id =`, so no 22P02)
    expect((await search("no-such-token")).items).toEqual([]);
  });

  // external_id search is GONE, and this pins WHY so nobody "restores" it as a regression.
  //
  // `events.external_id` is bound `null::text` unconditionally at ingest (ingest-event.ts) — it is v1's
  // superseded idempotency key, retained per the design record "for human correlation only", with no inbound
  // source and none ever designed. So the branch could never match a real row: the only reason the OLD test
  // passed is that it SEEDED a value by hand that production cannot produce. A test fixture was the sole
  // evidence for a capability. That is exactly how a dead branch survives review — and it cost every search
  // the trigram path, because an unindexable branch poisons the whole disjunction.
  it("does not search external_id — the column is never written, so the branch was unreachable", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-extid" }, hasher)).id;
    // Hand-seed the value production cannot: even so, it must not be findable.
    // dedupKey is PINNED (not the random newId() default) so external_id is the ONLY field carrying "9981":
    // the default random hex dedup_key can coincidentally contain the digits "9981" (~1/2500), which would
    // make this "external_id is unsearchable" assertion flake by matching dedup_key instead (a real bug this
    // test hit in CI, per probabilistic-failures-look-like-flakes).
    await seedEvent(orgA, ep, {
      providerEventId: "evt_e1",
      dedupKey: "dedup-e1",
      externalId: "order-9981",
    });
    const hits = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, search: "9981" }),
    );
    expect(hits.items).toEqual([]);
  });

  // A DELIBERATE, MEASURED LOSS — not an oversight. Header search worked, via an unindexed `headers::text
  // ilike` residual, and dropping it is a real narrowing for users.
  //
  // The alternative was a trigram GIN on (headers::text), which would have kept it AND made the disjunction
  // bitmap-able. It was benchmarked on the ingest hot path against a rule written before the number was known
  // (see ingest-gin-writeamp.pg.test.ts): allowed 1.25x p99, MEASURED ~88x. `webhook_ingest` has a 5s
  // statement_timeout and WATERMARK_DELTA_MS derives from it — a GIN pending-list flush inside that budget is
  // a DROPPED WEBHOOK. Header search is not worth dropping webhooks for.
  it("no longer matches request headers (refused: a GIN on headers cost ~88x ingest p99)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-hsearch" }, hasher)).id;
    await seedEvent(orgA, ep, {
      providerEventId: "evt_h1",
      headers: [
        ["content-type", "application/json"],
        ["x-shopify-topic", "orders/create"],
      ],
    });
    const search = (term: string) =>
      withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: ep, limit: 50, search: term }));

    expect((await search("orders/create")).items).toEqual([]); // a header VALUE
    expect((await search("x-shopify-topic")).items).toEqual([]); // a header NAME
    // The row is still findable by what search DOES cover — the narrowing is scoped, not a black hole.
    expect((await search("evt_h1")).items).toHaveLength(1);
  });

  // #24: headerSearch RESTORES header search as its OWN opt-in facet — an UNINDEXED `headers::text ilike`
  // residual (the GIN was refused at ~88x ingest write-amp, above). It is SEPARATE from `search`: the fast
  // trigram search stays un-poisoned, and this AND-composes with it rather than OR'ing in.
  it("headerSearch matches a substring of the raw headers, case-insensitively; a non-match is excluded", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-hdrsearch" }, hasher)).id;
    const shopify = await seedEvent(orgA, ep, {
      providerEventId: "evt_shop",
      headers: [
        ["content-type", "application/json"],
        ["x-shopify-topic", "orders/create"],
      ],
    });
    await seedEvent(orgA, ep, {
      providerEventId: "evt_other",
      headers: [["content-type", "application/json"]],
    });
    const headerSearch = (term: string) =>
      withTenant(app, orgA, (tx) =>
        listEvents(tx, { endpointId: ep, limit: 50, headerSearch: term }),
      );

    // a header NAME
    expect((await headerSearch("x-shopify-topic")).items.map((e) => e.id)).toEqual([shopify]);
    // a header VALUE
    expect((await headerSearch("orders/create")).items.map((e) => e.id)).toEqual([shopify]);
    // case-insensitive (ilike)
    expect((await headerSearch("X-SHOPIFY-TOPIC")).items.map((e) => e.id)).toEqual([shopify]);
    // a term in no row's headers → empty
    expect((await headerSearch("stripe-signature")).items).toEqual([]);
    // HONESTY PIN (#24, review): headers are stored as a jsonb ARRAY of [name, value] pairs, so `headers::text`
    // serializes to `[["x-shopify-topic", "orders/create"]]` — NOT wire form. A user pasting a wire-form header
    // LINE (`name: value`) matches NOTHING, because that `: ` separator isn't in the serialized text. The copy
    // everywhere says "names and values", never "paste a header line" — this asserts the residual is honest.
    expect((await headerSearch("x-shopify-topic: orders/create")).items).toEqual([]);
  });

  it("headerSearch AND-composes with search — an event matching search but NOT headerSearch is excluded", async () => {
    // Proves the two are SEPARATE AND'd filters, not OR'd. A row matching `search` (its provider_event_id)
    // but NOT `headerSearch` (its headers) must be excluded — an OR would have kept it.
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-hdr-and" }, hasher)).id;
    const both = await seedEvent(orgA, ep, {
      providerEventId: "evt_match",
      headers: [["x-shopify-topic", "orders/create"]],
    });
    // Matches `search` (evt_match) but its headers do NOT contain "shopify" → excluded by the AND.
    await seedEvent(orgA, ep, {
      providerEventId: "evt_match_2",
      headers: [["content-type", "application/json"]],
    });
    const got = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, search: "evt_match", headerSearch: "shopify" }),
    );
    expect(got.items.map((e) => e.id)).toEqual([both]);
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

  it("listEvents filters by dedupStrategy (multi-select, OR)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-dedup" }, hasher)).id;
    const uniq = await seedEvent(orgA, ep, { dedupStrategy: "unique" });
    const hash = await seedEvent(orgA, ep, { dedupStrategy: "content_hash" });
    await seedEvent(orgA, ep, { dedupStrategy: "sw_webhook_id" });
    const got = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, dedupStrategy: ["unique", "content_hash"] }),
    );
    expect(new Set(got.items.map((e) => e.id))).toEqual(new Set([uniq, hash]));
  });

  it("listEvents filters by method (multi-select, OR) — a NULL-method legacy row never matches", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-method" }, hasher)).id;
    const get = await seedEvent(orgA, ep, { method: "GET" });
    const post = await seedEvent(orgA, ep, { method: "POST" });
    await seedEvent(orgA, ep, { method: "DELETE" });
    await seedEvent(orgA, ep, { method: null }); // pre-0028 legacy: no verb recorded
    const got = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, method: ["GET", "POST"] }),
    );
    // `method in ('GET','POST')` — SQL IN never matches NULL, so the legacy row is correctly excluded.
    expect(new Set(got.items.map((e) => e.id))).toEqual(new Set([get, post]));
  });

  it("listEvents filters by eventType (exact) — NULL (unparsed provider) never matches", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-etype" }, hasher)).id;
    const charge = await seedEvent(orgA, ep, { eventType: "charge.succeeded" });
    await seedEvent(orgA, ep, { eventType: "charge.failed" });
    await seedEvent(orgA, ep, { eventType: null }); // provider we don't parse an event type for
    const got = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: ep, limit: 50, eventType: "charge.succeeded" }),
    );
    expect(got.items.map((e) => e.id)).toEqual([charge]);
  });

  it("listEvents composes the new facets with each other (AND across fields)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-facet-and" }, hasher)).id;
    const hit = await seedEvent(orgA, ep, {
      method: "POST",
      eventType: "invoice.paid",
      dedupStrategy: "sw_webhook_id",
    });
    await seedEvent(orgA, ep, {
      method: "GET",
      eventType: "invoice.paid",
      dedupStrategy: "sw_webhook_id",
    });
    await seedEvent(orgA, ep, {
      method: "POST",
      eventType: "invoice.void",
      dedupStrategy: "sw_webhook_id",
    });
    const got = await withTenant(app, orgA, (tx) =>
      listEvents(tx, {
        endpointId: ep,
        limit: 50,
        method: ["POST"],
        eventType: "invoice.paid",
        dedupStrategy: ["sw_webhook_id"],
      }),
    );
    expect(got.items.map((e) => e.id)).toEqual([hit]);
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

  it("events.list with NO endpointId lists the whole org (no NOT_FOUND, RLS-scoped, cross-endpoint)", async () => {
    // Org-wide browse: no existence gate (there's no endpoint to gate on), every endpoint in the org. Assert
    // by ENDPOINT SET, not an exact count — other describe blocks in this file seed more events into orgA.
    const aView = (await handlers.get("events.list")!(ctxA, { limit: 200 })) as {
      items: { id: string; endpointId: string }[];
    };
    const aEndpoints = new Set(aView.items.map((e) => e.endpointId));
    // Spans MULTIPLE endpoints (epA + epTail among them) — the point of org-wide vs endpoint-scoped.
    expect(aEndpoints.has(epA)).toBe(true);
    expect(aEndpoints.has(epTail)).toBe(true);
    // RLS keeps orgB's endpoint out.
    expect(aEndpoints.has(epB)).toBe(false);
    // ctxB's org-wide view is the mirror image: epB present, orgA's endpoints absent.
    const bView = (await handlers.get("events.list")!(ctxB, { limit: 200 })) as {
      items: { endpointId: string }[];
    };
    const bEndpoints = new Set(bView.items.map((e) => e.endpointId));
    expect(bEndpoints.has(epB)).toBe(true);
    expect(bEndpoints.has(epA)).toBe(false);
    expect(bEndpoints.has(epTail)).toBe(false);
  });

  it("events.list org-wide still honors filters (provider across all endpoints)", async () => {
    // github events include 1 on epA + eTail2 on epTail (both orgA). Assert the filter is EXACT (every row
    // matches) + a floor count, not an exact total (other blocks may seed more github rows).
    const page = (await handlers.get("events.list")!(ctxA, {
      limit: 200,
      filter: { provider: "github" },
    })) as { items: { provider: string | null }[] };
    expect(page.items.length).toBeGreaterThanOrEqual(2);
    expect(page.items.every((e) => e.provider === "github")).toBe(true);
  });

  it("events.list threads headerSearch through the shared handler (api + mcp path)", async () => {
    // The handler is what api + mcp both dispatch to, so this proves the facet actually reaches browseEvents
    // there (not just via a direct listEvents call). Seed a row whose headers carry a unique marker.
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-hdr-handler" }, hasher)).id;
    const marked = await seedEvent(orgA, ep, {
      headers: [["x-uniquehdr-24", "present"]],
    });
    await seedEvent(orgA, ep, { headers: [["content-type", "application/json"]] });
    const page = (await handlers.get("events.list")!(ctxA, {
      endpointId: ep,
      limit: 50,
      filter: { headerSearch: "x-uniquehdr-24" },
    })) as { items: { id: string }[] };
    expect(page.items.map((e) => e.id)).toEqual([marked]);
  });

  it("events.list org-wide omits headCursor (the endpoint-scoped resume position doesn't apply)", async () => {
    // headCursor is a resume position for the endpoint-scoped events.tail; an org-wide browse has none.
    const page = (await handlers.get("events.list")!(ctxA, { limit: 50 })) as {
      headCursor?: string | null;
    };
    expect(page.headCursor ?? null).toBeNull();
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
    // inside the δ window (withheld); a row ~30s old has cleared it (returned). δ = WATERMARK_DELTA_MS
    // (6s = 5s statement_timeout + 1s commit margin), so these offsets sit ~4s / ~24s from the boundary
    // — no timing flakiness.
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

describe("cursorBelowOldest (CURSOR_EXPIRED guard for future retention)", () => {
  it("is false for the endpoint's newest cursor (everything after it is retained)", async () => {
    const newest = await withTenant(app, orgA, (tx) =>
      latestTailCursor(tx, { endpointId: epTail }),
    );
    expect(newest).not.toBeNull();
    const expired = await withTenant(app, orgA, (tx) =>
      cursorBelowOldest(tx, { endpointId: epTail, cursor: newest! }),
    );
    expect(expired).toBe(false);
  });

  it("is false for a cursor exactly at the oldest surviving event", async () => {
    // epTail's oldest is eTail1 at tailAt(1000); a cursor at that exact µs position is not below min.
    const atOldest: Cursor = { orderKey: msToOrderKey(tailAt(1000).getTime()), id: eTail1 };
    const expired = await withTenant(app, orgA, (tx) =>
      cursorBelowOldest(tx, { endpointId: epTail, cursor: atOldest }),
    );
    expect(expired).toBe(false);
  });

  it("is TRUE for a cursor strictly older than the oldest surviving event (pruned gap)", async () => {
    // Simulates a retention job having deleted every event up to some horizon: the agent's cursor now
    // sits below the endpoint's min(received_at), so resuming would skip the pruned rows.
    const ancient: Cursor = {
      orderKey: msToOrderKey(new Date("2020-01-01T00:00:00.000Z").getTime()),
      id: randomUUID(),
    };
    const expired = await withTenant(app, orgA, (tx) =>
      cursorBelowOldest(tx, { endpointId: epTail, cursor: ancient }),
    );
    expect(expired).toBe(true);
  });

  it("is false for an endpoint with no events (empty tail, not a gap)", async () => {
    const epEmpty = (await createEndpoint(app, { orgId: orgA, name: "ep-empty-cbo" }, hasher)).id;
    const anyCursor: Cursor = {
      orderKey: msToOrderKey(new Date("2020-01-01T00:00:00.000Z").getTime()),
      id: randomUUID(),
    };
    const expired = await withTenant(app, orgA, (tx) =>
      cursorBelowOldest(tx, { endpointId: epEmpty, cursor: anyCursor }),
    );
    expect(expired).toBe(false);
  });
});

describe("latestTailCursor (the STATUS-frame + browse head; no longer the ?since=now seed)", () => {
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

// The ORG-WIDE forward tail — the read behind the consolidated events page's live tail. Like the org-wide
// browse it carries NO endpoint predicate; RLS's org_id = current_org_id() is the only scope. The load-bearing
// property beyond correctness is that the µs keyset holds ACROSS endpoints (a page/resume boundary can fall
// between two events on different endpoints at the same microsecond). Asserts PROPERTIES over a known event
// subset, never exact counts — the suite shares one org and other blocks seed more events.
describe("tailOrgEventsWithCursors / orgTailMeta / latestOrgTailCursor (org-wide tail)", () => {
  // A SECOND below-watermark endpoint in org A, interleaved in time with epTail's events (1000<1500<2000<
  // 2500<3000), so an org-wide asc tail must weave the two endpoints together.
  let epTail2: string;
  let eMid1: string; // tailAt(1500) — between eTail1 and eTail2
  let eMid2: string; // tailAt(2500) — between eTail2 and eTail3
  const known = () => [eTail1, eMid1, eTail2, eMid2, eTail3];

  beforeAll(async () => {
    epTail2 = (await createEndpoint(app, { orgId: orgA, name: "ep-tail-2" }, hasher)).id;
    eMid1 = await seedEventAt(orgA, epTail2, tailAt(1500), "stripe");
    eMid2 = await seedEventAt(orgA, epTail2, tailAt(2500), "github");
  }, setupHookTimeoutMs());

  it("weaves events from MULTIPLE endpoints in one oldest-first stream", async () => {
    const page = await withTenant(app, orgA, (tx) => tailOrgEventsWithCursors(tx, { limit: 200 }));
    const ids = page.items.map((i) => i.item.id);
    // The whole point: an endpoint-scoped tail can only ever see one of these endpoints.
    const endpoints = new Set(page.items.map((i) => i.item.endpointId));
    expect(endpoints.has(epTail)).toBe(true);
    expect(endpoints.has(epTail2)).toBe(true);
    // Filtered to the known set, the interleave order is exact — proving the cross-endpoint µs ordering.
    expect(ids.filter((id) => known().includes(id))).toEqual(known());
  });

  it("is RLS-scoped: another org's org-wide tail never sees this org's events", async () => {
    const bPage = await withTenant(app, orgB, (tx) => tailOrgEventsWithCursors(tx, { limit: 200 }));
    const bIds = bPage.items.map((i) => i.item.id);
    for (const id of known()) expect(bIds).not.toContain(id);
  });

  it("resumes across endpoints from a per-event cursor without a dup or a skip", async () => {
    // Take the first known event's cursor, then resume: the stream must continue with the NEXT known event on
    // the OTHER endpoint, never re-deliver, never skip.
    const first = await withTenant(app, orgA, (tx) => tailOrgEventsWithCursors(tx, { limit: 200 }));
    const cursorOfETail1 = first.items.find((i) => i.item.id === eTail1)!.cursor;
    const resumed = await withTenant(app, orgA, (tx) =>
      tailOrgEventsWithCursors(tx, { sinceCursor: cursorOfETail1, limit: 200 }),
    );
    const resumedIds = resumed.items.map((i) => i.item.id);
    expect(resumedIds).not.toContain(eTail1); // strictly AFTER the cursor
    expect(resumedIds.filter((id) => known().includes(id))).toEqual([eMid1, eTail2, eMid2, eTail3]);
  });

  it("latestOrgTailCursor is the newest below-watermark event across the whole org", async () => {
    const head = await withTenant(app, orgA, (tx) => latestOrgTailCursor(tx));
    // eTail3 at tailAt(3000) is the newest of the known set; nothing seeded here is later. (Other blocks may
    // seed even-later backdated events, so assert the head is at least as new as eTail3, and never below it.)
    const eTail3Cursor = await withTenant(app, orgA, (tx) =>
      latestTailCursor(tx, { endpointId: epTail }),
    );
    expect(head).not.toBeNull();
    expect(head!.orderKey >= eTail3Cursor!.orderKey).toBe(true);
  });

  it("orgTailMeta head = latestOrgTailCursor and its backlog spans endpoints, capped in SQL", async () => {
    const [meta, head] = await Promise.all([
      withTenant(app, orgA, (tx) => orgTailMeta(tx, {})),
      withTenant(app, orgA, (tx) => latestOrgTailCursor(tx)),
    ]);
    expect(meta.headCursor?.id).toBe(head?.id);
    // The known set alone is 5 events across 2 endpoints; the full org backlog is ≥ that. Cap it low to prove
    // the SQL `limit cap+1` stop rather than a JS clamp.
    const capped = await withTenant(app, orgA, (tx) => orgTailMeta(tx, { cap: 3 }));
    expect(capped.backlogCount).toBe(4); // cap+1 = "more than 3", not the full count
  });

  it("resolveSince needs no endpointId for the org tail: now → empty, beginning → from oldest", async () => {
    const rows = async (since: string) =>
      withTenant(app, orgA, async (tx) => {
        const parsed = parseSince(since);
        if (parsed.kind === "invalid") throw new Error(`bad --since ${since}`);
        const cursor = await resolveSince(tx, { since: parsed }); // NO endpointId
        const page = await tailOrgEventsWithCursors(tx, { sinceCursor: cursor, limit: 200 });
        return page.items.map((i) => i.item.id).filter((id) => known().includes(id));
      });
    expect(await rows("now")).toEqual([]); // everything already arrived is history
    expect(await rows("beginning")).toEqual(known()); // oldest-inclusive across endpoints
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
      const cursor = await resolveSince(tx, { since: parsed });
      const page = await tailEvents(tx, { endpointId, sinceCursor: cursor, limit: 50 });
      return page.items.map((e) => e.id);
    });
  }

  it("beginning → from the oldest event, inclusive", async () => {
    expect(await tailFrom(epTail, "beginning")).toEqual([eTail1, eTail2, eTail3]);
  });

  // `now` is WALL-CLOCK server-now (founder decision 2026-07-17): "live = from this point forward, no
  // history". Everything already arrived has a received_at in the past, so it is excluded; only what lands
  // AFTER the seed instant is delivered (once it matures below the watermark, its received_at is still > the
  // seed, so the keyset admits it). The deliberate cost: an in-flight event whose received_at is a few
  // seconds old but not yet visible is history to the reader, and is skipped — which is the point.
  it("now → empty: the whole existing backlog is behind you", async () => {
    expect(await tailFrom(epTail, "now")).toEqual([]);
  });

  // THE YOUNG-ENDPOINT FIX, tested at the RESOLVER, not through tailEvents — because tailEvents applies its
  // OWN watermark filter, so a young burst is excluded either way and a tail-level test would be a no-op that
  // passes against the bug (the trap this lane already fell in once).
  //
  // The bug lived in resolveSince: `latestTailCursor(...) ?? undefined`. An endpoint whose ENTIRE history is
  // younger than δ has no row below the watermark, so latestTailCursor returns null → undefined → the DO's
  // oldest-inclusive sentinel → it replays the whole young burst once those rows mature. Wall-clock `now` has
  // no null case, so this cannot happen. `toBeDefined` is meaningful here precisely because undefined WAS the
  // bug, and the age bound proves the cursor is "now", not the oldest event.
  it("now resolves to a recent cursor even for a young endpoint (never undefined = never oldest)", async () => {
    const epNow = (await createEndpoint(app, { orgId: orgA, name: "ep-since-now-young" }, hasher))
      .id;
    await seedEvent(orgA, epNow, { provider: "stripe" }); // young: above the watermark, the null case
    await seedEvent(orgA, epNow, { provider: "stripe" });

    const { cursor, dbNow } = await withTenant(app, orgA, async (tx) => {
      const cursor = await resolveSince(tx, { since: { kind: "now" } });
      // The reference clock is the DB's, NOT the test runner's — the cursor is now()-derived, and on the
      // remote nightly the runner and Neon are different hosts, so a runner Date.now() comparison could go
      // negative from clock skew (a red nightly that is not a regression — the trap this lane has hit).
      const [row] = await tx<{ t: number }[]>`select extract(epoch from now()) * 1000 as t`;
      return { cursor, dbNow: row!.t };
    });
    expect(cursor).toBeDefined(); // old code returned undefined here → oldest-inclusive replay
    const ageMs = dbNow - new Date(cursor!.orderKey).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(0); // the seed is at/before the DB clock read just after it
    expect(ageMs).toBeLessThan(60_000); // it is "now", not the dawn of the endpoint
  });

  // A matured PAST event stays excluded: `now` must never regress into `beginning`. This holds under both the
  // old head-cursor and the new wall-clock seed (both exclude a below-watermark past row), so it is a
  // guard against a future regression, not a proof of THIS change — the young-endpoint test above is that.
  it("now excludes an event that arrived (and matured) before the seed instant", async () => {
    const epPast = (await createEndpoint(app, { orgId: orgA, name: "ep-since-now-past" }, hasher))
      .id;
    const older = await seedEvent(orgA, epPast, { provider: "stripe" });
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set received_at = now() - interval '1 hour' where id = ${older}`,
    );
    expect(await tailFrom(epPast, "now")).toEqual([]);
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
    const c1 = await withTenant(app, orgA, (tx) => resolveSince(tx, { since: parsed }));
    const c2 = await withTenant(app, orgA, (tx) => resolveSince(tx, { since: parsed }));
    expect(c1).toEqual(c2);
  });
});

// isIngestPaused (S4): the org-level cap-pause read that the billable replay paths gate on. Proves the real
// SQL against Postgres under the webhook_app role + RLS — including that it fails safe (absent row = false)
// and is TENANT-SCOPED (a clauseless `select paused from ingest_paused` returns THIS org's row only, never
// another org's, because the ingest_paused_select RLS policy scopes it to current_org_id()).
describe("isIngestPaused", () => {
  /** A fresh org (avoids contaminating the shared orgA/orgB fixtures used by the read tests above). */
  async function freshOrg(): Promise<string> {
    return (await createOrg(app, { slug: `o-${randomUUID().slice(0, 12)}`, name: "cap" })).id;
  }
  async function setPaused(orgId: string, paused: boolean): Promise<void> {
    await withTenant(
      app,
      orgId,
      (tx) => tx`insert into ingest_paused (org_id, paused) values (${orgId}, ${paused})
                 on conflict (org_id) do update set paused = ${paused}`,
    );
  }

  it("is false for an org that has never been paused (no row = fail-safe default)", async () => {
    const org = await freshOrg();
    expect(await withTenant(app, org, (tx) => isIngestPaused(tx))).toBe(false);
  });

  it("is true when the org's ingest_paused row is paused, and flips back to false on resume", async () => {
    const org = await freshOrg();
    await setPaused(org, true);
    expect(await withTenant(app, org, (tx) => isIngestPaused(tx))).toBe(true);
    await setPaused(org, false);
    expect(await withTenant(app, org, (tx) => isIngestPaused(tx))).toBe(false);
  });

  it("is TENANT-SCOPED under RLS — one org's pause never leaks to another", async () => {
    const paused = await freshOrg();
    const other = await freshOrg();
    await setPaused(paused, true);
    // `other` has no ingest_paused row at all; the clauseless read must NOT return `paused`'s row.
    expect(await withTenant(app, paused, (tx) => isIngestPaused(tx))).toBe(true);
    expect(await withTenant(app, other, (tx) => isIngestPaused(tx))).toBe(false);
    // And an `other` that is explicitly NOT paused still reads its own false, not the other org's true.
    await setPaused(other, false);
    expect(await withTenant(app, other, (tx) => isIngestPaused(tx))).toBe(false);
  });
});

// The org-wide events browse — the read behind the consolidated /org/{slug}/events page. Events were
// previously reachable ONLY through an endpoint (`listEvents` hard-requires endpointId), so this is a new
// read, not a widened one. RLS is the org boundary: like every other read here it carries NO org_id
// predicate, so these tests are also what prove `withTenant` is doing that job.
describe("listOrgEvents (org-wide browse)", () => {
  // Asserts PROPERTIES, not exact counts: this file shares one seeded org across many tests (and some seed
  // more events), so a count assertion would pass alone and fail in the suite — which is precisely what the
  // first draft of these tests did.
  it("returns events from EVERY endpoint in the org, newest-first", async () => {
    const page = await withTenant(app, orgA, (tx) => listOrgEvents(tx, { limit: 200 }));
    const endpoints = new Set(page.items.map((e) => e.endpointId));
    // The whole point: an endpoint-scoped read can only ever see ONE of these sets.
    expect(endpoints.has(epA)).toBe(true);
    expect(endpoints.has(epTail)).toBe(true);
    const times = page.items.map((e) => e.receivedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("is RLS-scoped: another org's events are never returned", async () => {
    const page = await withTenant(app, orgA, (tx) => listOrgEvents(tx, {}));
    expect(page.items.some((e) => e.endpointId === epB)).toBe(false);
    // The property is cross-org ISOLATION, not exact membership: other tests in this file seed into both
    // orgs, so "orgB sees only epB" is not stable — "orgB never sees orgA's endpoints" is.
    const bPage = await withTenant(app, orgB, (tx) => listOrgEvents(tx, { limit: 200 }));
    expect(bPage.items.length).toBeGreaterThan(0);
    expect(bPage.items.some((e) => e.endpointId === epB)).toBe(true);
    expect(bPage.items.some((e) => e.endpointId === epA || e.endpointId === epTail)).toBe(false);
  });

  // Pins the two doors to ONE body: passing endpointId must be exactly the endpoint-scoped read, so the
  // consolidated page and the per-endpoint page can never disagree about what an endpoint's events are.
  it("with an endpointId returns exactly what listEvents returns", async () => {
    const [org, scoped] = await Promise.all([
      withTenant(app, orgA, (tx) => listOrgEvents(tx, { endpointId: epTail })),
      withTenant(app, orgA, (tx) => listEvents(tx, { endpointId: epTail })),
    ]);
    expect(org.items.map((e) => e.id)).toEqual(scoped.items.map((e) => e.id));
    expect(org.nextCursor).toEqual(scoped.nextCursor);
  });

  it("hides soft-deleted events (0058: every surfacing reader filters deleted_at)", async () => {
    const doomed = await seedEvent(orgA, epA, { provider: "stripe" });
    const before = await withTenant(app, orgA, (tx) => listOrgEvents(tx, {}));
    expect(before.items.some((e) => e.id === doomed)).toBe(true);
    // MUST run inside withTenant: `events_update` is `using (org_id = current_org_id())` and
    // current_org_id() is NULL outside a tenant tx, so a bare update silently matches ZERO rows (deny by
    // default). The first draft of this test did exactly that and "failed" against correct code.
    await withTenant(
      app,
      orgA,
      (tx) => tx`update events set deleted_at = now() where id = ${doomed}`,
    );
    const after = await withTenant(app, orgA, (tx) => listOrgEvents(tx, {}));
    expect(after.items.some((e) => e.id === doomed)).toBe(false);
  });

  it("applies the provider filter across endpoints", async () => {
    const page = await withTenant(app, orgA, (tx) =>
      listOrgEvents(tx, { provider: ["github"], limit: 200 }),
    );
    expect(page.items.every((e) => e.provider === "github")).toBe(true);
    // github events exist on BOTH endpoints — the filter must not collapse to one of them.
    const endpoints = new Set(page.items.map((e) => e.endpointId));
    expect(endpoints.has(epA)).toBe(true);
    expect(endpoints.has(epTail)).toBe(true);
  });

  // The µs-exact keyset must hold ACROSS endpoints, not just within one: an org-wide page boundary can fall
  // between two events on different endpoints that share a microsecond.
  it("keysets across endpoints without a dup or a skip", async () => {
    const first = await withTenant(app, orgA, (tx) => listOrgEvents(tx, { limit: 4 }));
    expect(first.items.length).toBe(4); // orgA always has >4 events by this point
    expect(first.nextCursor).not.toBeNull();
    const second = await withTenant(app, orgA, (tx) =>
      listOrgEvents(tx, { limit: 4, cursor: first.nextCursor! }),
    );
    const ids = [...first.items, ...second.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no dup
    const all = await withTenant(app, orgA, (tx) => listOrgEvents(tx, { limit: 200 }));
    expect(ids).toEqual(all.items.map((e) => e.id).slice(0, ids.length)); // no skip
  });
});

describe("listEndpointNames (labels for the org-wide events list)", () => {
  it("returns every endpoint in the org, and marks soft-deleted ones", async () => {
    const gone = (await createEndpoint(app, { orgId: orgA, name: "gone-ep" }, hasher)).id;
    await withTenant(
      app,
      orgA,
      (tx) => tx`update endpoints set deleted_at = now() where id = ${gone}`,
    );
    const names = await withTenant(app, orgA, (tx) => listEndpointNames(tx));
    // A live endpoint and a soft-deleted one must BOTH be labelled: ADR-0076 keeps a deleted endpoint's
    // events listable, so the org-wide list has rows for it — and a name map from listEndpoints (which
    // filters deleted_at is null) would leave exactly those rows showing a raw uuid.
    expect(names[epA]).toEqual({ name: "ep-a", deleted: false });
    expect(names[gone]).toEqual({ name: "gone-ep", deleted: true });
  });

  it("is RLS-scoped: another org's endpoints are absent", async () => {
    const names = await withTenant(app, orgA, (tx) => listEndpointNames(tx));
    expect(names[epB]).toBeUndefined();
  });

  // REGRESSION. This map crosses the RSC -> Client boundary, and React refuses to serialize a null-prototype
  // object — it throws at RENDER and takes the page down. The first version returned Object.create(null) for
  // prototype-key safety; every unit test passed (they hand the prop straight to the component and never
  // cross the boundary) and a Playwright spec caught it in a real browser. Safety now lives at the LOOKUP
  // (Object.hasOwn in EventsTable) instead.
  it("is a PLAIN object, so React can serialize it to a Client Component", async () => {
    const names = await withTenant(app, orgA, (tx) => listEndpointNames(tx));
    expect(Object.getPrototypeOf(names)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(names))[epA]).toEqual({ name: "ep-a", deleted: false });
  });
});

// REGRESSION (review of #640, found ON PROD). EventFilters gained an `endpointId` for the org-wide browse,
// which made the per-endpoint reader's `{ endpointId, ...filters }` spread unsafe: `filters` is re-parsed
// from CLIENT input in loadMoreEventsAction, so a caller could set filters.endpointId = B and have endpoint
// B's events appended into endpoint A's list — rows that then 404, since loadEvent scopes the detail read to
// A. RLS still bounds it to the caller's own org, so it is a correctness break, not a tenant one.
//
// The scoping endpointId must be spread LAST so it wins. This asserts the property at the query, where it is
// true or false — not at the call site, where you can only see that an argument was passed.
describe("listEvents: an explicit endpointId beats one in the filters", () => {
  it("returns the EXPLICIT endpoint's events, not the filter's", async () => {
    const page = await withTenant(app, orgA, (tx) =>
      // the shape boundReaders uses: `{ ...filters, endpointId }`
      listEvents(tx, { ...{ endpointId: epTail }, endpointId: epA }),
    );
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((e) => e.endpointId === epA)).toBe(true);
    expect(page.items.some((e) => e.endpointId === epTail)).toBe(false);
  });
});

// THE BROWSE IS BOUNDED — the guard that makes an unbounded org-wide browse survivable.
//
// This page lets a reader ask for "Any time" across every endpoint in the org. Measured on real data, that
// degrades badly the moment a residual filter makes the planner abandon the ordered index: the resulting Sort
// is a BLOCKING operator that consumes the whole input before emitting row 1 — 578ms at 1.8M rows, ~32s
// extrapolated at 100M. The 7d default hides that for most readers; it does not REMOVE it, and a one-click
// escape hatch to all-time would be a self-inflicted DoS without a bound.
//
// `set local` (not ALTER ROLE) is deliberate and was audited: a role-level timeout would apply at SESSION
// start, landing unpredictably as Hyperdrive's long-lived pools recycle, and would break org deletion (one
// statement cascading over every event) and silently drop Stripe tail revenue (tail-flush's multi-day rollup).
// Scoped to the browse transaction, it is structurally unable to touch any of them.
describe("browseEvents bounds itself with a statement_timeout", () => {
  it("applies the timeout inside the browse transaction", async () => {
    await withTenant(app, orgA, async (tx) => {
      await listOrgEvents(tx, { limit: 5 });
      const [row] = await tx<{ statement_timeout: string }[]>`show statement_timeout`;
      expect(row?.statement_timeout).toBe("5s");
    });
  });

  it("is transaction-LOCAL: it never leaks onto the pooled connection", async () => {
    // The whole safety argument rests on this. `set local` reverts at commit, so the next user of this
    // pooled connection — a cron, a lifecycle job, the tail flush — is unaffected. A plain `set` would leak
    // a 5s cap onto whatever ran next on that connection, which is exactly the failure ALTER ROLE would have
    // caused wholesale.
    await withTenant(app, orgA, (tx) => listOrgEvents(tx, { limit: 5 }));
    await withTenant(app, orgA, async (tx) => {
      const [row] = await tx<{ statement_timeout: string }[]>`show statement_timeout`;
      expect(row?.statement_timeout).not.toBe("5s");
    });
  });

  it("also bounds the endpoint-scoped browse (same body, same exposure)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-timeout" }, hasher)).id;
    await withTenant(app, orgA, async (tx) => {
      await listEvents(tx, { endpointId: ep, limit: 5 });
      const [row] = await tx<{ statement_timeout: string }[]>`show statement_timeout`;
      expect(row?.statement_timeout).toBe("5s");
    });
  });
});

describe("a RETIRED provider slug still sitting in the events table", () => {
  // `events.provider` is plain `text` and records what the registry called the provider when the event
  // was captured, so a row written before `customerio` was retired still holds the dead slug. Both read
  // paths parse through `EventSummarySchema`/`EventSchema`, whose `provider` is a STRICT enum — an
  // un-canonicalised value throws, and because the parse happens per row inside the list mapper, one
  // legacy event takes down the ENTIRE events list for that org, not just its own row.
  //
  // Seeded straight into SQL on purpose: every write path rejects the slug now, so the only way to
  // reproduce the row an existing database already contains is to bypass them.

  let epLegacy: string;
  let legacyEventId: string;

  beforeAll(async () => {
    epLegacy = (await createEndpoint(app, { orgId: orgA, name: "ep-legacy-slug" }, hasher)).id;
    legacyEventId = await seedEvent(orgA, epLegacy, { provider: "customerio" });
  }, setupHookTimeoutMs());

  it("stores the dead slug verbatim (the fixture is real, not already normalised)", async () => {
    // Guards the test itself: if the insert silently wrote `customer_io`, everything below would pass
    // while proving nothing about canonicalisation.
    const [row] = await withTenant(
      app,
      orgA,
      (tx) => tx<{ provider: string }[]>`select provider from events where id = ${legacyEventId}`,
    );
    expect(row?.provider).toBe("customerio");
  });

  it("listEvents returns the row under the LIVE slug instead of throwing", async () => {
    const page = await withTenant(app, orgA, (tx) =>
      listEvents(tx, { endpointId: epLegacy, limit: 50 }),
    );
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.provider).toBe("customer_io");
  });

  it("getEvent returns the row under the LIVE slug instead of throwing", async () => {
    const ev = await withTenant(app, orgA, (tx) => getEvent(tx, legacyEventId));
    expect(ev?.provider).toBe("customer_io");
  });

  it("the org-wide browse survives it too — one legacy row must not break the whole list", async () => {
    const page = await withTenant(app, orgA, (tx) => listOrgEvents(tx, { limit: 100 }));
    const found = page.items.find((e) => e.id === legacyEventId);
    expect(found?.provider).toBe("customer_io");
    expect(page.items.length).toBeGreaterThan(1); // the other org-A events still came back
  });
});
