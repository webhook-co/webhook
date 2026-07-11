import { randomUUID } from "node:crypto";

import { type AuthContext } from "@webhook-co/contract";
import { importAuditKey, userActor } from "@webhook-co/shared";
import type { IngestUrlRevealerRpc, RevealedIngestToken } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendAuditEntry, readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpointWithAudit } from "../src/endpoints";
import {
  INGEST_URL_REVEAL_AUDIT_ACTION,
  INGEST_URL_REVEAL_MAX_PER_WINDOW,
} from "../src/ingest-url-reveal";
import { createOrg } from "../src/orgs";
import { createWriteHandlers } from "../src/write-handlers";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The endpoints.revealIngestUrl WRITE handler (S8-remainder / ADR-0101): scope-gated, engine-RPC-backed,
// audited, rate-limited. The unseal itself is faked here (the engine RPC is tested separately); this proves
// the handler's control-plane behavior against a REAL Postgres (the audit chain + the audit-derived cap).

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let auditKey: CryptoKey;
let orgA: string;
let endpointId: string;

/** A fake reveal RPC whose behavior the tests set per-case. */
let revealImpl: (orgId: string, endpointId: string) => Promise<RevealedIngestToken>;
const reveal: IngestUrlRevealerRpc = {
  revealIngestToken: (o, e) => revealImpl(o, e),
};

const handlers = () =>
  createWriteHandlers({
    tenant: app,
    hasher,
    auditKey,
    ingestBaseUrl: "https://wbhk.my",
    revealIngestUrl: reveal,
  });

const writeCtx = (): AuthContext => ({
  orgId: orgA,
  scopes: ["endpoints:write"],
  keyId: "key_test",
});

async function revealCountAudit(): Promise<number> {
  const rows = await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA));
  return rows.filter((r) => r.action === "endpoint.ingest_url_revealed").length;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  auditKey = await importAuditKey(new Uint8Array(32).fill(9));
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  endpointId = (
    await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "reveal-ep", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
    )
  ).id;
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("endpoints.revealIngestUrl handler", () => {
  it("rejects a caller without endpoints:write (FORBIDDEN) and never reveals/audits", async () => {
    revealImpl = () => Promise.reject(new Error("should not be called"));
    const before = await revealCountAudit();
    const h = handlers().get("endpoints.revealIngestUrl")!;
    await expect(
      h({ orgId: orgA, scopes: ["endpoints:read"] }, { endpointId }),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "FORBIDDEN" });
    expect(await revealCountAudit()).toBe(before);
  });

  it("returns the ${apex}/<token> URL and writes ONE disclosure audit row on a real reveal", async () => {
    revealImpl = async () => ({ found: true, token: "whep_live123" });
    const before = await revealCountAudit();
    const h = handlers().get("endpoints.revealIngestUrl")!;
    const out = (await h(writeCtx(), { endpointId })) as { ingestUrl: string | null };
    expect(out.ingestUrl).toBe("https://wbhk.my/whep_live123");
    expect(await revealCountAudit()).toBe(before + 1); // audited the disclosure
  });

  it("returns ingestUrl:null for a legacy endpoint (no copy) and does NOT audit (nothing disclosed)", async () => {
    revealImpl = async () => ({ found: true, token: null });
    const before = await revealCountAudit();
    const h = handlers().get("endpoints.revealIngestUrl")!;
    const out = (await h(writeCtx(), { endpointId })) as { ingestUrl: string | null };
    expect(out.ingestUrl).toBeNull();
    expect(await revealCountAudit()).toBe(before); // no disclosure → no audit row
  });

  it("maps found:false to NOT_FOUND (unknown / cross-org endpoint)", async () => {
    revealImpl = async () => ({ found: false, token: null });
    const h = handlers().get("endpoints.revealIngestUrl")!;
    await expect(h(writeCtx(), { endpointId: randomUUID() })).rejects.toMatchObject({
      name: "CapabilityFault",
      code: "NOT_FOUND",
    });
  });

  it("rate-limits reveals per org (RATE_LIMITED once the audit-derived window cap is hit)", async () => {
    // Fresh org so this test's window count is isolated.
    const capOrg = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Cap" })).id;
    const ep = (
      await createEndpointWithAudit(
        app,
        { orgId: capOrg, name: "cap-ep", actor: userActor("user_alice"), maxEndpoints: 100 },
        hasher,
        auditKey,
      )
    ).id;
    revealImpl = async () => ({ found: true, token: "whep_x" });
    const h = handlers().get("endpoints.revealIngestUrl")!;
    const ctx: AuthContext = { orgId: capOrg, scopes: ["endpoints:write"], keyId: "key_test" };
    // Seed the window to the cap by appending the disclosure audit rows the limiter counts
    // (action = endpoint.ingest_url_revealed) DIRECTLY, in a SINGLE transaction — instead of
    // driving the cap via that many full handler reveals. The handler path (rate-limit query +
    // reveal RPC + audit append, each its own round-trip × the cap) took ~100s on a slow Neon
    // night, and the limiter's window is 60s WALL-CLOCK, so the earliest reveals aged out before
    // the last landed and the cap was never observed — the test false-passed (resolved instead of
    // RATE_LIMITED). One in-tx append loop is far faster than the window, so the count is real.
    await withTenant(app, capOrg, async (tx) => {
      for (let i = 0; i < INGEST_URL_REVEAL_MAX_PER_WINDOW; i++) {
        await appendAuditEntry(tx, auditKey, {
          orgId: capOrg,
          actor: userActor("user_alice"),
          action: INGEST_URL_REVEAL_AUDIT_ACTION,
          target: ep,
        });
      }
    });
    // With the window already at the cap, the next real reveal must be throttled BEFORE the unseal.
    await expect(h(ctx, { endpointId: ep })).rejects.toMatchObject({
      name: "CapabilityFault",
      code: "RATE_LIMITED",
    });
  });
});
