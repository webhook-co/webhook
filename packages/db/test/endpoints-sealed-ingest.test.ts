import { randomUUID } from "node:crypto";

import {
  importAuditKey,
  LocalKmsProvider,
  SecretStore,
  type SealedRecord,
  type SecretSealer,
  userActor,
} from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  createCredentialHasher,
  CREDENTIAL_PEPPER_MIN_BYTES,
  type CredentialHasher,
} from "../src/credential";
import {
  createEndpointWithAudit,
  readSealedIngestToken,
  rotateEndpointWithAudit,
} from "../src/endpoints";
import { parseIngestToken, revealIngestTokenCore } from "../src/ingest-token-seal";
import { createOrg } from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The SEALED, recoverable copy of the ingest token (S8-remainder, decision-0018). createEndpointWithAudit /
// rotateEndpointWithAudit seal a typed-wrapped copy of the freshly-minted token under the KMS envelope, in
// LOCKSTEP with ingest_token_hash, so the reveal path (Slice 2) can display the always-shown URL. Exercised
// against a REAL Postgres + the local KMS: the seal→store→unseal round-trip, rotate lockstep (never a stale
// seal), the graceful NULL-degrade (no sealer / seal failure), and the webhook_authn grant fence.

const hasher: CredentialHasher = createCredentialHasher({
  current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5),
});

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — tenant DML under RLS
let authn: Sql; // webhook_authn — by-hash ingest cold lookup (must NOT read sealed cols)
let store: SecretStore; // the KMS seal/unseal (implements SecretSealer)
let auditKey: CryptoKey;
let orgA: string;

interface SealedIngestRow {
  ingest_token_ciphertext: Buffer | null;
  ingest_token_wrapped_dek: Buffer | null;
  ingest_token_kek_ref: string | null;
  ingest_token_enc_nonce: Buffer | null;
  ingest_token_envelope_version: number | null;
  ingest_key_id: string | null;
  ingest_token_hash: Buffer;
}

async function readSealedRow(endpointId: string): Promise<SealedIngestRow> {
  const rows = await withTenant(
    app,
    orgA,
    (tx) =>
      tx<SealedIngestRow[]>`
      select ingest_token_ciphertext, ingest_token_wrapped_dek, ingest_token_kek_ref,
             ingest_token_enc_nonce, ingest_token_envelope_version, ingest_key_id, ingest_token_hash
      from endpoints where id = ${endpointId}`,
  );
  const row = rows[0];
  if (!row) throw new Error("endpoint not found");
  return row;
}

/** Unseal the stored sealed ingest token exactly as the reveal path will: AAD rebuilt from AUTHORITATIVE
 *  columns {orgA, endpointId, ingest_key_id}, then parse the typed wrapper. */
async function unsealStored(endpointId: string): Promise<string | null> {
  const row = await readSealedRow(endpointId);
  if (row.ingest_token_ciphertext === null || row.ingest_key_id === null) return null;
  const sealed: SealedRecord = {
    ciphertext: row.ingest_token_ciphertext,
    nonce: row.ingest_token_enc_nonce!,
    wrapped: { wrappedDek: row.ingest_token_wrapped_dek!, kekRef: row.ingest_token_kek_ref! },
    envelopeVersion: row.ingest_token_envelope_version!,
  };
  const plaintext = await store.openString(sealed, {
    orgId: orgA,
    endpointId,
    keyId: row.ingest_key_id,
  });
  return parseIngestToken(plaintext);
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));
  store = new SecretStore(await LocalKmsProvider.generate());
  auditKey = await importAuditKey(new Uint8Array(32).fill(7));
  orgA = (await createOrg(app, { slug: `o-${randomUUID().slice(0, 8)}`, name: "Org A" })).id;
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

describe("createEndpointWithAudit — seal on create", () => {
  it("seals a recoverable copy of the minted token that unseals back to the SAME plaintext", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "sealed-create", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      store,
    );
    const row = await readSealedRow(created.id);
    expect(row.ingest_token_ciphertext).not.toBeNull();
    expect(row.ingest_key_id).not.toBeNull();
    expect(await unsealStored(created.id)).toBe(created.plaintext);
    // Lockstep: the sealed token hashes to the SAME stored ingest_token_hash.
    expect(Buffer.from(row.ingest_token_hash).equals(hasher.hash(created.plaintext))).toBe(true);
  });

  it("degrades to NULL sealed columns when NO sealer is wired (legacy behavior, still creates)", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "no-sealer", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      // no sealer
    );
    const row = await readSealedRow(created.id);
    expect(row.ingest_token_ciphertext).toBeNull();
    expect(row.ingest_key_id).toBeNull();
    expect(created.plaintext).toMatch(/^whep_/); // still minted + returned
  });

  it("degrades to NULL when the seal RPC FAILS — a KMS blip never blocks endpoint creation", async () => {
    const failing: SecretSealer = {
      sealString: () => Promise.reject(new Error("kms unavailable")),
    };
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "seal-fails", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      failing,
    );
    const row = await readSealedRow(created.id);
    expect(row.ingest_token_ciphertext).toBeNull();
    expect(row.ingest_key_id).toBeNull();
  });
});

describe("rotateEndpointWithAudit — reseal on rotate", () => {
  it("reseals the NEW token in lockstep and NEVER leaves a stale seal behind the rotated hash", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "rotate-reseal", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      store,
    );
    const firstToken = created.plaintext;
    expect(await unsealStored(created.id)).toBe(firstToken);

    const rotated = await rotateEndpointWithAudit(
      app,
      { orgId: orgA, endpointId: created.id, actor: userActor("user_alice") },
      hasher,
      auditKey,
      store,
    );
    expect(rotated.plaintext).not.toBe(firstToken);
    // The sealed copy now unseals to the NEW token (not the stale old one).
    expect(await unsealStored(created.id)).toBe(rotated.plaintext);
    // And the stored hash matches the NEW token — hash + seal moved together.
    const row = await readSealedRow(created.id);
    expect(Buffer.from(row.ingest_token_hash).equals(hasher.hash(rotated.plaintext))).toBe(true);
  });

  it("rotate with a FAILING sealer NULLs the sealed columns (never leaves the prior seal)", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "rotate-seal-fail", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      store,
    );
    expect((await readSealedRow(created.id)).ingest_token_ciphertext).not.toBeNull();
    const failing: SecretSealer = {
      sealString: () => Promise.reject(new Error("kms unavailable")),
    };
    await rotateEndpointWithAudit(
      app,
      { orgId: orgA, endpointId: created.id, actor: userActor("user_alice") },
      hasher,
      auditKey,
      failing,
    );
    const row = await readSealedRow(created.id);
    expect(row.ingest_token_ciphertext).toBeNull(); // stale seal overwritten, not left behind
    expect(row.ingest_key_id).toBeNull();
  });
});

describe("grant hygiene", () => {
  it("webhook_authn (the ingest resolver role) is DENIED select on the sealed ingest columns", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "grant-fence", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      store,
    );
    // The cold resolver's role must not be able to read the recoverable ciphertext.
    await expect(
      authn`select ingest_token_ciphertext from endpoints where id = ${created.id}`,
    ).rejects.toThrow(/permission denied/i);
    // But its existing column-scoped read (id, ingest_token_hash, paused) still works (hot path intact):
    // the row IS visible to webhook_authn (the using(true) resolver policy) and returns the granted columns.
    // Assert the row is actually returned — a bare `length >= 0` would be vacuously true and could not catch
    // an RLS/grant regression that blinded the resolver to the row (a silent ingest-resolution outage).
    const ok = await authn<{ id: string }[]>`
      select id, ingest_token_hash, paused from endpoints where id = ${created.id}`;
    expect(ok.length).toBe(1);
    expect(ok[0]!.id).toBe(created.id);
  });
});

describe("readSealedIngestToken + revealIngestTokenCore — the reveal round-trip (Slice 2)", () => {
  const reveal = (orgId: string, endpointId: string) =>
    revealIngestTokenCore(
      {
        read: (o, e) => readSealedIngestToken(app, o, e),
        unseal: (sealed, context) => store.openString(sealed, context),
      },
      orgId,
      endpointId,
    );

  it("reveals the SAME token that was sealed on create (engine-only unseal round-trip)", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "reveal-roundtrip", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      store,
    );
    const read = await readSealedIngestToken(app, orgA, created.id);
    expect(read.found).toBe(true);
    expect(await reveal(orgA, created.id)).toEqual({ found: true, token: created.plaintext });
  });

  it("returns found:true, token:null for a legacy endpoint with no recoverable copy (rotate to reveal)", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "reveal-legacy", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      // no sealer -> NULL sealed columns (legacy shape)
    );
    expect(await readSealedIngestToken(app, orgA, created.id)).toEqual({
      found: true,
      sealed: null,
    });
    expect(await reveal(orgA, created.id)).toEqual({ found: true, token: null });
  });

  it("is RLS-fenced cross-org: a different org cannot read/reveal another org's sealed token (→ NOT_FOUND)", async () => {
    const orgB = (
      await createOrg(app, { slug: `o-${randomUUID().slice(0, 8)}`, name: "Org B reveal" })
    ).id;
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "reveal-crossorg", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      store,
    );
    // orgB asking for orgA's endpoint: RLS makes the row invisible -> found:false.
    expect(await readSealedIngestToken(app, orgB, created.id)).toEqual({ found: false });
    expect(await reveal(orgB, created.id)).toEqual({ found: false, token: null });
  });

  it("returns found:false for an unknown endpoint id", async () => {
    expect(await reveal(orgA, randomUUID())).toEqual({ found: false, token: null });
  });

  it("does NOT reveal a soft-deleted endpoint (deleted_at filter → NOT_FOUND)", async () => {
    const created = await createEndpointWithAudit(
      app,
      { orgId: orgA, name: "reveal-deleted", actor: userActor("user_alice"), maxEndpoints: 100 },
      hasher,
      auditKey,
      store,
    );
    await withTenant(
      app,
      orgA,
      (tx) => tx`update endpoints set deleted_at = now() where id = ${created.id}`,
    );
    expect(await readSealedIngestToken(app, orgA, created.id)).toEqual({ found: false });
  });
});
