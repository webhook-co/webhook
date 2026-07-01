import { randomUUID } from "node:crypto";

import { newId } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql, type TenantTx } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { createReplayDestination } from "../src/replay-destinations";
import { createSubscription } from "../src/subscriptions";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The repo's FIRST EXPLAIN-based test. It proves the migration-0036 covering indexes (and the reused
// events_tunnel_idx) actually SERVE the keyset browse reads — i.e. the raw-column ORDER BY is an ordered
// index scan with NO Sort node. This is the guard against silent drift: if a read's ORDER BY / WHERE ever
// stops matching its index, the plan gains a Sort node (or drops the index) and these assertions fail.
//
// Determinism on a small seeded table: `set local enable_seqscan/enable_sort = off` (USERSET GUCs, tx-scoped)
// forces the planner onto an ordered index path IF one exists; if the index can't serve the order, the only
// alternative is a Sort node (which we assert is absent). The queries here MUST mirror reads.ts's ORDER BY +
// WHERE for each browse — the same-µs tie tests in reads/deliveries guard the RESULTS; this guards the PLAN.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });
let pg: EphemeralPostgres;
let app: Sql;
let orgId: string;
let endpointId: string;
let destinationId: string;
let subscriptionId: string;

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** Walk an EXPLAIN (FORMAT JSON) plan tree, collecting every node type + index name used. */
function walk(node: PlanNode, acc: { types: Set<string>; indexes: Set<string> }): void {
  acc.types.add(node["Node Type"]);
  if (node["Index Name"]) acc.indexes.add(node["Index Name"]);
  for (const child of node.Plans ?? []) walk(child, acc);
}

/** Run `explain (format json)` for a query built by `q`, with seqscan+sort disabled, and report the plan. */
async function planOf(
  tx: TenantTx,
  q: (t: TenantTx) => ReturnType<TenantTx>,
): Promise<{ types: Set<string>; indexes: Set<string> }> {
  await tx`set local enable_seqscan = off`;
  await tx`set local enable_sort = off`;
  const rows = await tx<{ "QUERY PLAN": unknown }[]>`explain (format json) ${q(tx)}`;
  const raw = rows[0]!["QUERY PLAN"];
  const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as [{ Plan: PlanNode }];
  const acc = { types: new Set<string>(), indexes: new Set<string>() };
  walk(plan[0].Plan, acc);
  return acc;
}

const usesIndexNoSort = (p: { types: Set<string>; indexes: Set<string> }, index: string): boolean =>
  p.indexes.has(index) && [...p.types].some((t) => t.includes("Index")) && !p.types.has("Sort");

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  orgId = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org" })).id;
  endpointId = (await createEndpoint(app, { orgId, name: "ep" }, hasher)).id;
  destinationId = (await createReplayDestination(app, { orgId, url: "https://p.example.com/in" }))
    .id;
  subscriptionId = (
    await createSubscription(app, { orgId, sourceEndpointId: endpointId, destinationId })
  ).id;

  // Seed enough rows that an ordered index path is a meaningful choice. Bulk insert under one tx.
  await withTenant(app, orgId, async (tx) => {
    const eventIds: string[] = [];
    for (let i = 0; i < 300; i++) {
      const id = newId();
      eventIds.push(id);
      await tx`
        insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
        values (${id}, ${orgId}, ${endpointId}, ${`k/${id}`}, ${1}, ${newId()}, ${"content_hash"})`;
    }
    for (let i = 0; i < 300; i++) {
      await tx`
        insert into delivery_attempts (id, org_id, event_id, destination_id, subscription_id, target, status)
        values (${newId()}, ${orgId}, ${eventIds[i]}, ${destinationId}, ${subscriptionId}, ${"auto"}, ${"delivered"})`;
    }
    for (let i = 0; i < 60; i++) {
      await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
               values (${newId()}, ${orgId}, ${Buffer.from(newId().replace(/-/g, ""), "hex")}, ${`e${i}`})`;
    }
  });
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("keyset browse reads use their covering index (no Sort node)", () => {
  it("listEvents (DESC) + tailEvents (ASC) ride events_tunnel_idx", async () => {
    await withTenant(app, orgId, async (tx) => {
      const desc = await planOf(
        tx,
        (t) =>
          t`select id from events where endpoint_id = ${endpointId} order by received_at desc, id desc limit 51`,
      );
      expect(usesIndexNoSort(desc, "events_tunnel_idx")).toBe(true);
      const asc = await planOf(
        tx,
        (t) =>
          t`select id from events where endpoint_id = ${endpointId} order by received_at asc, id asc limit 51`,
      );
      expect(usesIndexNoSort(asc, "events_tunnel_idx")).toBe(true);
    });
  });

  it("listDeliveries org-wide rides delivery_attempts_org_ordered_idx", async () => {
    await withTenant(app, orgId, async (tx) => {
      const p = await planOf(
        tx,
        (t) => t`select id from delivery_attempts order by created_at desc, id desc limit 51`,
      );
      expect(usesIndexNoSort(p, "delivery_attempts_org_ordered_idx")).toBe(true);
    });
  });

  it("listDeliveries destination-filtered rides delivery_attempts_destination_ordered_idx", async () => {
    await withTenant(app, orgId, async (tx) => {
      const p = await planOf(
        tx,
        (t) =>
          t`select id from delivery_attempts where destination_id = ${destinationId} order by created_at desc, id desc limit 51`,
      );
      expect(usesIndexNoSort(p, "delivery_attempts_destination_ordered_idx")).toBe(true);
    });
  });

  it("listDeliveries subscription-filtered rides the partial delivery_attempts_subscription_ordered_idx", async () => {
    await withTenant(app, orgId, async (tx) => {
      const p = await planOf(
        tx,
        (t) =>
          t`select id from delivery_attempts where subscription_id = ${subscriptionId} order by created_at desc, id desc limit 51`,
      );
      expect(usesIndexNoSort(p, "delivery_attempts_subscription_ordered_idx")).toBe(true);
    });
  });

  it("listEndpoints rides the partial endpoints_org_ordered_idx", async () => {
    await withTenant(app, orgId, async (tx) => {
      const p = await planOf(
        tx,
        (t) =>
          t`select id from endpoints where deleted_at is null order by created_at desc, id desc limit 51`,
      );
      expect(usesIndexNoSort(p, "endpoints_org_ordered_idx")).toBe(true);
    });
  });
});
