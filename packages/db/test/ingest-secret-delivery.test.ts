import { randomUUID } from "node:crypto";

import { LocalKmsProvider, SecretStore } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { InMemoryCredentialCache } from "../src/credential-cache";
import { createEndpoint } from "../src/endpoints";
import { createIngestResolver } from "../src/ingest-resolver";
import { createOrg } from "../src/orgs";
import { addProviderSecret, fromCachedSealedSecret } from "../src/provider-secrets";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The ingest resolver must deliver the endpoint's SEALED provider secrets ON the resolved principal,
// so the synchronous verify path reads them from ONE KV read (no extra DB round-trip on a cache hit).
// The sealed records are carried base64-encoded (JSON-safe) so they survive the KV JSON round-trip,
// and still unseal to the original plaintext. Exercised against real Postgres + the local KMS.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let authn: Sql;
let store: SecretStore;
let orgId: string;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));
  store = new SecretStore(await LocalKmsProvider.generate());
  orgId = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

describe("createIngestResolver delivers sealed provider secrets on the principal", () => {
  it("attaches the endpoint's sealed secrets; each unseals to its plaintext", async () => {
    const ep = await createEndpoint(app, { orgId, name: "stripe-ep" }, hasher);
    const s1 = `whsec_${randomUUID()}`;
    const s2 = `whsec_${randomUUID()}`;
    await addProviderSecret(
      app,
      { orgId, endpointId: ep.id, provider: "stripe", plaintext: s1 },
      store,
    );
    await addProviderSecret(
      app,
      { orgId, endpointId: ep.id, provider: "stripe", plaintext: s2 },
      store,
    );

    const resolver = createIngestResolver({ hasher, cache: new InMemoryCredentialCache(), authn });
    const principal = await resolver.resolve(ep.plaintext);

    expect(principal?.endpointId).toBe(ep.id);
    expect(principal?.sealedSecrets).toHaveLength(2);
    const unsealed = await Promise.all(
      (principal?.sealedSecrets ?? []).map(async (c) => {
        const { sealed, context, provider } = fromCachedSealedSecret(c);
        expect(provider).toBe("stripe");
        return store.openString(sealed, context);
      }),
    );
    expect(new Set(unsealed)).toEqual(new Set([s1, s2]));
  });

  it("a hot cache hit (KV JSON round-trip) still carries unsealable secrets", async () => {
    const ep = await createEndpoint(app, { orgId, name: "cache-hit" }, hasher);
    const plaintext = `whsec_${randomUUID()}`;
    await addProviderSecret(
      app,
      { orgId, endpointId: ep.id, provider: "stripe", plaintext },
      store,
    );
    const cache = new InMemoryCredentialCache();
    const resolver = createIngestResolver({ hasher, cache, authn });

    await resolver.resolve(ep.plaintext); // cold: populates KV (JSON.stringify of the principal)
    const fromCache = await resolver.resolve(ep.plaintext); // hot: JSON.parse(KV)

    expect(fromCache?.sealedSecrets).toHaveLength(1);
    const { sealed, context } = fromCachedSealedSecret(fromCache!.sealedSecrets![0]!);
    expect(await store.openString(sealed, context)).toBe(plaintext); // base64 survived JSON
  });

  it("an endpoint with no provider secrets resolves with an empty sealed-secret list", async () => {
    const ep = await createEndpoint(app, { orgId, name: "no-secrets" }, hasher);
    const resolver = createIngestResolver({ hasher, cache: new InMemoryCredentialCache(), authn });
    const principal = await resolver.resolve(ep.plaintext);
    expect(principal?.endpointId).toBe(ep.id);
    expect(principal?.sealedSecrets).toEqual([]);
  });
});
