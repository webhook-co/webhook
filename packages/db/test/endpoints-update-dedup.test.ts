import { randomUUID } from "node:crypto";

import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import {
  createEndpointWithAudit,
  makeEndpointTokenColdLookup,
  updateEndpointDedupWithAudit,
} from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { getEndpoint } from "../src/reads";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// endpoints.update (dedup config, ADR-0104) against a REAL Postgres under webhook_app RLS + the
// webhook_authn cold lookup. Proves the config round-trips DB -> read model AND DB -> ingest cold
// lookup (the engine read path), that create persists it, that update mutates + audits + returns the
// token hash for KV eviction, that null resets, and NOT_FOUND for an unknown id.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x9a) });

let pg: EphemeralPostgres;
let app: Sql;
let authn: Sql;
let auditKey: CryptoKey;
let orgA: string;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 5) % 256)),
  );
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

const OFF = { mode: "off" as const, windowSeconds: 3600 };
const FIELDS = { mode: "fields" as const, windowSeconds: 300, fields: { include: ["body.id"] } };

describe("endpoints.update — dedup config round-trip", () => {
  it("create persists a dedup config; getEndpoint + the cold lookup both return it (DB -> engine read path)", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "with-config", dedupConfig: OFF, actor: null, maxEndpoints: 100 },
      hasher,
      auditKey,
    );
    const read = await withTenant(app, orgA, (tx) => getEndpoint(tx, created.id));
    expect(read?.dedupConfig).toEqual(OFF);
    // The ingest cold lookup (what the engine resolves) must carry the config too, or the endpoint's
    // mode would never reach deriveDedup.
    const principal = await makeEndpointTokenColdLookup(authn)(hasher.hash(created.plaintext));
    expect(principal?.dedupConfig).toEqual(OFF);
  });

  it("a create WITHOUT a config leaves dedupConfig null (the default)", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "no-config", actor: null, maxEndpoints: 100 },
      hasher,
      auditKey,
    );
    expect(
      (await withTenant(app, orgA, (tx) => getEndpoint(tx, created.id)))?.dedupConfig,
    ).toBeNull();
  });

  it("update mutates the config, appends one audit row, and returns the token hash for KV eviction", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "to-update", actor: null, maxEndpoints: 100 },
      hasher,
      auditKey,
    );
    const before = (await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA))).length;
    const updated = await updateEndpointDedupWithAudit(
      app,
      { orgId: orgA, endpointId: created.id, dedupConfig: FIELDS, actor: null },
      auditKey,
    );
    expect(updated.dedupConfig).toEqual(FIELDS);
    expect(updated.tokenHash).toEqual(hasher.hash(created.plaintext)); // the evictor key
    expect((await withTenant(app, orgA, (tx) => getEndpoint(tx, created.id)))?.dedupConfig).toEqual(
      FIELDS,
    );
    const chain = await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA));
    expect(chain.length).toBe(before + 1);
    expect(chain.at(-1)?.action).toBe("endpoint.dedup_config_updated");
  });

  it("update with null RESETS the config to the default", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "to-reset", dedupConfig: FIELDS, actor: null, maxEndpoints: 100 },
      hasher,
      auditKey,
    );
    await updateEndpointDedupWithAudit(
      app,
      { orgId: orgA, endpointId: created.id, dedupConfig: null, actor: null },
      auditKey,
    );
    expect(
      (await withTenant(app, orgA, (tx) => getEndpoint(tx, created.id)))?.dedupConfig,
    ).toBeNull();
  });

  it("throws NOT_FOUND for an unknown endpoint id", async () => {
    await expect(
      updateEndpointDedupWithAudit(
        app,
        { orgId: orgA, endpointId: randomUUID(), dedupConfig: OFF, actor: null },
        auditKey,
      ),
    ).rejects.toThrow(/not found/i);
  });
});
