import { randomUUID } from "node:crypto";

import { newId } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import {
  isDestinationOrdered,
  listDueDeliveries,
  markDeliveryDelivered,
  markDeliveryTerminalFailure,
  nextDueAt,
  scheduleDeliveryRetry,
} from "../src/delivery";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { createReplayDestination } from "../src/replay-destinations";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The delivery-attempt lifecycle the per-destination delivery DO drives (S3 Slice 3 PR1b): listing DUE
// deliveries (queued / retry-arrived) with their delivery context, and the terminal/retry transitions.
// Exercised against a REAL Postgres under the webhook_app role + RLS (the engine's HYPERDRIVE_TENANT role).

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let orgId: string;
let endpointId: string;

// Seed an event under a tenant. Defaults to the module's org/endpoint; pass explicit ones (e.g. for org B)
// so the cross-org isolation test reuses this single column-list instead of duplicating the insert inline.
async function seedEvent(forOrg = orgId, forEndpoint = endpointId): Promise<string> {
  const id = newId();
  await withTenant(app, forOrg, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, verified)
      values
        (${id}, ${forOrg}, ${forEndpoint}, ${`org/${forOrg}/ep/${forEndpoint}/${id}`}, ${10},
         ${"application/json"}, ${tx.json([["webhook-id", "in_1"]])}, ${newId()}, ${"content_hash"},
         ${"stripe"}, ${true})`;
  });
  return id;
}

/** Seed a delivery_attempts row directly (the producer/PR2 will do this; here we drive the lifecycle).
 *  `createdAt` is explicit where FIFO order matters (the strict-ordered barrier keys on (created_at, id)). */
async function seedDelivery(
  destinationId: string,
  over: {
    status?: string;
    attempt?: number;
    nextRetryAt?: Date | null;
    eventId?: string;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const id = newId();
  const eventId = over.eventId ?? (await seedEvent());
  // An EXPLICIT `nextRetryAt: null` must insert a genuine SQL NULL (a never-scheduled queued row) — `??`
  // would coerce it back to epoch and mask the migration-mandated "null next_retry_at counts as due" path.
  const nextRetryAt = "nextRetryAt" in over ? over.nextRetryAt : new Date(0);
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into delivery_attempts
        (id, org_id, event_id, destination_id, target, status, attempt, next_retry_at, created_at)
      values
        (${id}, ${orgId}, ${eventId}, ${destinationId}, ${"auto"}, ${over.status ?? "queued"},
         ${over.attempt ?? 1}, ${nextRetryAt}, ${over.createdAt ?? new Date()})`;
  });
  return id;
}

const failures = (destinationId: string) =>
  withTenant(
    app,
    orgId,
    (tx) => tx<{ n: number; disabled: Date | null }[]>`
      select consecutive_failures as n, disabled_at as disabled
      from replay_destinations where id = ${destinationId}`,
  ).then((r) => r[0]!);

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  orgId = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org" })).id;
  endpointId = (await createEndpoint(app, { orgId, name: "ep" }, hasher)).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("listDueDeliveries", () => {
  it("returns a due (queued) delivery with the joined event + destination context, FIFO", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://d1.example.com/in" }))
      .id;
    const id = await seedDelivery(dest);
    const due = await withTenant(app, orgId, (tx) => listDueDeliveries(tx, dest));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ id, attempt: 1, url: "https://d1.example.com/in" });
    expect(due[0]!.endpointId).toBe(endpointId);
    expect(due[0]!.headers).toEqual([["webhook-id", "in_1"]]);
  });

  it("excludes a future retry, a terminal row, and a disabled/deleted destination", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://d2.example.com/in" }))
      .id;
    await seedDelivery(dest, { status: "pending", nextRetryAt: new Date(Date.now() + 3_600_000) }); // future
    await seedDelivery(dest, { status: "delivered" }); // terminal
    const dueId = await seedDelivery(dest, { status: "pending", nextRetryAt: new Date(0) }); // due now
    const due = await withTenant(app, orgId, (tx) => listDueDeliveries(tx, dest));
    expect(due.map((d) => d.id)).toEqual([dueId]);

    // disabling the destination removes it as a delivery target
    await withTenant(
      app,
      orgId,
      (tx) => tx`update replay_destinations set disabled_at = now() where id = ${dest}`,
    );
    expect(await withTenant(app, orgId, (tx) => listDueDeliveries(tx, dest))).toHaveLength(0);
  });

  it("strict-ordered: a not-yet-due head withholds newer due deliveries (cross-cycle head-of-line)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://do.example.com/in" }))
      .id;
    await withTenant(
      app,
      orgId,
      (tx) => tx`update replay_destinations set ordered = true where id = ${dest}`,
    );
    const t0 = new Date(Date.now() - 10_000);
    const t1 = new Date(Date.now() - 5_000);
    // head (older) is mid-retry, not yet due; a newer delivery is queued and due now.
    const head = await seedDelivery(dest, {
      status: "pending",
      nextRetryAt: new Date(Date.now() + 3_600_000),
      createdAt: t0,
    });
    const newer = await seedDelivery(dest, { status: "queued", createdAt: t1 });
    // ordered: the newer delivery is WITHHELD behind the retrying head — nothing is due this cycle.
    expect(await withTenant(app, orgId, (tx) => listDueDeliveries(tx, dest))).toHaveLength(0);

    // a best-effort destination with the identical shape WOULD surface the newer delivery (independent).
    const best = (await createReplayDestination(app, { orgId, url: "https://db.example.com/in" }))
      .id;
    await seedDelivery(best, {
      status: "pending",
      nextRetryAt: new Date(Date.now() + 3_600_000),
      createdAt: t0,
    });
    const bestNewer = await seedDelivery(best, { status: "queued", createdAt: t1 });
    expect(
      (await withTenant(app, orgId, (tx) => listDueDeliveries(tx, best))).map((d) => d.id),
    ).toEqual([bestNewer]);

    // once the head itself becomes due, the barrier clears and ordered surfaces both, head first (FIFO).
    await withTenant(
      app,
      orgId,
      (tx) => tx`update delivery_attempts set next_retry_at = now() where id = ${head}`,
    );
    expect(
      (await withTenant(app, orgId, (tx) => listDueDeliveries(tx, dest))).map((d) => d.id),
    ).toEqual([head, newer]);
  });
});

describe("transitions", () => {
  it("markDeliveryDelivered → delivered (+ resets consecutive_failures)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://d3.example.com/in" }))
      .id;
    await withTenant(
      app,
      orgId,
      (tx) => tx`update replay_destinations set consecutive_failures = 3 where id = ${dest}`,
    );
    const id = await seedDelivery(dest);
    await withTenant(app, orgId, (tx) =>
      markDeliveryDelivered(tx, { id, destinationId: dest, attempt: 1, statusCode: 200 }),
    );
    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ status: string }[]>`select status from delivery_attempts where id = ${id}`,
    );
    expect(row!.status).toBe("delivered");
    expect((await failures(dest)).n).toBe(0);
  });

  it("scheduleDeliveryRetry → pending + next_retry_at + advanced attempt (no tally change)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://d4.example.com/in" }))
      .id;
    const id = await seedDelivery(dest, { attempt: 1 });
    const at = new Date(Date.now() + 5_000);
    await withTenant(app, orgId, (tx) =>
      scheduleDeliveryRetry(tx, {
        id,
        nextAttempt: 2,
        nextRetryAt: at,
        statusCode: 500,
        error: "http 500",
      }),
    );
    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ status: string; attempt: number; next_retry_at: Date }[]>`
      select status, attempt, next_retry_at from delivery_attempts where id = ${id}`,
    );
    expect(row).toMatchObject({ status: "pending", attempt: 2 });
    expect(row!.next_retry_at.getTime()).toBeCloseTo(at.getTime(), -2);
    expect((await failures(dest)).n).toBe(0); // a retry is not a terminal failure
  });

  it("markDeliveryTerminalFailure(dead/blocked) → both terminal; only DEAD bumps the failure tally", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://d5.example.com/in" }))
      .id;
    const dead = await seedDelivery(dest, { attempt: 8 });
    await withTenant(app, orgId, (tx) =>
      markDeliveryTerminalFailure(tx, {
        id: dead,
        destinationId: dest,
        status: "dead",
        attempt: 8,
        statusCode: 503,
        error: "exhausted",
      }),
    );
    const blocked = await seedDelivery(dest, { attempt: 1 });
    await withTenant(app, orgId, (tx) =>
      markDeliveryTerminalFailure(tx, {
        id: blocked,
        destinationId: dest,
        status: "blocked",
        attempt: 1,
        statusCode: null,
        error: "ssrf",
      }),
    );
    const rows = await withTenant(
      app,
      orgId,
      (tx) => tx<{ id: string; status: string }[]>`
      select id, status from delivery_attempts where id in (${dead}, ${blocked})`,
    );
    expect(new Map(rows.map((r) => [r.id, r.status]))).toEqual(
      new Map([
        [dead, "dead"],
        [blocked, "blocked"],
      ]),
    );
    // Only `dead` (retry-exhausted) counts toward the auto-disable tally; `blocked` (an instant SSRF refusal)
    // finalizes but never bumps it — else a transient block-storm would auto-disable in minutes (PR3c).
    expect((await failures(dest)).n).toBe(1);
  });

  it("the status guard makes a re-finalize a no-op (a concurrent re-drive can't double-count)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://dg.example.com/in" }))
      .id;
    const id = await seedDelivery(dest);
    // first finalize wins
    await withTenant(app, orgId, (tx) =>
      markDeliveryDelivered(tx, { id, destinationId: dest, attempt: 1, statusCode: 200 }),
    );
    // a stale re-drive bumps the failure tally — but the row is already terminal, so the guard skips it
    await withTenant(app, orgId, (tx) =>
      markDeliveryTerminalFailure(tx, {
        id,
        destinationId: dest,
        status: "dead",
        attempt: 1,
        statusCode: 503,
        error: "stale",
      }),
    );
    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ status: string }[]>`select status from delivery_attempts where id = ${id}`,
    );
    expect(row!.status).toBe("delivered"); // unchanged — the terminal row was not re-finalized
    expect((await failures(dest)).n).toBe(0); // tally not bumped by the no-op
  });

  it("the status guard protects an ALREADY-terminal row from a stale success or retry (no resurrection / no tally reset)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://dt.example.com/in" }))
      .id;
    await withTenant(
      app,
      orgId,
      (tx) => tx`update replay_destinations set consecutive_failures = 5 where id = ${dest}`,
    );
    const dead = await seedDelivery(dest, { status: "dead", attempt: 8 });
    // a stale success must NOT flip dead→delivered NOR reset the auto-disable tally to 0
    await withTenant(app, orgId, (tx) =>
      markDeliveryDelivered(tx, { id: dead, destinationId: dest, attempt: 8, statusCode: 200 }),
    );
    const blocked = await seedDelivery(dest, { status: "blocked", attempt: 1 });
    // a stale retry must NOT re-open a terminal (blocked) row back to pending
    await withTenant(app, orgId, (tx) =>
      scheduleDeliveryRetry(tx, {
        id: blocked,
        nextAttempt: 2,
        nextRetryAt: new Date(),
        statusCode: 500,
        error: "stale",
      }),
    );
    const rows = await withTenant(
      app,
      orgId,
      (tx) => tx<{ id: string; status: string }[]>`
        select id, status from delivery_attempts where id in (${dead}, ${blocked})`,
    );
    expect(new Map(rows.map((r) => [r.id, r.status]))).toEqual(
      new Map([
        [dead, "dead"],
        [blocked, "blocked"],
      ]),
    );
    expect((await failures(dest)).n).toBe(5); // tally untouched — the stale success did not reset it
  });
});

describe("isDestinationOrdered", () => {
  it("defaults to false, and reflects an explicitly-ordered destination", async () => {
    const best = (await createReplayDestination(app, { orgId, url: "https://d7.example.com/in" }))
      .id;
    expect(await withTenant(app, orgId, (tx) => isDestinationOrdered(tx, best))).toBe(false);

    const strict = (await createReplayDestination(app, { orgId, url: "https://d8.example.com/in" }))
      .id;
    await withTenant(
      app,
      orgId,
      (tx) => tx`update replay_destinations set ordered = true where id = ${strict}`,
    );
    expect(await withTenant(app, orgId, (tx) => isDestinationOrdered(tx, strict))).toBe(true);
  });
});

describe("nextDueAt", () => {
  it("best-effort: returns the soonest open next_retry_at (null counts as now), or null when none open", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://d6.example.com/in" }))
      .id;
    expect(await withTenant(app, orgId, (tx) => nextDueAt(tx, dest))).toBeNull(); // nothing open
    const soon = new Date(Date.now() + 1_000);
    await seedDelivery(dest, { status: "pending", nextRetryAt: new Date(Date.now() + 9_999_999) });
    await seedDelivery(dest, { status: "pending", nextRetryAt: soon });
    const due = await withTenant(app, orgId, (tx) => nextDueAt(tx, dest));
    expect(due!.getTime()).toBeCloseTo(soon.getTime(), -2);
  });

  it("yields null for a disabled/deleted destination with open rows (the DO idles, not busy-loops)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://d9.example.com/in" }))
      .id;
    await seedDelivery(dest, { status: "queued" }); // open + due (null next_retry_at counts as now)
    expect(await withTenant(app, orgId, (tx) => nextDueAt(tx, dest))).not.toBeNull();
    await withTenant(
      app,
      orgId,
      (tx) => tx`update replay_destinations set disabled_at = now() where id = ${dest}`,
    );
    // a disabled destination contributes no actionable wake-up — without this the alarm would spin at now()
    expect(await withTenant(app, orgId, (tx) => nextDueAt(tx, dest))).toBeNull();
  });

  it("strict-ordered: re-arms for the HEAD's due time, not the soonest (a newer delivery can't pull it earlier)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://d10.example.com/in" }))
      .id;
    await withTenant(
      app,
      orgId,
      (tx) => tx`update replay_destinations set ordered = true where id = ${dest}`,
    );
    const headDue = new Date(Date.now() + 60_000);
    // head (oldest) retries in 60s; a newer delivery is queued and would be "due now" under min() semantics.
    await seedDelivery(dest, {
      status: "pending",
      nextRetryAt: headDue,
      createdAt: new Date(Date.now() - 10_000),
    });
    await seedDelivery(dest, { status: "queued", createdAt: new Date(Date.now() - 5_000) });
    const due = await withTenant(app, orgId, (tx) => nextDueAt(tx, dest));
    expect(due!.getTime()).toBeCloseTo(headDue.getTime(), -2); // the head's 60s-out time, not now()
  });
});

describe("due predicate — consumer contracts (migration 0027)", () => {
  it("a genuinely-NULL next_retry_at (a never-scheduled queued row) counts as due now", async () => {
    // The migration mandates: the due-query MUST treat a null next_retry_at as due. seedDelivery normally
    // defaults to epoch, so this pins the actual `next_retry_at is null` / coalesce(...,now()) clauses.
    const dest = (await createReplayDestination(app, { orgId, url: "https://dn.example.com/in" }))
      .id;
    const id = await seedDelivery(dest, { status: "queued", nextRetryAt: null });
    expect(
      (await withTenant(app, orgId, (tx) => listDueDeliveries(tx, dest))).map((d) => d.id),
    ).toEqual([id]);
    const due = await withTenant(app, orgId, (tx) => nextDueAt(tx, dest));
    expect(due!.getTime()).toBeCloseTo(Date.now(), -3); // ~now
  });

  it("a SOFT-DELETED destination (deleted_at, distinct from disabled_at) drops from the due-list + next-due", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://dd.example.com/in" }))
      .id;
    await seedDelivery(dest, { status: "queued" });
    expect(await withTenant(app, orgId, (tx) => listDueDeliveries(tx, dest))).toHaveLength(1);
    await withTenant(
      app,
      orgId,
      (tx) => tx`update replay_destinations set deleted_at = now() where id = ${dest}`,
    );
    expect(await withTenant(app, orgId, (tx) => listDueDeliveries(tx, dest))).toHaveLength(0);
    expect(await withTenant(app, orgId, (tx) => nextDueAt(tx, dest))).toBeNull();
  });

  it("tenant isolation: another org's due delivery never surfaces in the due-list or next-due (RLS + join guards)", async () => {
    // org A's own destination + due delivery (control).
    const destA = (await createReplayDestination(app, { orgId, url: "https://ta.example.com/in" }))
      .id;
    const idA = await seedDelivery(destA, { status: "queued" });

    // a SECOND org with its own endpoint, destination, event, and a due delivery — seeded under org B's RLS.
    const orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "OrgB" })).id;
    const endpointB = (await createEndpoint(app, { orgId: orgB, name: "epB" }, hasher)).id;
    const destB = (
      await createReplayDestination(app, { orgId: orgB, url: "https://tb.example.com/in" })
    ).id;
    const eventB = await seedEvent(orgB, endpointB); // reuse the helper — no duplicated events column-list
    const deliveryB = newId();
    await withTenant(app, orgB, async (tx) => {
      await tx`
        insert into delivery_attempts
          (id, org_id, event_id, destination_id, target, status, attempt, next_retry_at, created_at)
        values
          (${deliveryB}, ${orgB}, ${eventB}, ${destB}, ${"auto"}, ${"queued"}, ${1}, ${new Date(0)}, ${new Date()})`;
    });

    // org A querying org B's destination id sees nothing (RLS gates delivery_attempts + the event/dest joins).
    expect(await withTenant(app, orgId, (tx) => listDueDeliveries(tx, destB))).toHaveLength(0);
    expect(await withTenant(app, orgId, (tx) => nextDueAt(tx, destB))).toBeNull();
    // and each org sees only its OWN delivery.
    expect(
      (await withTenant(app, orgId, (tx) => listDueDeliveries(tx, destA))).map((d) => d.id),
    ).toEqual([idA]);
    expect(
      (await withTenant(app, orgB, (tx) => listDueDeliveries(tx, destB))).map((d) => d.id),
    ).toEqual([deliveryB]);
  });
});
