import { randomUUID } from "node:crypto";

import {
  importAuditKey,
  isUsableStandardWebhooksSecret,
  LocalKmsProvider,
  SecretStore,
} from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createOrg } from "../src/orgs";
import { createReplayDestination } from "../src/replay-destinations";
import {
  createSigningSecret,
  getActiveSigningSecrets,
  listSigningSecrets,
  rotateSigningSecret,
  type SealedSigningSecret,
} from "../src/signing-keys";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// signing_keys storage (S3 Slice 2): the per-DESTINATION outbound Standard Webhooks signing secret.
// createSigningSecret MINTS a whsec_ secret (webhook.co-generated, not user-supplied — unlike provider
// secrets), seals it under the KMS envelope, stores ONLY the ciphertext, and reveals the plaintext ONCE.
// The engine unseals it at delivery to sign. Exercised against a REAL Postgres + the REAL webhook_app
// role under RLS + the local KMS, so the seal -> store -> retrieve -> unseal round-trip, rotation overlap,
// metadata-only listing, and tenant isolation are validated end to end.

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — manage + read signing secrets under RLS
let store: SecretStore;
let orgA: string;
let orgB: string;
let destA: string; // a replay destination in org A
let destB: string; // a replay destination in org B (cross-org isolation)

const unseal = (s: SealedSigningSecret) => store.openString(s.sealed, s.context);
const activeFor = (orgId: string, destinationId: string) =>
  withTenant(app, orgId, (tx) => getActiveSigningSecrets(tx, destinationId));

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  store = new SecretStore(await LocalKmsProvider.generate());
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
  destA = (await createReplayDestination(app, { orgId: orgA, url: "https://a.example.com/in" })).id;
  destB = (await createReplayDestination(app, { orgId: orgB, url: "https://b.example.com/in" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("createSigningSecret + getActiveSigningSecrets", () => {
  it("mints a usable whsec_ secret, seals it, and round-trips through unseal (plaintext never stored)", async () => {
    const created = await createSigningSecret(app, { orgId: orgA, destinationId: destA }, store);
    expect(created.secret.startsWith("whsec_")).toBe(true);
    expect(isUsableStandardWebhooksSecret(created.secret)).toBe(true);

    const active = await activeFor(orgA, destA);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(created.keyId);
    expect(active[0]!.status).toBe("active");
    // the sealed bytes unseal back to the exact revealed plaintext
    expect(await unseal(active[0]!)).toBe(created.secret);
  });

  it("writes an in-tx audit row (signing_secret.created) when an audit key is supplied", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(4));
    const created = await createSigningSecret(app, { orgId: orgA, destinationId: destA }, store, {
      auditKey,
      actor: null,
    });
    const rows = await withTenant(
      app,
      orgA,
      (tx) => tx<{ target: string }[]>`
      select target from audit_log
      where org_id = ${orgA} and action = 'signing_secret.created' and target = ${created.keyId}`,
    );
    expect(rows).toHaveLength(1);
  });

  it("stores ONLY sealed bytes — there is no plaintext column", async () => {
    const cols = await withTenant(
      app,
      orgA,
      (tx) => tx<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'signing_keys'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).toContain("secret_ciphertext");
    expect(names).toContain("destination_id");
    expect(names).not.toContain("endpoint_id"); // re-pointed by migration 0026
    expect(names).not.toContain("secret"); // no plaintext column
  });
});

describe("rotateSigningSecret (zero-downtime overlap)", () => {
  it("retires the current active + mints a new active, so both verify during overlap", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://rotate.example.com/in" })
    ).id;
    const first = await createSigningSecret(app, { orgId: orgA, destinationId: dest }, store);
    const second = await rotateSigningSecret(app, { orgId: orgA, destinationId: dest }, store);

    expect(second.keyId).not.toBe(first.keyId);
    expect(second.secret).not.toBe(first.secret);

    const active = await activeFor(orgA, dest);
    expect(active).toHaveLength(2); // new active + old retiring
    const byId = new Map(active.map((s) => [s.id, s]));
    expect(byId.get(second.keyId)!.status).toBe("active");
    expect(byId.get(first.keyId)!.status).toBe("retiring");
    // newest first
    expect(active[0]!.id).toBe(second.keyId);
    // both still unseal to their revealed plaintexts
    expect(await unseal(byId.get(second.keyId)!)).toBe(second.secret);
    expect(await unseal(byId.get(first.keyId)!)).toBe(first.secret);
  });

  it("bounds the overlap to two keys — a second rotation revokes the prior retiring key", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://rotate2.example.com/in" })
    ).id;
    await createSigningSecret(app, { orgId: orgA, destinationId: dest }, store);
    await rotateSigningSecret(app, { orgId: orgA, destinationId: dest }, store);
    await rotateSigningSecret(app, { orgId: orgA, destinationId: dest }, store);
    const active = await activeFor(orgA, dest);
    expect(active).toHaveLength(2); // still only {active, retiring} — the oldest was revoked
  });

  it("writes an in-tx audit row (signing_secret.rotated) when an audit key is supplied", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(4));
    const dest = (
      await createReplayDestination(app, {
        orgId: orgA,
        url: "https://rotate-audit.example.com/in",
      })
    ).id;
    await createSigningSecret(app, { orgId: orgA, destinationId: dest }, store);
    const rotated = await rotateSigningSecret(app, { orgId: orgA, destinationId: dest }, store, {
      auditKey,
      actor: null,
    });
    const rows = await withTenant(
      app,
      orgA,
      (tx) => tx<{ target: string }[]>`
        select target from audit_log
        where org_id = ${orgA} and action = 'signing_secret.rotated' and target = ${rotated.keyId}`,
    );
    expect(rows).toHaveLength(1); // a credential mutation must leave a tamper-evident audit entry
  });
});

describe("listSigningSecrets (metadata only)", () => {
  it("returns id/status/createdAt and NEVER the sealed bytes or plaintext", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://list.example.com/in" })
    ).id;
    const created = await createSigningSecret(app, { orgId: orgA, destinationId: dest }, store);
    const meta = await listSigningSecrets(app, orgA, dest);
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({ id: created.keyId, status: "active" });
    expect(meta[0]).toHaveProperty("createdAt");
    // no secret material leaks through the metadata shape
    expect(JSON.stringify(meta)).not.toContain("ciphertext");
    expect(JSON.stringify(meta)).not.toContain(created.secret);
  });
});

describe("tenant isolation (RLS)", () => {
  it("org B cannot see org A's signing secrets", async () => {
    await createSigningSecret(app, { orgId: orgA, destinationId: destA }, store);
    // org B's tenant context sees nothing for org A's destination
    const leaked = await activeFor(orgB, destA);
    expect(leaked).toHaveLength(0);
    // and listing under org B for a foreign destination is empty
    expect(await listSigningSecrets(app, orgB, destA)).toHaveLength(0);
    // a real org-B destination still works (sanity: not a false-empty)
    await createSigningSecret(app, { orgId: orgB, destinationId: destB }, store);
    expect(await activeFor(orgB, destB)).toHaveLength(1);
  });
});
