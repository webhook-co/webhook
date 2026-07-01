import { randomUUID } from "node:crypto";

import { importAuditKey, newId } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { cancelOpenDeliveries } from "../src/delivery";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import {
  createReplayDestination,
  enableReplayDestination,
  setDestinationOrdered,
  softDeleteReplayDestination,
} from "../src/replay-destinations";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Destination lifecycle (S3 Slice 3 PR3b): delete-cancels-open-deliveries + enable (clear auto-disable) +
// the ordered (strict-FIFO) toggle. Against a REAL Postgres under webhook_app + RLS.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });
let pg: EphemeralPostgres;
let app: Sql;
let orgId: string;
let epId: string;
let auditKey: CryptoKey;

async function seedEvent(): Promise<string> {
  const id = newId();
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, verified)
      values
        (${id}, ${orgId}, ${epId}, ${`k/${id}`}, ${10}, ${"application/json"},
         ${tx.json([["h", "v"]])}, ${newId()}, ${"content_hash"}, ${"stripe"}, ${true})`;
  });
  return id;
}

async function seedDelivery(destinationId: string, status: string): Promise<string> {
  const id = newId();
  const eventId = await seedEvent();
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into delivery_attempts (id, org_id, event_id, destination_id, target, status, next_retry_at)
      values (${id}, ${orgId}, ${eventId}, ${destinationId}, ${"auto"}, ${status}, ${new Date()})`;
  });
  return id;
}

const statusOf = (id: string) =>
  withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ status: string; next_retry_at: Date | null }[]>`
      select status, next_retry_at from delivery_attempts where id = ${id}`,
  ).then((r) => r[0]!);

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  orgId = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org" })).id;
  epId = (await createEndpoint(app, { orgId, name: "ep" }, hasher)).id;
  auditKey = await importAuditKey(Buffer.alloc(32, 0x7a));
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("cancelOpenDeliveries", () => {
  it("cancels only OPEN (queued/pending) deliveries, leaving terminal ones untouched", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://c.example.com/in" }))
      .id;
    const queued = await seedDelivery(dest, "queued");
    const pending = await seedDelivery(dest, "pending");
    const delivered = await seedDelivery(dest, "delivered");

    const n = await withTenant(app, orgId, (tx) => cancelOpenDeliveries(tx, dest));
    expect(n).toBe(2);
    expect((await statusOf(queued)).status).toBe("cancelled");
    expect((await statusOf(pending)).status).toBe("cancelled");
    expect((await statusOf(queued)).next_retry_at).toBeNull(); // cleared — no further attempt owed
    expect((await statusOf(delivered)).status).toBe("delivered"); // terminal, untouched
  });
});

describe("softDeleteReplayDestination — cancels the destination's owed deliveries", () => {
  it("soft-deletes AND cancels open deliveries so they are not stranded (carry-over #1b)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://d.example.com/in" }))
      .id;
    const owed = await seedDelivery(dest, "queued");
    const done = await seedDelivery(dest, "delivered");

    const removed = await softDeleteReplayDestination(app, orgId, dest, {
      auditKey,
      actor: null,
    });
    expect(removed).not.toBeNull();
    expect((await statusOf(owed)).status).toBe("cancelled"); // owed delivery terminally resolved
    expect((await statusOf(done)).status).toBe("delivered"); // history preserved
  });
});

describe("enableReplayDestination", () => {
  it("clears disabled_at + resets consecutive_failures and appends an audit row", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://e.example.com/in" }))
      .id;
    // Simulate an auto-disabled destination.
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`update replay_destinations set disabled_at = now(), consecutive_failures = 9 where id = ${dest}`,
    );

    const rec = await enableReplayDestination(app, orgId, dest, { auditKey, actor: null });
    expect(rec).not.toBeNull();
    expect(rec!.disabledAt).toBeNull();
    const row = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ consecutive_failures: number }[]>`
        select consecutive_failures from replay_destinations where id = ${dest}`,
    ).then((r) => r[0]!);
    expect(row.consecutive_failures).toBe(0);

    const chain = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    expect(chain.some((e) => e.action === "replay_destination.enabled" && e.target === dest)).toBe(
      true,
    );
  });

  it("returns null for an unknown / soft-deleted destination (NOT_FOUND, no leak)", async () => {
    expect(await enableReplayDestination(app, orgId, newId())).toBeNull();
    const gone = (await createReplayDestination(app, { orgId, url: "https://g.example.com/in" }))
      .id;
    await softDeleteReplayDestination(app, orgId, gone);
    expect(await enableReplayDestination(app, orgId, gone)).toBeNull();
  });
});

describe("setDestinationOrdered", () => {
  it("toggles the strict-FIFO flag and audits, and is NOT_FOUND for a missing destination", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://o.example.com/in" }))
      .id;
    const on = await setDestinationOrdered(app, orgId, dest, true, { auditKey, actor: null });
    expect(on!.ordered).toBe(true);
    const off = await setDestinationOrdered(app, orgId, dest, false, { auditKey, actor: null });
    expect(off!.ordered).toBe(false);
    expect(await setDestinationOrdered(app, orgId, newId(), true)).toBeNull();
  });
});
