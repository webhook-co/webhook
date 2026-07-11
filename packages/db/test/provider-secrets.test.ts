import { randomUUID } from "node:crypto";

import {
  importAuditKey,
  LocalKmsProvider,
  parseVerifyTokenSecret,
  SecretStore,
  type SecretSealer,
  userActor,
} from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint, getEndpointIngestTokenHash } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import {
  addProviderSecret,
  countLiveProviderSecrets,
  getEndpointProviderSecrets,
  MAX_PROVIDER_SECRETS_PER_ENDPOINT,
  registerProviderSecret,
  retireProviderSecret,
  revokeProviderSecret,
  type RegisterProviderSecretDeps,
  type SealedProviderSecret,
} from "../src/provider-secrets";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// provider_secrets storage + retrieval: the SEALED (envelope-encrypted) provider signing secrets
// the synchronous ingest verify path needs. addProviderSecret seals the plaintext under the KMS
// envelope and stores ONLY the ciphertext (never the plaintext). getEndpointProviderSecrets is the
// org-discovery-by-endpoint read the ingest cold lookup runs as webhook_authn. Exercised against a
// REAL Postgres with the REAL roles + the local KMS, so the seal -> store -> retrieve -> unseal
// round-trip, rotation order, revocation, and tenant isolation are validated end-to-end.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — seed org/endpoint + add/manage secrets under RLS
let authn: Sql; // webhook_authn — the by-endpoint sealed-secret cold read
let store: SecretStore;
let auditKey: CryptoKey;
let orgA: string;
let orgB: string;
let epA: string;

async function unseal(secret: SealedProviderSecret): Promise<string> {
  return store.openString(secret.sealed, secret.context);
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));
  store = new SecretStore(await LocalKmsProvider.generate());
  auditKey = await importAuditKey(new Uint8Array(32).fill(7));
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
  epA = (await createEndpoint(app, { orgId: orgA, name: "stripe-ep" }, hasher)).id;
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

describe("addProviderSecret + getEndpointProviderSecrets", () => {
  it("seals through any SecretSealer (not just SecretStore) — the api/mcp remote-sealer seam", async () => {
    // In prod, api/mcp don't hold the KEK: they delegate sealing to the engine over a service binding
    // (ADR-0078 / D1). That sealer is structurally just { sealString }. Prove addProviderSecret depends
    // only on that narrow seam by sealing through a plain delegating object, then round-tripping.
    const sealedUnder: string[] = [];
    const remoteLike: SecretSealer = {
      sealString: (plaintext, context) => {
        sealedUnder.push(context.keyId);
        return store.sealString(plaintext, context);
      },
    };
    const plaintext = `whsec_${randomUUID()}`;
    const added = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: epA, provider: "github", plaintext },
      remoteLike,
    );
    expect(sealedUnder).toEqual([added.id]); // sealed under the new row id as the AAD keyId, via the seam
    const found = (await getEndpointProviderSecrets(authn, epA)).find((s) => s.id === added.id);
    expect(found).toBeDefined();
    expect(await unseal(found!)).toBe(plaintext);
  });

  it("seals a secret, stores only ciphertext, and the round-trip unseals to the plaintext", async () => {
    const plaintext = `whsec_${randomUUID()}`;
    const added = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: epA, provider: "stripe", label: "prod", plaintext },
      store,
    );
    expect(added.provider).toBe("stripe");
    expect(added.status).toBe("active");

    // Retrieval is the ingest cold path: webhook_authn (org-discovery, no prior tenant context).
    const secrets = await getEndpointProviderSecrets(authn, epA);
    const mine = secrets.find((s) => s.id === added.id);
    expect(mine).toBeDefined();
    expect(await unseal(mine!)).toBe(plaintext);

    // The plaintext is NEVER stored — the row holds only AES-GCM ciphertext.
    const [row] = await withTenant(app, orgA, async (tx) => {
      return tx<{ secret_ciphertext: Buffer }[]>`
        select secret_ciphertext from provider_secrets where id = ${added.id}`;
    });
    expect(row?.secret_ciphertext.toString("utf8")).not.toContain(plaintext);
  });

  it("returns active + retiring secrets newest-first (rotation) and excludes revoked", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "rotating" }, hasher)).id;
    const older = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_old" },
      store,
    );
    const newer = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_new" },
      store,
    );
    const revoked = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_dead" },
      store,
    );
    expect(
      await revokeProviderSecret(app, { orgId: orgA, endpointId: ep, secretId: revoked.id }),
    ).not.toBeNull();

    const secrets = await getEndpointProviderSecrets(authn, ep);
    expect(secrets.map((s) => s.id)).toEqual([newer.id, older.id]); // newest first, revoked gone
    expect(await unseal(secrets[0]!)).toBe("whsec_new");
    expect(await unseal(secrets[1]!)).toBe("whsec_old");
  });

  it("is org-scoped under RLS: org A's app context cannot see org B's secret", async () => {
    const epB = (await createEndpoint(app, { orgId: orgB, name: "borg-ep" }, hasher)).id;
    await addProviderSecret(
      app,
      { orgId: orgB, endpointId: epB, provider: "github", plaintext: "ghsecret" },
      store,
    );
    // Under org A's tenant context, org B's endpoint secrets are invisible (deny-by-default RLS).
    const underA = await withTenant(app, orgA, async (tx) => {
      return tx`select id from provider_secrets where endpoint_id = ${epB}`;
    });
    expect(underA.length).toBe(0);
  });
});

describe("webhook_authn cold read (org-discovery, least-privilege)", () => {
  it("resolves an endpoint's SEALED secrets across tenants and they unseal", async () => {
    const plaintext = `whsec_${randomUUID()}`;
    const added = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: epA, provider: "stripe", plaintext },
      store,
    );
    // webhook_authn discovers the endpoint's sealed secrets WITHOUT a prior tenant context.
    const secrets = await getEndpointProviderSecrets(authn, epA);
    const mine = secrets.find((s) => s.id === added.id);
    expect(mine).toBeDefined();
    expect(mine!.context.orgId).toBe(orgA); // org discovered from the row
    expect(await unseal(mine!)).toBe(plaintext);
  });

  it("cannot read the ungranted display label, and cannot write (resolve-only role)", async () => {
    await expect(authn`select label from provider_secrets limit 1`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      authn`update provider_secrets set status = 'revoked' where org_id = ${orgA}`,
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("revokeProviderSecret + retireProviderSecret (lifecycle, webhook_app under RLS)", () => {
  it("revoke flips status to revoked and the secret drops out of the verify cold read", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "revoke-me" }, hasher)).id;
    const s = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_revoke" },
      store,
    );
    // active -> honored by the verify cold path
    expect((await getEndpointProviderSecrets(authn, ep)).map((x) => x.id)).toContain(s.id);

    expect(
      await revokeProviderSecret(app, { orgId: orgA, endpointId: ep, secretId: s.id }),
    ).not.toBeNull();

    // revoked -> excluded from the cold read; verify no longer honors signatures made with it
    // (once the resolver's cached principal is invalidated; see getEndpointIngestTokenHash + ADR-0015).
    expect((await getEndpointProviderSecrets(authn, ep)).map((x) => x.id)).not.toContain(s.id);
  });

  it("revoke is idempotent: re-revoking an already-revoked secret returns false", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "double-revoke" }, hasher)).id;
    const s = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_x" },
      store,
    );
    expect(
      await revokeProviderSecret(app, { orgId: orgA, endpointId: ep, secretId: s.id }),
    ).not.toBeNull();
    expect(
      await revokeProviderSecret(app, { orgId: orgA, endpointId: ep, secretId: s.id }),
    ).toBeNull();
  });

  it("retire marks the secret 'retiring' but KEEPS it honored (rotation grace, not revocation)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "retire-me" }, hasher)).id;
    const s = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_retire" },
      store,
    );
    expect(await retireProviderSecret(app, orgA, s.id)).toBe(true);

    const got = (await getEndpointProviderSecrets(authn, ep)).find((x) => x.id === s.id);
    expect(got).toBeDefined();
    expect(got!.status).toBe("retiring"); // still returned -> still verified during the grace window
  });

  it("retire only transitions an ACTIVE secret: retiring a revoked secret returns false", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "retire-revoked" }, hasher)).id;
    const s = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_y" },
      store,
    );
    expect(
      await revokeProviderSecret(app, { orgId: orgA, endpointId: ep, secretId: s.id }),
    ).not.toBeNull();
    expect(await retireProviderSecret(app, orgA, s.id)).toBe(false);
  });

  it("revoke can KILL a retiring secret mid-rotation (retiring -> revoked, dropped from the cold read)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "revoke-retiring" }, hasher)).id;
    const s = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_grace" },
      store,
    );
    // Move it into the rotation grace state (retiring -> still honored)...
    expect(await retireProviderSecret(app, orgA, s.id)).toBe(true);
    expect((await getEndpointProviderSecrets(authn, ep)).map((x) => x.id)).toContain(s.id);

    // ...then revoke it OUTRIGHT. revoke's guard is `status <> 'revoked'`, so retiring -> revoked
    // is allowed (this is the kill-a-leaked-secret-during-rotation path); it then drops from the
    // cold read. (Guards revoke against being wrongly narrowed to active-only.)
    expect(
      await revokeProviderSecret(app, { orgId: orgA, endpointId: ep, secretId: s.id }),
    ).not.toBeNull();
    expect((await getEndpointProviderSecrets(authn, ep)).map((x) => x.id)).not.toContain(s.id);
  });

  it("is org-scoped under RLS: org A cannot revoke org B's secret (and B's stays honored)", async () => {
    const epB = (await createEndpoint(app, { orgId: orgB, name: "borg-revoke" }, hasher)).id;
    const sB = await addProviderSecret(
      app,
      { orgId: orgB, endpointId: epB, provider: "github", plaintext: "ghsecret-revoke" },
      store,
    );
    // org A's tenant context can't see org B's row (RLS) -> the update matches zero rows -> null.
    expect(
      await revokeProviderSecret(app, { orgId: orgA, endpointId: epB, secretId: sB.id }),
    ).toBeNull();
    // ...and org B's secret was NOT collaterally revoked.
    expect((await getEndpointProviderSecrets(authn, epB)).map((x) => x.id)).toContain(sB.id);
  });
});

describe("registerProviderSecret (the shared api/mcp/web core)", () => {
  function regDeps(evicted: Buffer[]): RegisterProviderSecretDeps {
    return {
      sealer: store,
      evict: async (h) => {
        evicted.push(h);
      },
      auditKey,
      actor: userActor("user-1"),
    };
  }

  it("registers a signing_secret (raw), returns active, round-trips, and evicts the endpoint hash", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "reg-signing" }, hasher)).id;
    const evicted: Buffer[] = [];
    const secret = `whsec_${randomUUID()}`;
    const added = await registerProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", kind: "signing_secret", secret },
      regDeps(evicted),
    );
    expect(added.status).toBe("active");
    expect(added.provider).toBe("stripe");
    // signing_secret is stored AS-IS (round-trips to the raw value).
    const mine = (await getEndpointProviderSecrets(authn, ep)).find((s) => s.id === added.id);
    expect(await unseal(mine!)).toBe(secret);
    // The endpoint's ingest-token hash was evicted (best-effort verify-cache bust).
    const hash = await getEndpointIngestTokenHash(app, orgA, ep);
    expect(evicted.some((e) => e.equals(hash!))).toBe(true);
  });

  it("serializes a verify_token to its typed blob (web path parity — parseVerifyTokenSecret recovers it)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "reg-vt" }, hasher)).id;
    const added = await registerProviderSecret(
      app,
      {
        orgId: orgA,
        endpointId: ep,
        provider: "meta",
        kind: "verify_token",
        secret: "my-hub-token",
      },
      regDeps([]),
    );
    const mine = (await getEndpointProviderSecrets(authn, ep)).find((s) => s.id === added.id);
    const stored = await unseal(mine!);
    expect(stored).not.toBe("my-hub-token"); // wrapped, not raw
    expect(parseVerifyTokenSecret(stored)).toBe("my-hub-token"); // the engine recovers the token
  });

  it("throws NOT_FOUND for an unknown endpoint, BEFORE any seal/evict", async () => {
    const evicted: Buffer[] = [];
    await expect(
      registerProviderSecret(
        app,
        {
          orgId: orgA,
          endpointId: randomUUID(),
          provider: "stripe",
          kind: "signing_secret",
          secret: "whsec_x",
        },
        regDeps(evicted),
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "NOT_FOUND" });
    expect(evicted).toHaveLength(0);
  });

  it("throws VALIDATION_ERROR for a malformed SW secret, BEFORE any seal/evict", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "reg-bad" }, hasher)).id;
    const evicted: Buffer[] = [];
    await expect(
      registerProviderSecret(
        app,
        // standard_webhooks IS in SW_SECRET_PROVIDERS; whsec_AAAAA (body ≡1 mod 4) isn't decodable base64.
        {
          orgId: orgA,
          endpointId: ep,
          provider: "standard_webhooks",
          kind: "signing_secret",
          secret: "whsec_AAAAA",
        },
        regDeps(evicted),
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "VALIDATION_ERROR" });
    expect(evicted).toHaveLength(0);
  });

  it("rejects an empty secret with VALIDATION_ERROR (the zod-less web path's base-constraint gate)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "reg-empty" }, hasher)).id;
    await expect(
      registerProviderSecret(
        app,
        { orgId: orgA, endpointId: ep, provider: "github", kind: "signing_secret", secret: "" },
        regDeps([]),
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "VALIDATION_ERROR" });
  });

  it("rejects an out-of-enum kind with VALIDATION_ERROR (never serializes to undefined)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "reg-kind" }, hasher)).id;
    await expect(
      registerProviderSecret(
        app,
        // A crafted web POST could supply an arbitrary kind string (types are erased) — the core rejects it.
        { orgId: orgA, endpointId: ep, provider: "github", kind: "bogus" as never, secret: "x" },
        regDeps([]),
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "VALIDATION_ERROR" });
  });

  it("validates BEFORE the endpoint lookup — a bad secret + unknown endpoint is VALIDATION_ERROR, not NOT_FOUND", async () => {
    // Parity with the api handler's safeParse-first precedence (and no endpoint-existence leak pre-validation).
    await expect(
      registerProviderSecret(
        app,
        {
          orgId: orgA,
          endpointId: randomUUID(),
          provider: "standard_webhooks",
          kind: "signing_secret",
          secret: "whsec_AAAAA",
        },
        regDeps([]),
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "VALIDATION_ERROR" });
  });

  it("does not fail a committed registration when the best-effort evict throws", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "reg-evict-throw" }, hasher)).id;
    const added = await registerProviderSecret(
      app,
      {
        orgId: orgA,
        endpointId: ep,
        provider: "github",
        kind: "signing_secret",
        secret: "whsec_ok",
      },
      {
        sealer: store,
        evict: async () => {
          throw new Error("KV blip");
        },
        auditKey,
        actor: userActor("user-1"),
      },
    );
    // The secret is durably stored despite the evict failure — no throw, no duplicate-inducing retry.
    expect(added.status).toBe("active");
    expect((await getEndpointProviderSecrets(authn, ep)).some((s) => s.id === added.id)).toBe(true);
  });

  it("enforces the per-endpoint cap with RATE_LIMITED", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "reg-cap" }, hasher)).id;
    // Seed the cap via the low-level add (no cap check) so the (MAX+1)th registration is the one that trips it.
    for (let i = 0; i < MAX_PROVIDER_SECRETS_PER_ENDPOINT; i++) {
      await addProviderSecret(
        app,
        { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: `whsec_${i}` },
        store,
      );
    }
    expect(await countLiveProviderSecrets(app, orgA, ep)).toBe(MAX_PROVIDER_SECRETS_PER_ENDPOINT);
    const evicted: Buffer[] = [];
    await expect(
      registerProviderSecret(
        app,
        {
          orgId: orgA,
          endpointId: ep,
          provider: "stripe",
          kind: "signing_secret",
          secret: "whsec_over",
        },
        regDeps(evicted),
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "RATE_LIMITED" });
    expect(evicted).toHaveLength(0);
  });

  it("countLiveProviderSecrets counts active + retiring, excludes revoked", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "reg-count" }, hasher)).id;
    const a = await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_a" },
      store,
    );
    await addProviderSecret(
      app,
      { orgId: orgA, endpointId: ep, provider: "stripe", plaintext: "whsec_b" },
      store,
    );
    expect(await countLiveProviderSecrets(app, orgA, ep)).toBe(2);
    await revokeProviderSecret(app, { orgId: orgA, endpointId: ep, secretId: a.id });
    expect(await countLiveProviderSecrets(app, orgA, ep)).toBe(1); // revoked excluded
  });
});
