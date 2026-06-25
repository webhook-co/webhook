import { randomUUID } from "node:crypto";

import { CreatedEndpointSchema, type AuthContext } from "@webhook-co/contract";
import { importAuditKey, verifyAuditChain } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import {
  createEndpointWithAudit,
  INGEST_TOKEN_PREFIX,
  makeEndpointTokenColdLookup,
} from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { getEndpoint } from "../src/reads";
import {
  buildCapabilityHandlers,
  createWriteHandlers,
  normalizeIngestApex,
} from "../src/write-handlers";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The endpoints.create WRITE path against a REAL Postgres under the non-owner webhook_app role (RLS):
// the audited single-tx createEndpointWithAudit primitive and the shared createWriteHandlers dispatch.
// Proves: endpoint + ingest-token mint, an in-tx wha1/audit_log row (the chain's first live writer),
// the mint<->ingest round-trip (cold lookup), cross-org isolation, the per-org soft cap (RATE_LIMITED),
// single-tx ATOMICITY (audit failure rolls back the endpoint), and the handler's scope-FIRST authz
// (no mint/audit on a denied call) + the one-time ingestUrl shape.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — tenant DML under RLS
let authn: Sql; // webhook_authn — by-hash ingest cold lookup
let auditKey: CryptoKey;
let orgA: string;
let orgB: string;

async function countEndpoints(orgId: string): Promise<number> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) => tx<{ count: number }[]>`select count(*)::int as count from endpoints`,
  );
  return rows[0]?.count ?? 0;
}
async function auditLen(orgId: string): Promise<number> {
  const rows = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
  return rows.length;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)),
  );
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

describe("createEndpointWithAudit", () => {
  it("creates an endpoint, mints a one-time token, and appends an in-tx audit row that verifies", async () => {
    const before = await auditLen(orgA);
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "stripe-prod", actor: "user_alice", maxEndpoints: 100 },
      hasher,
      auditKey,
    );
    expect(created.plaintext.startsWith(`${INGEST_TOKEN_PREFIX}_`)).toBe(true);
    expect(created.orgId).toBe(orgA);
    expect(created.paused).toBe(false);
    expect(created.createdAt).toBeInstanceOf(Date);

    // The endpoint row is visible under org A and matches.
    const ep = await withTenant(app, orgA, (tx) => getEndpoint(tx, created.id));
    expect(ep?.name).toBe("stripe-prod");

    // Exactly one audit row was appended: action endpoint.created, target = the endpoint id, actor.
    const rows = await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA));
    expect(rows.length).toBe(before + 1);
    const last = rows[rows.length - 1]!;
    expect(last.action).toBe("endpoint.created");
    expect(last.target).toBe(created.id);
    expect(last.actor).toBe("user_alice");

    // The whole chain verifies against the audit key.
    const v = await verifyAuditChain(auditKey, orgA, rows);
    expect(v.ok).toBe(true);
  });

  it("the minted token resolves back to its org+endpoint via the ingest cold lookup", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "ingest-roundtrip", actor: null, maxEndpoints: 100 },
      hasher,
      auditKey,
    );
    const cold = makeEndpointTokenColdLookup(authn);
    const principal = await cold(hasher.hash(created.plaintext));
    expect(principal?.orgId).toBe(orgA);
    expect(principal?.endpointId).toBe(created.id);
    expect(principal?.paused).toBe(false);
  });

  it("is org-isolated under RLS — a create in org B is invisible to org A", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgB, name: "borg-create", actor: null, maxEndpoints: 100 },
      hasher,
      auditKey,
    );
    const underA = await withTenant(
      app,
      orgA,
      (tx) => tx`select id from endpoints where id = ${created.id}`,
    );
    expect(underA.length).toBe(0);
  });

  it("enforces the per-org soft cap with RATE_LIMITED and mints nothing past it", async () => {
    const capOrg = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Cap" })).id;
    const auditBefore = await auditLen(capOrg);
    await createEndpointWithAudit(
      app,
      { orgId: capOrg, name: "c1", actor: null, maxEndpoints: 2 },
      hasher,
      auditKey,
    );
    await createEndpointWithAudit(
      app,
      { orgId: capOrg, name: "c2", actor: null, maxEndpoints: 2 },
      hasher,
      auditKey,
    );
    await expect(
      createEndpointWithAudit(
        app,
        { orgId: capOrg, name: "c3", actor: null, maxEndpoints: 2 },
        hasher,
        auditKey,
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "RATE_LIMITED" });
    expect(await countEndpoints(capOrg)).toBe(2); // the over-cap call minted nothing
    expect(await auditLen(capOrg)).toBe(auditBefore + 2); // and wrote no extra audit row
  });

  it("is atomic — if the audit append fails, the endpoint insert rolls back (no orphan)", async () => {
    const atomOrg = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Atom" })).id;
    const auditBefore = await auditLen(atomOrg);
    // A CryptoKey that is NOT usable for HMAC sign → computeAuditRowHash (crypto.subtle.sign HMAC)
    // throws AFTER the endpoint row is inserted, forcing the single tx to roll back.
    const bogusKey = (await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32),
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    )) as CryptoKey;
    await expect(
      createEndpointWithAudit(
        app,
        { orgId: atomOrg, name: "atom", actor: null, maxEndpoints: 100 },
        hasher,
        bogusKey,
      ),
    ).rejects.toThrow();
    expect(await countEndpoints(atomOrg)).toBe(0); // insert rolled back
    expect(await auditLen(atomOrg)).toBe(auditBefore); // no audit row committed
  });
});

describe("createWriteHandlers — endpoints.create handler", () => {
  const handlers = () =>
    createWriteHandlers({
      tenant: app,
      hasher,
      auditKey,
      ingestBaseUrl: "https://wbhk.my",
      maxEndpoints: 100,
    });
  const writeCtx: AuthContext = { orgId: "", scopes: ["endpoints:write"] };

  it("mints and returns a contract-shaped endpoint with a one-time ingestUrl", async () => {
    const h = handlers().get("endpoints.create")!;
    const out = (await h({ ...writeCtx, orgId: orgA }, { name: "via-handler" })) as Record<
      string,
      unknown
    >;
    expect(out.name).toBe("via-handler");
    expect(out.paused).toBe(false);
    expect(String(out.ingestUrl)).toMatch(/^https:\/\/wbhk\.my\/whep_[A-Za-z0-9_-]{43}$/);
    // The handler output validates against the contract output schema (createdAt Date -> z.coerce.date).
    expect(CreatedEndpointSchema.safeParse(out).success).toBe(true);
  });

  it("rejects a caller without endpoints:write (FORBIDDEN) and mints/audits NOTHING", async () => {
    const h = handlers().get("endpoints.create")!;
    const epsBefore = await countEndpoints(orgA);
    const auditBefore = await auditLen(orgA);
    await expect(
      h({ orgId: orgA, scopes: ["endpoints:read"] }, { name: "denied" }),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "FORBIDDEN" });
    expect(await countEndpoints(orgA)).toBe(epsBefore); // scope check is FIRST: no mint on deny
    expect(await auditLen(orgA)).toBe(auditBefore); // and no audit row
  });

  it("rejects an empty/blank name with VALIDATION_ERROR", async () => {
    const h = handlers().get("endpoints.create")!;
    await expect(h({ ...writeCtx, orgId: orgA }, { name: "   " })).rejects.toMatchObject({
      name: "CapabilityFault",
      code: "VALIDATION_ERROR",
    });
  });

  it("normalizes a trailing slash on the ingest apex (no double slash in the URL)", async () => {
    const h = createWriteHandlers({
      tenant: app,
      hasher,
      auditKey,
      ingestBaseUrl: "https://wbhk.my/",
      maxEndpoints: 100,
    }).get("endpoints.create")!;
    const out = (await h({ ...writeCtx, orgId: orgA }, { name: "trailing-slash" })) as Record<
      string,
      unknown
    >;
    expect(String(out.ingestUrl)).toMatch(/^https:\/\/wbhk\.my\/whep_/);
    expect(String(out.ingestUrl)).not.toContain("//whep");
  });

  it("fails closed on a garbage ingest apex BEFORE minting (no endpoint, no audit row)", async () => {
    const h = createWriteHandlers({
      tenant: app,
      hasher,
      auditKey,
      ingestBaseUrl: "not-a-url",
      maxEndpoints: 100,
    }).get("endpoints.create")!;
    const epsBefore = await countEndpoints(orgA);
    const auditBefore = await auditLen(orgA);
    await expect(h({ ...writeCtx, orgId: orgA }, { name: "bad-apex" })).rejects.toThrow(
      /INGEST_BASE_URL/,
    );
    expect(await countEndpoints(orgA)).toBe(epsBefore); // validated before the mint → no orphan
    expect(await auditLen(orgA)).toBe(auditBefore);
  });
});

describe("buildCapabilityHandlers", () => {
  it("merges the read + write handlers into one map both surfaces dispatch", () => {
    const map = buildCapabilityHandlers({
      tenant: app,
      cursorKey: undefined as unknown as CryptoKey, // not exercised here; reads aren't invoked
      auditKey,
      hasher,
      ingestBaseUrl: "https://wbhk.my",
    });
    expect(map.has("endpoints.list")).toBe(true); // a read handler
    expect(map.has("endpoints.create")).toBe(true); // a write handler
    expect(map.has("endpoints.delete")).toBe(true); // a write handler (ADR-0076)
    expect(map.has("endpoints.rotate")).toBe(true); // a write handler (ADR-0076)
    expect(map.has("audit.verify")).toBe(true);
  });
});

describe("normalizeIngestApex", () => {
  it("returns the bare origin for valid http(s) apexes (trailing slash stripped)", () => {
    expect(normalizeIngestApex("https://wbhk.my")).toBe("https://wbhk.my");
    expect(normalizeIngestApex("https://wbhk.my/")).toBe("https://wbhk.my");
    expect(normalizeIngestApex("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("rejects a missing scheme, a non-http(s) scheme, or empty input", () => {
    expect(() => normalizeIngestApex("wbhk.my")).toThrow(/INGEST_BASE_URL/);
    expect(() => normalizeIngestApex("")).toThrow(/INGEST_BASE_URL/);
    expect(() => normalizeIngestApex("ftp://wbhk.my")).toThrow(/INGEST_BASE_URL/);
  });

  it("rejects a path, query, or fragment (would yield a broken ingest URL)", () => {
    expect(() => normalizeIngestApex("https://wbhk.my/x")).toThrow(/path, query, or fragment/);
    expect(() => normalizeIngestApex("https://wbhk.my/?a=1")).toThrow(/path, query, or fragment/);
    expect(() => normalizeIngestApex("https://wbhk.my/#frag")).toThrow(/path, query, or fragment/);
  });
});
