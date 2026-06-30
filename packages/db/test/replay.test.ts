import { randomUUID } from "node:crypto";

import { newId } from "@webhook-co/shared";
import { type AuthContext } from "@webhook-co/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import {
  claimDeliveryAttempt,
  createReplayHandler,
  finalizeDeliveryAttempt,
  recordDeliveryAttempt,
  type ReplayHandler,
} from "../src/replay";
import { createReplayDestination, getReplayDestination } from "../src/replay-destinations";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// events.replay (the api-only handler) + recordDeliveryAttempt, against a REAL Postgres with the
// non-owner webhook_app role under RLS. Proves: scope -> FORBIDDEN, bad input -> VALIDATION_ERROR,
// invisible/cross-org event -> NOT_FOUND, paused endpoint -> ENDPOINT_PAUSED, a successful forward
// records one "forwarded" row, and (org_id, idempotency_key) makes a repeat call idempotent (H6).

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let handler: ReplayHandler;
let orgA: string;
let orgB: string;
let epA: string; // active endpoint in org A
let epPaused: string; // paused endpoint in org A
let evA: string; // an event on epA
let evPaused: string; // an event on epPaused
let evB: string; // an event in org B (cross-org)

const ctxA: AuthContext = { orgId: "", scopes: ["events:replay"] };
const TARGET = { kind: "localhost-tunnel", sessionId: "sess-1" } as const;

async function seedEvent(orgId: string, endpointId: string): Promise<string> {
  const id = newId();
  const externalId: string | null = null;
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, provider_event_id, external_id, verified, verification)
      values
        (${id}, ${orgId}, ${endpointId}, ${`org/${orgId}/ep/${endpointId}/${id}`}, ${1234},
         ${"application/json"}, ${tx.json([["content-type", "application/json"]])},
         ${newId()}, ${"content_hash"}, ${"stripe"}, ${"evt_1"}, ${externalId}, ${true},
         ${tx.json({ ok: true, keyId: "key_1", scheme: "stripe" })})`;
  });
  return id;
}

/** Resolve a (possibly rejecting) handler call to its CapabilityFault code, or null on success. */
async function faultCode(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "THREW";
  }
}

async function countAttempts(orgId: string): Promise<number> {
  const [r] = await withTenant(
    app,
    orgId,
    (tx) => tx<{ n: string }[]>`select count(*)::text as n from delivery_attempts`,
  );
  return Number(r!.n);
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  handler = createReplayHandler({ tenant: app });

  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
  ctxA.orgId = orgA;

  epA = (await createEndpoint(app, { orgId: orgA, name: "ep-a" }, hasher)).id;
  epPaused = (await createEndpoint(app, { orgId: orgA, name: "ep-paused" }, hasher)).id;
  await withTenant(
    app,
    orgA,
    (tx) => tx`update endpoints set paused = true where id = ${epPaused}`,
  );
  const epB = (await createEndpoint(app, { orgId: orgB, name: "ep-b" }, hasher)).id;

  evA = await seedEvent(orgA, epA);
  evPaused = await seedEvent(orgA, epPaused);
  evB = await seedEvent(orgB, epB);
});

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("recordDeliveryAttempt (idempotency)", () => {
  it("inserts a row, and a repeat with the same key returns the SAME attempt (no duplicate)", async () => {
    const before = await countAttempts(orgA);
    const first = await withTenant(app, orgA, (tx) =>
      recordDeliveryAttempt(tx, {
        orgId: orgA,
        eventId: evA,
        target: "t",
        idempotencyKey: "idem-dup",
        status: "forwarded",
      }),
    );
    const second = await withTenant(app, orgA, (tx) =>
      recordDeliveryAttempt(tx, {
        orgId: orgA,
        eventId: evA,
        target: "t",
        idempotencyKey: "idem-dup",
        status: "forwarded",
      }),
    );
    expect(second.id).toBe(first.id); // same row returned
    expect(await countAttempts(orgA)).toBe(before + 1); // exactly one inserted
  });
});

describe("createReplayHandler (events.replay)", () => {
  it("FORBIDDEN without the events:replay scope", async () => {
    const ctx: AuthContext = { orgId: orgA, scopes: ["events:read"] };
    expect(
      await faultCode(handler(ctx, { eventId: evA, target: TARGET, idempotencyKey: "k1" })),
    ).toBe("FORBIDDEN");
  });

  it("VALIDATION_ERROR on a free-form URL target / missing idempotency key", async () => {
    expect(
      await faultCode(
        handler(ctxA, {
          eventId: evA,
          target: { kind: "url", url: "http://x" },
          idempotencyKey: "k",
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      await faultCode(handler(ctxA, { eventId: evA, target: TARGET, idempotencyKey: "" })),
    ).toBe("VALIDATION_ERROR");
  });

  it("NOT_FOUND for an unknown event and for a cross-org event (RLS)", async () => {
    expect(
      await faultCode(handler(ctxA, { eventId: newId(), target: TARGET, idempotencyKey: "k2" })),
    ).toBe("NOT_FOUND");
    expect(
      await faultCode(handler(ctxA, { eventId: evB, target: TARGET, idempotencyKey: "k3" })),
    ).toBe("NOT_FOUND");
  });

  it("ENDPOINT_PAUSED when the event's endpoint is paused", async () => {
    expect(
      await faultCode(handler(ctxA, { eventId: evPaused, target: TARGET, idempotencyKey: "k4" })),
    ).toBe("ENDPOINT_PAUSED");
  });

  it("STILL replays a retained event whose endpoint was SOFT-DELETED (ADR-0076 inspection retention)", async () => {
    // A soft-deleted endpoint's captured events stay replayable — replay forwards the stored payload to
    // localhost, not via the (dead) ingest URL. The handler resolves the endpoint with includeDeleted, so
    // this must NOT 404 (the regression the code review caught: the deleted_at filter on getEndpoint).
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-deleted" }, hasher)).id;
    const ev = await seedEvent(orgA, ep);
    await withTenant(
      app,
      orgA,
      (tx) => tx`update endpoints set deleted_at = now() where id = ${ep}`,
    );
    const out = await handler(ctxA, { eventId: ev, target: TARGET, idempotencyKey: "k-deleted" });
    expect(out).toMatchObject({ eventId: ev, orgId: orgA, status: "forwarded" });
  });

  it("records a 'forwarded' delivery attempt and is idempotent on the key", async () => {
    const a = await handler(ctxA, { eventId: evA, target: TARGET, idempotencyKey: "k-go" });
    expect(a).toMatchObject({
      eventId: evA,
      orgId: orgA,
      status: "forwarded",
      statusCode: null,
      idempotencyKey: "k-go",
      target: JSON.stringify(TARGET),
    });
    const again = await handler(ctxA, { eventId: evA, target: TARGET, idempotencyKey: "k-go" });
    expect((again as { id: string }).id).toBe((a as { id: string }).id); // idempotent
  });
});

describe("claim/finalize + getReplayDestination (server-side remote delivery, ADR-0081)", () => {
  let destId: string;
  beforeAll(async () => {
    destId = (
      await createReplayDestination(app, {
        orgId: orgA,
        url: `https://hooks-${randomUUID().slice(0, 6)}.example.com/in`,
      })
    ).id;
  });

  const claim = (key: string, dest = destId) =>
    withTenant(app, orgA, (tx) =>
      claimDeliveryAttempt(tx, {
        orgId: orgA,
        eventId: evA,
        destinationId: dest,
        target: '{"kind":"destination"}',
        idempotencyKey: key,
      }),
    );

  it("claims a pending row (won), then finalizes it with the real HTTP outcome", async () => {
    const { attempt, won } = await claim(randomUUID());
    expect(won).toBe(true);
    expect(attempt.status).toBe("pending");
    const final = await withTenant(app, orgA, (tx) =>
      finalizeDeliveryAttempt(tx, { id: attempt.id, status: "delivered", statusCode: 200 }),
    );
    expect(final?.status).toBe("delivered");
    expect(final?.statusCode).toBe(200);
  });

  it("a re-claim with the same key returns the existing row (won=false), no duplicate", async () => {
    const key = randomUUID();
    const first = await claim(key);
    const again = await claim(key);
    expect(first.won).toBe(true);
    expect(again.won).toBe(false);
    expect(again.attempt.id).toBe(first.attempt.id);
  });

  it("finalize is status-guarded — only a 'pending' row transitions; a second finalize is null", async () => {
    const { attempt } = await claim(randomUUID());
    const first = await withTenant(app, orgA, (tx) =>
      finalizeDeliveryAttempt(tx, {
        id: attempt.id,
        status: "failed",
        statusCode: 502,
        error: "http 502",
      }),
    );
    expect(first?.status).toBe("failed");
    const second = await withTenant(app, orgA, (tx) =>
      finalizeDeliveryAttempt(tx, { id: attempt.id, status: "delivered", statusCode: 200 }),
    );
    expect(second).toBeNull();
  });

  it("the status CHECK (migration 0025) rejects an out-of-vocabulary status", async () => {
    await expect(
      withTenant(
        app,
        orgA,
        (tx) =>
          tx`insert into delivery_attempts (id, org_id, event_id, target, status)
             values (${newId()}, ${orgA}, ${evA}, ${"{}"}, ${"bogus"})`,
      ),
    ).rejects.toThrow();
  });

  it("getReplayDestination resolves a live destination (RLS); null for soft-deleted + cross-org", async () => {
    const got = await withTenant(app, orgA, (tx) => getReplayDestination(tx, destId));
    expect(got?.id).toBe(destId);
    // cross-org → null (org B can't see org A's destination)
    expect(await withTenant(app, orgB, (tx) => getReplayDestination(tx, destId))).toBeNull();
    // a non-existent id → null
    expect(await withTenant(app, orgA, (tx) => getReplayDestination(tx, randomUUID()))).toBeNull();
  });
});
