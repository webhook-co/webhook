import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint, INGEST_TOKEN_PREFIX, makeEndpointTokenColdLookup } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { expectNoSecretInSerialized } from "./secret-leak";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// createOrg + createEndpoint + the webhook_authn endpoint-token COLD lookup, exercised
// against a REAL Postgres with REAL non-owner roles. This validates the bootstrap
// primitives (org/endpoint creation under RLS) and the org-discovery-by-token-hash the
// ingest path depends on — the analog of the api-key verify path, but for ingest tokens.

// A fixed test pepper (>=32 bytes). In prod the pepper is injected from a wrangler secret.
const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — create org/endpoint (tenant DML under RLS)
let authn: Sql; // webhook_authn — the by-hash endpoint resolution cold path
let orgA: string;
let orgB: string;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));

  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

describe("createOrg + createEndpoint -> resolve token by hash", () => {
  it("creates an endpoint, returns the ingest token once, and the cold lookup discovers its org+endpoint", async () => {
    const ep = await createEndpoint(app, { orgId: orgA, name: "stripe-prod" }, hasher);
    expect(ep.plaintext.startsWith(`${INGEST_TOKEN_PREFIX}_`)).toBe(true);
    expect(ep.start.startsWith(INGEST_TOKEN_PREFIX)).toBe(true); // non-secret display handle
    expect(ep.orgId).toBe(orgA);
    expect(ep.paused).toBe(false);

    const cold = makeEndpointTokenColdLookup(authn);
    const principal = await cold(hasher.hash(ep.plaintext));
    expect(principal?.orgId).toBe(orgA); // org DISCOVERED from the token
    expect(principal?.endpointId).toBe(ep.id); // endpoint discovered from the token
    expect(principal?.paused).toBe(false);
  });

  it("never persists or returns the plaintext token anywhere but the once-shown field", async () => {
    const ep = await createEndpoint(app, { orgId: orgA, name: "leak-check" }, hasher);
    // The stored hash hex and the full plaintext must be absent from a re-fetch of the row's
    // display fields (the cold lookup never returns plaintext either).
    const cold = makeEndpointTokenColdLookup(authn);
    const principal = await cold(hasher.hash(ep.plaintext));
    expectNoSecretInSerialized(principal, [
      ep.plaintext,
      hasher.hash(ep.plaintext).toString("hex"),
    ]);
  });

  it("mints a distinct token+hash per endpoint (ingest_token_hash unique holds)", async () => {
    const a = await createEndpoint(app, { orgId: orgA, name: "ep1" }, hasher);
    const b = await createEndpoint(app, { orgId: orgA, name: "ep2" }, hasher);
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(hasher.hash(a.plaintext).equals(hasher.hash(b.plaintext))).toBe(false);
  });
});

describe("cross-org isolation (RLS)", () => {
  it("org A's app context cannot see org B's endpoint, but the token still resolves to org B", async () => {
    const bEp = await createEndpoint(app, { orgId: orgB, name: "borg-ep" }, hasher);

    // Under org A's context, org B's endpoint row is invisible (deny-by-default RLS).
    const rowsUnderA = await withTenant(app, orgA, async (tx) => {
      return tx`select id from endpoints where id = ${bEp.id}`;
    });
    expect(rowsUnderA.length).toBe(0);

    // Org-discovery-by-hash never crosses the boundary: the token resolves to org B.
    const cold = makeEndpointTokenColdLookup(authn);
    const principal = await cold(hasher.hash(bEp.plaintext));
    expect(principal?.orgId).toBe(orgB);
    expect(principal?.endpointId).toBe(bEp.id);
  });
});

describe("paused endpoint", () => {
  it("the cold lookup reflects a paused endpoint so the ingest guard can reject", async () => {
    const ep = await createEndpoint(app, { orgId: orgA, name: "pausable" }, hasher);
    await withTenant(app, orgA, async (tx) => {
      await tx`update endpoints set paused = true where id = ${ep.id}`;
    });

    const cold = makeEndpointTokenColdLookup(authn);
    const principal = await cold(hasher.hash(ep.plaintext));
    expect(principal?.paused).toBe(true);
  });

  it("an unknown token resolves to null (no row -> no principal)", async () => {
    const cold = makeEndpointTokenColdLookup(authn);
    const principal = await cold(hasher.hash(`${INGEST_TOKEN_PREFIX}_does-not-exist`));
    expect(principal).toBeNull();
  });
});

describe("createOrg", () => {
  it("defaults region to 'us' and returns the created fields", async () => {
    const org = await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Default Region" });
    expect(org.region).toBe("us");
    expect(org.name).toBe("Default Region");
  });

  it("honors an explicit region", async () => {
    const org = await createOrg(app, { slug: randomUUID().slice(0, 8), name: "EU", region: "eu" });
    expect(org.region).toBe("eu");
  });
});

describe("webhook_authn endpoint grant is least-privilege (migration 0011)", () => {
  // The migration is the security-load-bearing artifact: webhook_authn may read ONLY
  // (id, org_id, ingest_token_hash, paused) and may NOT write. Lock that boundary so a
  // future widening (an added column / a table-level grant) fails loudly here.
  it("cannot read an ungranted endpoint column (name)", async () => {
    await expect(authn`select name from endpoints limit 1`).rejects.toThrow(/permission denied/i);
  });

  it("cannot write endpoints (resolve-only role)", async () => {
    await expect(authn`update endpoints set paused = true where org_id = ${orgA}`).rejects.toThrow(
      /permission denied/i,
    );
  });
});
