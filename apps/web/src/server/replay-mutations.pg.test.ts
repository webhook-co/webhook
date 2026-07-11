import { randomUUID } from "node:crypto";

import {
  createClient,
  createCredentialHasher,
  createEndpoint,
  createOrg,
  createReplayDestination,
  CREDENTIAL_PEPPER_MIN_BYTES,
  DB_ROLES,
  withTenant,
  type Sql,
} from "@webhook-co/db";
import { newId, type DeliverResult, type DeliveryDispatcherRpc } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setupSchema } from "../../../../packages/db/test/migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "../../../../packages/db/test/pg";
import { boundDeps, replayToDestination, ReplayPausedError } from "./replay-mutations";

// The WEB remote-replay orchestration (the dashboard's counterpart of apps/api's remote-replay handler),
// exercised end to end against a REAL Postgres under the webhook_app role + RLS with a FAKE dispatcher. This
// is the persistence-level parity the api pg suite already has: it proves the S4 cap-pause gate refuses a
// replay BEFORE any billable delivery_attempts row is minted (a gate moved AFTER claimDeliveryAttempt would
// insert a 'pending' row and skip dispatch — the delivery_attempts delta below catches that). The engine
// delivery + SSRF guard are tested separately (engine workerd suite); here the dispatcher is a stub.

const hasher = createCredentialHasher({
  current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5),
});

let pg: EphemeralPostgres;
let app: Sql;
let orgId: string;
let endpointId: string;
let eventId: string;
let destId: string;

function dispatcherReturning(r: DeliverResult): {
  rpc: DeliveryDispatcherRpc;
  deliver: ReturnType<typeof vi.fn>;
} {
  const deliver = vi.fn(async () => r);
  return { rpc: { deliver } as unknown as DeliveryDispatcherRpc, deliver };
}

/** Count this org's delivery_attempts (the billable rows a replay would mint) — read under RLS. */
function countAttempts(): Promise<number> {
  return withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from delivery_attempts where org_id = ${orgId}`,
  ).then(([r]) => r.n);
}

async function setPaused(paused: boolean): Promise<void> {
  await withTenant(
    app,
    orgId,
    (tx) => tx`insert into ingest_paused (org_id, paused) values (${orgId}, ${paused})
               on conflict (org_id) do update set paused = ${paused}`,
  );
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  orgId = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org" })).id;
  endpointId = (await createEndpoint(app, { orgId, name: "ep" }, hasher)).id;
  eventId = newId();
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, verified)
      values
        (${eventId}, ${orgId}, ${endpointId}, ${`org/${orgId}/ep/${endpointId}/${eventId}`}, ${10},
         ${"application/json"}, ${tx.json([["webhook-id", "msg_1"]])}, ${newId()}, ${"content_hash"},
         ${"stripe"}, ${true})`;
  });
  destId = (await createReplayDestination(app, { orgId, url: "https://hooks.example.com/in" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("replayToDestination — web cap-pause gate against real Postgres (S4)", () => {
  it("delivers + mints exactly one delivery_attempts row when the org is NOT paused (positive control)", async () => {
    await setPaused(false);
    const before = await countAttempts();
    const d = dispatcherReturning({ outcome: "delivered", status: 200, error: null, latencyMs: 1 });
    const out = await replayToDestination(
      { orgId, eventId, destinationId: destId },
      boundDeps(app, d.rpc),
    );
    expect(out.status).toBe("delivered");
    expect(d.deliver).toHaveBeenCalledTimes(1);
    expect(await countAttempts()).toBe(before + 1); // a real billable row WAS minted when allowed
  });

  it("REFUSES with ReplayPausedError and mints NO delivery_attempts row when the org IS paused", async () => {
    await setPaused(true);
    try {
      const before = await countAttempts();
      const d = dispatcherReturning({
        outcome: "delivered",
        status: 200,
        error: null,
        latencyMs: 1,
      });
      await expect(
        replayToDestination({ orgId, eventId, destinationId: destId }, boundDeps(app, d.rpc)),
      ).rejects.toBeInstanceOf(ReplayPausedError);
      expect(d.deliver).not.toHaveBeenCalled(); // never dispatched — refused before the claim
      // The load-bearing metering invariant: the refused replay minted NO new billable row. Contrast the
      // positive control above (+1) — so this delta-0 is a real guard, and a gate moved AFTER the claim fails.
      expect(await countAttempts()).toBe(before);
    } finally {
      await setPaused(false);
    }
  });
});
