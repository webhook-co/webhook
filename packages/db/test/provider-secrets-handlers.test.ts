import { randomUUID } from "node:crypto";

import { type AuthContext } from "@webhook-co/contract";
import {
  importAuditKey,
  LocalKmsProvider,
  SecretStore,
  verifyAuditChain,
} from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint, getEndpointIngestTokenHash } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { createWriteHandlers } from "../src/write-handlers";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The provider-secret WRITE handlers (ADR-0078) against a REAL Postgres under webhook_app (RLS): the
// add/list/revoke dispatch in createWriteHandlers. Proves the handler orchestration the db-function
// tests don't: scope-FIRST authz (sole gate on mcp), NOT_FOUND for an unknown/cross-org endpoint, the
// secret NEVER echoed back, the metadata-only list (no ciphertext), the endpoint-scoped revoke, the KV
// eviction on add + revoke (ADR-0015), and the Standard-Webhooks registration-format check.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let auditKey: CryptoKey;
let sealer: SecretStore;
let orgA: string;
let orgB: string;
let epA: string;
let epB: string;
const evicted: Buffer[] = [];

function handlers() {
  evicted.length = 0; // reset per construction; the closure below always pushes to this array
  return createWriteHandlers({
    tenant: app,
    hasher,
    auditKey,
    ingestBaseUrl: "https://wbhk.my",
    secretSealer: sealer,
    invalidateIngestHash: async (h) => {
      evicted.push(h);
    },
  });
}

const ctx = (orgId: string, scopes: string[]): AuthContext => ({ orgId, scopes });
const rw = (orgId: string) => ctx(orgId, ["endpoints:read", "endpoints:write"]);

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  auditKey = await importAuditKey(new Uint8Array(32).fill(7));
  sealer = new SecretStore(await LocalKmsProvider.generate());
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "B" })).id;
  epA = (await createEndpoint(app, { orgId: orgA, name: "ep-a" }, hasher)).id;
  epB = (await createEndpoint(app, { orgId: orgB, name: "ep-b" }, hasher)).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("endpoints.addProviderSecret handler", () => {
  it("seals + stores, returns {id,provider,status} (NEVER the secret), and evicts the endpoint", async () => {
    const h = handlers().get("endpoints.addProviderSecret")!;
    const out = (await h(rw(orgA), {
      endpointId: epA,
      provider: "stripe",
      secret: "whsec_super_secret_value",
      label: "prod",
    })) as Record<string, unknown>;
    expect(out).toMatchObject({ provider: "stripe", status: "active" });
    expect(typeof out.id).toBe("string");
    // The plaintext is sealed + never echoed in the response.
    expect(JSON.stringify(out)).not.toContain("whsec_super_secret_value");
    // Evicted the endpoint's token hash so the new secret is honored on the next ingest (not after TTL).
    const hash = await getEndpointIngestTokenHash(app, orgA, epA);
    expect(evicted.some((e) => e.equals(hash!))).toBe(true);
    // An in-tx wha1 audit row was appended (parity with the endpoints lifecycle): provider_secret.added,
    // target = the new secret id, actor null (api-key bearer), and the chain still verifies.
    const rows = await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA));
    const last = rows[rows.length - 1]!;
    expect(last.action).toBe("provider_secret.added");
    expect(last.target).toBe(out.id);
    expect(last.actor).toBeNull();
    expect((await verifyAuditChain(auditKey, orgA, rows)).ok).toBe(true);
  });

  it("rejects a standard_webhooks secret that matches the base64 alphabet but is not valid base64", async () => {
    // `whsec_AAAAA` (body length 5 ≡ 1 mod 4) passes a naive `[A-Za-z0-9+/]+` alphabet check but is NOT
    // decodable base64 — the verify path's decoder returns null, so it would verify as NO_MATCHING_KEY
    // forever. The contract refinement uses that same decoder, so registration rejects it up front.
    const h = handlers().get("endpoints.addProviderSecret")!;
    await expect(
      h(rw(orgA), { endpointId: epA, provider: "standard_webhooks", secret: "whsec_AAAAA" }),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "VALIDATION_ERROR" });
    expect(evicted).toHaveLength(0); // rejected before any seal/insert/evict
  });

  it("rejects a caller without endpoints:write (FORBIDDEN) and seals/evicts NOTHING", async () => {
    const h = handlers().get("endpoints.addProviderSecret")!;
    await expect(
      h(ctx(orgA, ["endpoints:read"]), { endpointId: epA, provider: "stripe", secret: "whsec_x" }),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "FORBIDDEN" });
    expect(evicted).toHaveLength(0); // scope check is FIRST
  });

  it("NOT_FOUND for an unknown endpoint (no orphan secret, no eviction)", async () => {
    const h = handlers().get("endpoints.addProviderSecret")!;
    await expect(
      h(rw(orgA), { endpointId: randomUUID(), provider: "stripe", secret: "whsec_x" }),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "NOT_FOUND" });
    expect(evicted).toHaveLength(0);
  });

  it("cannot add to another org's endpoint (NOT_FOUND under RLS)", async () => {
    const h = handlers().get("endpoints.addProviderSecret")!;
    await expect(
      h(rw(orgA), { endpointId: epB, provider: "stripe", secret: "whsec_x" }),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "NOT_FOUND" });
  });

  it("rejects a malformed standard_webhooks secret with VALIDATION_ERROR", async () => {
    const h = handlers().get("endpoints.addProviderSecret")!;
    await expect(
      h(rw(orgA), { endpointId: epA, provider: "standard_webhooks", secret: "whsec_not base64!!" }),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "VALIDATION_ERROR" });
  });
});

describe("endpoints.listProviderSecrets handler", () => {
  it("returns metadata only (no ciphertext/plaintext) for the endpoint's secrets", async () => {
    const add = handlers().get("endpoints.addProviderSecret")!;
    await add(rw(orgA), {
      endpointId: epA,
      provider: "github",
      secret: "gh_plain_secret",
      label: "gh",
    });
    const h = handlers().get("endpoints.listProviderSecrets")!;
    const out = (await h(rw(orgA), { endpointId: epA })) as {
      items: Record<string, unknown>[];
    };
    expect(out.items.length).toBeGreaterThan(0);
    for (const item of out.items) {
      expect(Object.keys(item).sort()).toEqual(["createdAt", "id", "label", "provider", "status"]);
    }
    // No sealed bytes / plaintext anywhere in the serialized response.
    expect(JSON.stringify(out)).not.toMatch(/ciphertext|wrapped|nonce|gh_plain_secret/);
  });

  it("rejects a caller without endpoints:read (FORBIDDEN)", async () => {
    const h = handlers().get("endpoints.listProviderSecrets")!;
    await expect(h(ctx(orgA, ["events:read"]), { endpointId: epA })).rejects.toMatchObject({
      name: "CapabilityFault",
      code: "FORBIDDEN",
    });
  });
});

describe("endpoints.revokeProviderSecret handler", () => {
  it("revokes the endpoint's secret + evicts, and returns {id, revokedAt}", async () => {
    const add = handlers().get("endpoints.addProviderSecret")!;
    const added = (await add(rw(orgA), {
      endpointId: epA,
      provider: "slack",
      secret: "slack_secret",
    })) as { id: string };
    const h = handlers().get("endpoints.revokeProviderSecret")!;
    const out = (await h(rw(orgA), { endpointId: epA, secretId: added.id })) as Record<
      string,
      unknown
    >;
    expect(out.id).toBe(added.id);
    expect(out.revokedAt).toBeDefined();
    const hash = await getEndpointIngestTokenHash(app, orgA, epA);
    expect(evicted.some((e) => e.equals(hash!))).toBe(true);
    // The revoke appended a provider_secret.revoked wha1 row (target = the secret id) in-tx.
    const rows = await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA));
    const last = rows[rows.length - 1]!;
    expect(last.action).toBe("provider_secret.revoked");
    expect(last.target).toBe(added.id);
    expect((await verifyAuditChain(auditKey, orgA, rows)).ok).toBe(true);
  });

  it("NOT_FOUND for an unknown secret id (no eviction, no audit row)", async () => {
    const h = handlers().get("endpoints.revokeProviderSecret")!;
    const before = (await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA))).length;
    await expect(h(rw(orgA), { endpointId: epA, secretId: randomUUID() })).rejects.toMatchObject({
      name: "CapabilityFault",
      code: "NOT_FOUND",
    });
    expect(evicted).toHaveLength(0);
    // A no-op revoke leaves the audit chain untouched (audit only a real transition).
    const after = (await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA))).length;
    expect(after).toBe(before);
  });

  it("rejects a caller without endpoints:write (FORBIDDEN)", async () => {
    const h = handlers().get("endpoints.revokeProviderSecret")!;
    await expect(
      h(ctx(orgA, ["endpoints:read"]), { endpointId: epA, secretId: randomUUID() }),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "FORBIDDEN" });
  });
});
