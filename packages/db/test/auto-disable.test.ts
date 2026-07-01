import { randomUUID } from "node:crypto";

import { importAuditKey, newId } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import {
  autoDisableDestination,
  AUTO_DISABLE_THRESHOLD,
  insertNotificationIntent,
  markDeliveryTerminalFailure,
} from "../src/delivery";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { createReplayDestination } from "../src/replay-destinations";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Auto-disable (S3 Slice 3 PR3c-1): a run of dead-lettered deliveries trips the destination's disable flag,
// appends a `replay_destination.disabled` audit row, and enqueues a `destination_disabled` notification
// intent. markDeliveryTerminalFailure (finalize + DEAD-only tally bump) is DECOUPLED from autoDisableDestination
// (the guarded disable + audit + intent) — the DO runs them in SEPARATE txs so an audit/notify failure can't
// roll back the dead-letter. Against a REAL Postgres + RLS.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });
let pg: EphemeralPostgres;
let app: Sql;
let orgId: string;
let epId: string;
let auditKey: CryptoKey;

/** Seed an event + a delivery_attempts row already in a still-open state so markTerminal transitions it. */
async function seedOpenDelivery(destinationId: string): Promise<string> {
  const eventId = newId();
  const id = newId();
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, verified)
      values
        (${eventId}, ${orgId}, ${epId}, ${`k/${eventId}`}, ${10}, ${"application/json"},
         ${tx.json([["h", "v"]])}, ${newId()}, ${"content_hash"}, ${"stripe"}, ${true})`;
    await tx`
      insert into delivery_attempts (id, org_id, event_id, destination_id, target, status)
      values (${id}, ${orgId}, ${eventId}, ${destinationId}, ${"auto"}, ${"pending"})`;
  });
  return id;
}

const destState = (destinationId: string) =>
  withTenant(
    app,
    orgId,
    (tx) => tx<{ consecutive_failures: number; disabled_at: Date | null }[]>`
      select consecutive_failures, disabled_at from replay_destinations where id = ${destinationId}`,
  ).then((r) => r[0]!);

const intents = (destinationId: string) =>
  withTenant(
    app,
    orgId,
    (tx) => tx<{ id: string; kind: string; status: string }[]>`
      select id, kind, status from notification_intents where destination_id = ${destinationId}`,
  );

// A SMALL threshold keeps these tests fast + decoupled from the prod constant (whose exact value is asserted
// separately below); the crossing logic is identical at any threshold.
const TEST_THRESHOLD = 3;

/** One dead-lettered delivery against a destination: finalize (own tx) THEN the best-effort disable if the
 *  tally crossed (own tx) — mirroring the DO's two-step. Returns whether THIS failure tripped the disable. */
async function failOnce(destinationId: string): Promise<boolean> {
  const deliveryId = await seedOpenDelivery(destinationId);
  const { consecutiveFailures } = await withTenant(app, orgId, (tx) =>
    markDeliveryTerminalFailure(tx, {
      id: deliveryId,
      destinationId,
      status: "dead",
      attempt: 8,
      statusCode: 500,
      error: "boom",
    }),
  );
  if (consecutiveFailures === null || consecutiveFailures < TEST_THRESHOLD) return false;
  const { disabled } = await withTenant(app, orgId, (tx) =>
    autoDisableDestination(tx, {
      orgId,
      destinationId,
      threshold: TEST_THRESHOLD,
      auditKey,
      actor: null,
    }),
  );
  return disabled;
}

/** Drive `count` dead-letters and return how many of them tripped the disable (should be exactly 0 or 1). */
async function failNTimes(destinationId: string, count: number): Promise<number> {
  let disabledCount = 0;
  for (let i = 0; i < count; i++) if (await failOnce(destinationId)) disabledCount++;
  return disabledCount;
}

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

describe("insertNotificationIntent", () => {
  it("inserts a pending intent for a destination", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://n.example.com/in" }))
      .id;
    const id = await withTenant(app, orgId, (tx) =>
      insertNotificationIntent(tx, { orgId, kind: "destination_disabled", destinationId: dest }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await intents(dest);
    expect(rows).toEqual([{ id, kind: "destination_disabled", status: "pending" }]);
  });
});

describe("markDeliveryTerminalFailure — auto-disable", () => {
  it("exports a sane prod threshold (a positive integer)", () => {
    expect(Number.isInteger(AUTO_DISABLE_THRESHOLD)).toBe(true);
    expect(AUTO_DISABLE_THRESHOLD).toBeGreaterThan(0);
  });

  it("bumps the tally but does NOT disable below the threshold", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://b.example.com/in" }))
      .id;
    const disabled = await failNTimes(dest, TEST_THRESHOLD - 1);
    expect(disabled).toBe(0);
    const s = await destState(dest);
    expect(s.consecutive_failures).toBe(TEST_THRESHOLD - 1);
    expect(s.disabled_at).toBeNull();
    expect(await intents(dest)).toHaveLength(0);
  });

  it("disables + audits + enqueues ONE intent exactly when the tally crosses the threshold", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://x.example.com/in" }))
      .id;
    // Cross the threshold, then keep failing — the disable must fire exactly ONCE.
    const disabledCount = await failNTimes(dest, TEST_THRESHOLD + 2);
    expect(disabledCount).toBe(1);

    const s = await destState(dest);
    expect(s.disabled_at).not.toBeNull();
    expect(s.consecutive_failures).toBeGreaterThanOrEqual(TEST_THRESHOLD);

    // exactly one audit row + one intent, not one per subsequent failure.
    const chain = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    const disables = chain.filter(
      (e) => e.action === "replay_destination.disabled" && e.target === dest,
    );
    expect(disables).toHaveLength(1);
    const pend = await intents(dest);
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ kind: "destination_disabled", status: "pending" });
  });

  it("markDeliveryTerminalFailure only finalizes + bumps (the disable is a SEPARATE step, never coupled)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://l.example.com/in" }))
      .id;
    for (let i = 0; i < TEST_THRESHOLD + 1; i++) {
      const deliveryId = await seedOpenDelivery(dest);
      const { consecutiveFailures } = await withTenant(app, orgId, (tx) =>
        markDeliveryTerminalFailure(tx, {
          id: deliveryId,
          destinationId: dest,
          status: "dead",
          attempt: 8,
          statusCode: 500,
          error: "boom",
        }),
      );
      expect(consecutiveFailures).toBe(i + 1);
    }
    // markTerminal alone NEVER disables (it has no disable side effect) — finalization is decoupled.
    const s = await destState(dest);
    expect(s.consecutive_failures).toBe(TEST_THRESHOLD + 1);
    expect(s.disabled_at).toBeNull();
    expect(await intents(dest)).toHaveLength(0);
  });

  it("a `blocked` (SSRF-refused) terminal failure finalizes but does NOT count toward the disable tally", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://k.example.com/in" }))
      .id;
    const deliveryId = await seedOpenDelivery(dest);
    const { consecutiveFailures } = await withTenant(app, orgId, (tx) =>
      markDeliveryTerminalFailure(tx, {
        id: deliveryId,
        destinationId: dest,
        status: "blocked",
        attempt: 1,
        statusCode: null,
        error: "destination resolved to a private address",
      }),
    );
    expect(consecutiveFailures).toBeNull(); // blocked → no tally bump
    const s = await destState(dest);
    expect(s.consecutive_failures).toBe(0); // untouched — an instant refusal isn't multi-day failure
    const [row] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ status: string }[]>`select status from delivery_attempts where id = ${deliveryId}`,
    );
    expect(row!.status).toBe("blocked"); // …but the delivery IS finalized
  });

  it("autoDisableDestination is a no-op below the threshold and when already disabled (idempotent)", async () => {
    const dest = (await createReplayDestination(app, { orgId, url: "https://a.example.com/in" }))
      .id;
    // Below threshold → no-op even called directly.
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`update replay_destinations set consecutive_failures = ${TEST_THRESHOLD - 1} where id = ${dest}`,
    );
    const below = await withTenant(app, orgId, (tx) =>
      autoDisableDestination(tx, {
        orgId,
        destinationId: dest,
        threshold: TEST_THRESHOLD,
        auditKey,
        actor: null,
      }),
    );
    expect(below.disabled).toBe(false);
    expect((await destState(dest)).disabled_at).toBeNull();

    // At/over threshold → disables once; a second call is a no-op (already disabled).
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`update replay_destinations set consecutive_failures = ${TEST_THRESHOLD} where id = ${dest}`,
    );
    const first = await withTenant(app, orgId, (tx) =>
      autoDisableDestination(tx, {
        orgId,
        destinationId: dest,
        threshold: TEST_THRESHOLD,
        auditKey,
        actor: null,
      }),
    );
    const second = await withTenant(app, orgId, (tx) =>
      autoDisableDestination(tx, {
        orgId,
        destinationId: dest,
        threshold: TEST_THRESHOLD,
        auditKey,
        actor: null,
      }),
    );
    expect(first.disabled).toBe(true);
    expect(second.disabled).toBe(false);
    expect(await intents(dest)).toHaveLength(1); // exactly one intent, not two
  });
});
