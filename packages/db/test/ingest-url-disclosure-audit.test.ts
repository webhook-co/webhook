import { randomUUID } from "node:crypto";

import { importAuditKey, userActor } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  auditIngestUrlDisclosureOnce,
  INGEST_URL_REVEAL_AUDIT_ACTION,
} from "../src/ingest-url-reveal";
import { createOrg } from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// S.9 — the DASHBOARD ingest-URL disclosure audit. The dashboard shows the URL as always-shown config (no
// discrete reveal action), so the API path's per-call audit + rate-limit can't apply verbatim: auditing
// every render would flood the tamper-evident chain (which ADR-0101 deliberately avoided). So the dashboard
// records the FIRST disclosure per (actor, endpoint) — an attributable "this human retrieved this endpoint's
// ingest credential" event — and nothing on subsequent renders. Better attribution than the API path, which
// carries a null actor for bearer keys.

let pg: EphemeralPostgres;
let app: Sql;
let auditKey: CryptoKey;
let orgId: string;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 5) % 256)),
  );
  orgId = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "s9" })).id;
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

const revealRows = (endpointId: string) =>
  withTenant(app, orgId, async (tx) =>
    (await readAuditChain(tx, orgId)).filter(
      (r) => r.action === INGEST_URL_REVEAL_AUDIT_ACTION && r.target === endpointId,
    ),
  );

describe("auditIngestUrlDisclosureOnce", () => {
  it("writes exactly ONE attributable row for a first disclosure, and returns true", async () => {
    const endpointId = randomUUID();
    const actor = userActor(randomUUID());

    const wrote = await auditIngestUrlDisclosureOnce(app, auditKey, orgId, actor, endpointId);

    expect(wrote).toBe(true);
    const rows = await revealRows(endpointId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(`user:${actor.id}`); // attributed to the human, not a null bearer
  });

  it("does NOT write a second row for a repeat disclosure by the SAME actor (deduped, not per-render spam)", async () => {
    const endpointId = randomUUID();
    const actor = userActor(randomUUID());

    await auditIngestUrlDisclosureOnce(app, auditKey, orgId, actor, endpointId);
    const second = await auditIngestUrlDisclosureOnce(app, auditKey, orgId, actor, endpointId);
    const third = await auditIngestUrlDisclosureOnce(app, auditKey, orgId, actor, endpointId);

    expect(second).toBe(false);
    expect(third).toBe(false);
    expect(await revealRows(endpointId)).toHaveLength(1); // still exactly one
  });

  it("records a DISTINCT first disclosure per actor — so each teammate's first view is attributable", async () => {
    const endpointId = randomUUID();
    const alice = userActor(randomUUID());
    const bob = userActor(randomUUID());

    await auditIngestUrlDisclosureOnce(app, auditKey, orgId, alice, endpointId);
    await auditIngestUrlDisclosureOnce(app, auditKey, orgId, bob, endpointId);

    const rows = await revealRows(endpointId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actor).sort()).toEqual([`user:${alice.id}`, `user:${bob.id}`].sort());
  });

  it("scopes dedup to the endpoint — the same actor viewing a different endpoint is its own first disclosure", async () => {
    const actor = userActor(randomUUID());
    const ep1 = randomUUID();
    const ep2 = randomUUID();

    await auditIngestUrlDisclosureOnce(app, auditKey, orgId, actor, ep1);
    const onEp2 = await auditIngestUrlDisclosureOnce(app, auditKey, orgId, actor, ep2);

    expect(onEp2).toBe(true);
    expect(await revealRows(ep1)).toHaveLength(1);
    expect(await revealRows(ep2)).toHaveLength(1);
  });
});
