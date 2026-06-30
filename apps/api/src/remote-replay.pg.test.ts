import { randomUUID } from "node:crypto";

import type { AuthContext } from "@webhook-co/contract";
import {
  createClient,
  createCredentialHasher,
  createEndpoint,
  createOrg,
  createReplayDestination,
  createSigningSecret,
  CREDENTIAL_PEPPER_MIN_BYTES,
  DB_ROLES,
  withTenant,
  type Sql,
} from "@webhook-co/db";
import {
  LocalKmsProvider,
  newId,
  SecretStore,
  type DeliverArgs,
  type DeliverResult,
  type DeliveryDispatcherRpc,
} from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupSchema } from "../../../packages/db/test/migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "../../../packages/db/test/pg";
import { createRemoteReplayHandler } from "./remote-replay.js";

// The api-side remote-replay orchestration (events.replay {kind:"destination"}, ADR-0081), exercised
// against a REAL Postgres under RLS with a FAKE dispatcher (the engine delivery is tested separately, in
// the engine workerd suite). Proves the glue: resolve under RLS → claim a pending row → deliver via the
// dispatcher → finalize with the real outcome; the idempotent re-claim short-circuit (no re-deliver); and
// the fault mapping (NOT_FOUND / FORBIDDEN) before any delivery.

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
  calls: DeliverArgs[];
} {
  const calls: DeliverArgs[] = [];
  return {
    rpc: {
      deliver: async (args) => {
        calls.push(args);
        return r;
      },
    },
    calls,
  };
}

const ctx = (scopes: string[] = ["events:replay"]): AuthContext => ({ orgId, scopes });
const input = (over: Record<string, unknown> = {}) => ({
  eventId,
  target: { kind: "destination", destinationId: destId },
  idempotencyKey: randomUUID(),
  ...over,
});

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
         ${"application/json"}, ${tx.json([
           ["webhook-id", "msg_1"],
           ["host", "wbhk.my"],
         ])}, ${newId()}, ${"content_hash"}, ${"stripe"}, ${true})`;
  });
  destId = (await createReplayDestination(app, { orgId, url: "https://hooks.example.com/in" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("createRemoteReplayHandler", () => {
  it("resolves + claims + delivers + finalizes a 2xx as 'delivered' with the true status_code", async () => {
    const d = dispatcherReturning({
      outcome: "delivered",
      status: 200,
      error: null,
      latencyMs: 12,
    });
    const h = createRemoteReplayHandler({ tenant: app, dispatcher: d.rpc });
    const out = await h(ctx(), input());
    expect(out.status).toBe("delivered");
    expect(out.statusCode).toBe(200);
    // the engine got the event's endpoint/dedup (it re-derives the R2 key) + the registered destination url.
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]!.url).toBe("https://hooks.example.com/in");
    expect(d.calls[0]!.endpointId).toBeTruthy();
    expect(d.calls[0]!.headers).toContainEqual(["webhook-id", "msg_1"]);
  });

  it("records a guard 'blocked' outcome with a null status_code", async () => {
    const d = dispatcherReturning({
      outcome: "blocked",
      status: null,
      error: "destination resolved to a disallowed (private/internal) address",
      latencyMs: 3,
    });
    const h = createRemoteReplayHandler({ tenant: app, dispatcher: d.rpc });
    const out = await h(ctx(), input());
    expect(out.status).toBe("blocked");
    expect(out.statusCode).toBeNull();
  });

  it("a re-replay with the SAME idempotency key returns the existing row and does NOT re-deliver", async () => {
    const d = dispatcherReturning({ outcome: "delivered", status: 200, error: null, latencyMs: 1 });
    const h = createRemoteReplayHandler({ tenant: app, dispatcher: d.rpc });
    const key = randomUUID();
    const first = await h(ctx(), input({ idempotencyKey: key }));
    const again = await h(ctx(), input({ idempotencyKey: key }));
    expect(again.id).toBe(first.id);
    expect(d.calls).toHaveLength(1); // delivered exactly once
  });

  it("NOT_FOUND for an unknown destination (no existence leak); FORBIDDEN without scope — neither delivers", async () => {
    const d = dispatcherReturning({ outcome: "delivered", status: 200, error: null, latencyMs: 1 });
    const h = createRemoteReplayHandler({ tenant: app, dispatcher: d.rpc });
    await expect(
      h(ctx(), input({ target: { kind: "destination", destinationId: randomUUID() } })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h(ctx([]), input())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(d.calls).toHaveLength(0);
  });

  it("rejects an idempotency key reused for a DIFFERENT destination (no silent skip)", async () => {
    const dest2 = (
      await createReplayDestination(app, { orgId, url: "https://other.example.com/in" })
    ).id;
    const d = dispatcherReturning({ outcome: "delivered", status: 200, error: null, latencyMs: 1 });
    const h = createRemoteReplayHandler({ tenant: app, dispatcher: d.rpc });
    const key = randomUUID();
    await h(ctx(), input({ idempotencyKey: key })); // first replay → destId, delivered
    // reusing the same key for a DIFFERENT destination must NOT silently skip + report success.
    await expect(
      h(
        ctx(),
        input({ idempotencyKey: key, target: { kind: "destination", destinationId: dest2 } }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(d.calls).toHaveLength(1); // the second never delivered
  });

  it("records a dispatcher RPC failure as 'failed' (no throw, no stuck pending, no 500)", async () => {
    const h = createRemoteReplayHandler({
      tenant: app,
      dispatcher: {
        deliver: async () => {
          throw new Error("engine binding overloaded");
        },
      },
    });
    const out = await h(ctx(), input());
    expect(out.status).toBe("failed");
    expect(out.statusCode).toBeNull();
  });

  it("delivers even when the inbound endpoint is PAUSED (replay-to-destination is independent of ingest)", async () => {
    await withTenant(
      app,
      orgId,
      (tx) => tx`update endpoints set paused = true where id = ${endpointId}`,
    );
    try {
      const d = dispatcherReturning({
        outcome: "delivered",
        status: 200,
        error: null,
        latencyMs: 1,
      });
      const h = createRemoteReplayHandler({ tenant: app, dispatcher: d.rpc });
      const out = await h(ctx(), input());
      expect(out.status).toBe("delivered"); // NOT ENDPOINT_PAUSED
      expect(d.calls).toHaveLength(1);
    } finally {
      await withTenant(
        app,
        orgId,
        (tx) => tx`update endpoints set paused = false where id = ${endpointId}`,
      );
    }
  });

  it("passes the destination's sealed signing secret(s) to the dispatcher (S3 Slice 2)", async () => {
    // A destination WITH a signing secret → the api relays the sealed envelope + a fresh webhook-id (the
    // attempt id). The engine (tested separately) unseals + signs; here we assert the api built `signing`.
    const store = new SecretStore(await LocalKmsProvider.generate());
    const signedDest = (
      await createReplayDestination(app, { orgId, url: "https://signed.example.com/in" })
    ).id;
    await createSigningSecret(app, { orgId, destinationId: signedDest }, store);

    const d = dispatcherReturning({ outcome: "delivered", status: 200, error: null, latencyMs: 1 });
    const h = createRemoteReplayHandler({ tenant: app, dispatcher: d.rpc });
    const out = await h(ctx(), {
      eventId,
      target: { kind: "destination", destinationId: signedDest },
      idempotencyKey: randomUUID(),
    });
    expect(out.status).toBe("delivered");
    const signing = d.calls[0]!.signing;
    expect(signing).toBeDefined();
    expect(signing!.secrets).toHaveLength(1);
    // the relayed payload is SEALED (ciphertext + AAD context) — never the plaintext whsec_
    expect(signing!.secrets[0]!.sealed.ciphertext.byteLength).toBeGreaterThan(0);
    expect(signing!.secrets[0]!.context.orgId).toBe(orgId);
    expect(signing!.webhookId).toBe(out.id); // fresh idempotency key = the attempt id
    expect(typeof signing!.timestamp).toBe("number");
    // and the unsealed secret round-trips (proves the api relayed a real, openable envelope)
    expect(
      (
        await store.openString(signing!.secrets[0]!.sealed, signing!.secrets[0]!.context)
      ).startsWith("whsec_"),
    ).toBe(true);
  });

  it("delivers UNSIGNED (no signing) when the destination has no signing secret — 1b behavior", async () => {
    const d = dispatcherReturning({ outcome: "delivered", status: 200, error: null, latencyMs: 1 });
    const h = createRemoteReplayHandler({ tenant: app, dispatcher: d.rpc });
    await h(ctx(), input()); // destId has no signing secret
    expect(d.calls[0]!.signing).toBeUndefined();
  });
});
