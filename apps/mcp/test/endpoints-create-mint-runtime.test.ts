// endpoints.create mints its wbhk.my ingest token INSIDE the McpAgent Durable Object — a new runtime
// path (today the DO only reads). This guards that the ingest-token mint (node:crypto randomBytes +
// HMAC, via mintCredential) actually runs in the workerd runtime that backs the DO. randomBytes
// availability is isolate-level (nodejs_compat), identical for a Worker and a Durable Object, so
// proving it in this workers-pool isolate proves it for the DO; no Postgres is needed for the mint
// itself (the endpoint INSERT + audit append are covered in the db pool + a prod smoke). createHmac is
// already exercised by the api-key path; this isolates the primitive the DO write path newly relies on.
import {
  createCredentialHasherFromBase64,
  INGEST_TOKEN_PREFIX,
  mintCredential,
} from "@webhook-co/db";
import { readSecretBinding } from "@webhook-co/shared";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("endpoints.create — ingest-token mint runs in the workerd runtime (DO write path)", () => {
  it("mints a whep_ base64url token via node:crypto randomBytes inside the runtime", async () => {
    const pepper = await readSecretBinding(env.CREDENTIAL_PEPPER as SecretsStoreSecret | string);
    const hasher = createCredentialHasherFromBase64(pepper);

    const a = mintCredential(INGEST_TOKEN_PREFIX, hasher);
    const b = mintCredential(INGEST_TOKEN_PREFIX, hasher);

    expect(a.plaintext).toMatch(/^whep_[A-Za-z0-9_-]{43}$/); // prefix + 32-byte base64url body
    expect(a.keyHash).toBeInstanceOf(Buffer);
    expect(a.keyHash.length).toBe(32); // HMAC-SHA256 digest
    expect(a.plaintext).not.toBe(b.plaintext); // CSPRNG entropy: two mints differ
  });
});
