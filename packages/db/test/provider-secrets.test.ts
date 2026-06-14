import { randomUUID } from "node:crypto";

import { LocalKmsProvider, SecretStore } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import {
  addProviderSecret,
  getEndpointProviderSecrets,
  type SealedProviderSecret,
} from "../src/provider-secrets";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

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
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
  epA = (await createEndpoint(app, { orgId: orgA, name: "stripe-ep" }, hasher)).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

describe("addProviderSecret + getEndpointProviderSecrets", () => {
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
    await withTenant(app, orgA, async (tx) => {
      await tx`update provider_secrets set status = 'revoked' where id = ${revoked.id}`;
    });

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
