import { toCachedSealedSecret, type CachedSealedSecret } from "@webhook-co/db";
import { LocalKmsProvider, SecretStore, type EncryptionContext } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { makeVerifyIngest } from "../src/verify";

// The real synchronous verify step, exercised in WORKERD: seal a provider secret under the local
// KMS, sign a Stripe payload with it, and assert the unseal + Stripe adapter path verifies it. Also
// the unhappy paths (wrong secret, no adapter, a corrupt secret among valid ones) — all best-effort,
// never throwing. The AAD is rebuilt from the AUTHORITATIVE org/endpoint passed by handleIngest.

const ORG = "be000000-0000-4000-8000-000000000001";
const EP = "be000000-0000-4000-8000-000000000002";
const enc = new TextEncoder();

async function seal(
  store: SecretStore,
  plaintext: string,
  keyId: string,
): Promise<CachedSealedSecret> {
  const context: EncryptionContext = { orgId: ORG, endpointId: EP, keyId };
  const sealed = await store.sealString(plaintext, context);
  return toCachedSealedSecret({ id: keyId, provider: "stripe", status: "active", sealed, context });
}

async function stripeSignature(secret: string, t: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Seal a secret registered under an arbitrary provider (for the multi-/registered-provider cases). */
async function sealAs(
  store: SecretStore,
  plaintext: string,
  keyId: string,
  provider: string,
): Promise<CachedSealedSecret> {
  const context: EncryptionContext = { orgId: ORG, endpointId: EP, keyId };
  const sealed = await store.sealString(plaintext, context);
  return toCachedSealedSecret({ id: keyId, provider, status: "active", sealed, context });
}

/** A GitHub signature: `sha256=<hex>` HMAC-SHA256 over the raw body (utf8 key). */
async function githubSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

const T = 1_750_000_000; // fixed signing timestamp
const at = (): Date => new Date(T * 1000); // verify clock == signing time (skew 0)

describe("makeVerifyIngest", () => {
  it("verifies a correctly-signed Stripe event against the sealed secret", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const SECRET = "whsec_correct";
    const cached = await seal(store, SECRET, "sec-1");
    const body = `{"id":"evt_abc"}`;
    const sig = await stripeSignature(SECRET, T, body);
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["stripe-signature", `t=${T},v1=${sig}`]],
      provider: "stripe",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [cached],
    });
    expect(outcome.verified).toBe(true);
    expect(outcome.verification).toMatchObject({ ok: true, scheme: "stripe" });
  });

  it("does not verify when the signature was made with a different secret", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const cached = await seal(store, "whsec_real", "sec-1");
    const body = `{"id":"evt_abc"}`;
    const sig = await stripeSignature("whsec_attacker", T, body);
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["stripe-signature", `t=${T},v1=${sig}`]],
      provider: "stripe",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [cached],
    });
    expect(outcome.verified).toBe(false);
    expect(outcome.verification).toMatchObject({ ok: false });
  });

  it("is unverified (no diagnostic) when the provider is unrecognized — capture still proceeds", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const verify = makeVerifyIngest(store, at);
    const outcome = await verify({
      rawBody: enc.encode("{}"),
      headers: [],
      provider: null,
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [],
    });
    expect(outcome.verified).toBe(false);
    expect(outcome.verification).toBeNull();
  });

  it("matches the provider case-insensitively (a secret stored as 'Stripe' still verifies)", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const SECRET = "whsec_correct";
    const context: EncryptionContext = { orgId: ORG, endpointId: EP, keyId: "sec-1" };
    const sealed = await store.sealString(SECRET, context);
    // Registered with non-canonical casing — must not be silently skipped.
    const cached = toCachedSealedSecret({
      id: "sec-1",
      provider: "Stripe",
      status: "active",
      sealed,
      context,
    });
    const body = `{"id":"evt_abc"}`;
    const sig = await stripeSignature(SECRET, T, body);
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["stripe-signature", `t=${T},v1=${sig}`]],
      provider: "stripe",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [cached],
    });
    expect(outcome.verified).toBe(true);
  });

  it("logs (does not silently swallow) a secret that fails to unseal", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const good = await seal(store, "whsec_correct", "sec-good");
    const corrupt: CachedSealedSecret = { ...good, id: "sec-bad", ciphertextB64: "Y29ycnVwdA==" };
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const verify = makeVerifyIngest(store, at, (event, fields) => logs.push({ event, fields }));

    await verify({
      rawBody: enc.encode("{}"),
      // The stripe signature header must be present for verify to engage the stripe provider (and
      // thus attempt — and fail — the unseal); a request with no matching header is skipped entirely.
      headers: [["stripe-signature", `t=${T},v1=deadbeef`]],
      provider: "stripe",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [corrupt],
    });
    expect(logs.some((l) => l.fields.keyId === "sec-bad")).toBe(true); // surfaced, not swallowed
  });

  it("skips a secret that fails to unseal and still verifies against a valid sibling", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const SECRET = "whsec_correct";
    const good = await seal(store, SECRET, "sec-good");
    const corrupt: CachedSealedSecret = { ...good, id: "sec-bad", ciphertextB64: "Y29ycnVwdA==" };
    const body = `{"id":"evt_abc"}`;
    const sig = await stripeSignature(SECRET, T, body);
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["stripe-signature", `t=${T},v1=${sig}`]],
      provider: "stripe",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [corrupt, good], // the corrupt one must not abort verification
    });
    expect(outcome.verified).toBe(true);
  });

  it("verifies against the REGISTERED provider even when header detection picked the wrong one", async () => {
    // The collision case: a GitHub event (x-hub-signature-256) can be mis-detected as another scheme
    // that shares that header. Selection by the endpoint's registered provider fixes it — a wrong
    // detection hint must not stop the registered github secret from verifying.
    const store = new SecretStore(await LocalKmsProvider.generate());
    const SECRET = "gh_secret";
    const cached = await sealAs(store, SECRET, "sec-gh", "github");
    const body = `{"action":"opened"}`;
    const sig = await githubSignature(SECRET, body);
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["x-hub-signature-256", sig]],
      provider: "stripe", // a WRONG detected hint
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [cached],
    });
    expect(outcome.verified).toBe(true);
    expect(outcome.verification).toMatchObject({ ok: true, scheme: "github" });
    expect(outcome.provider).toBe("github"); // names the matched provider authoritatively
  });

  it("verifies against the registered provider when detection found nothing (hint null)", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const SECRET = "gh_secret";
    const cached = await sealAs(store, SECRET, "sec-gh", "github");
    const body = `{"action":"opened"}`;
    const sig = await githubSignature(SECRET, body);
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["x-hub-signature-256", sig]],
      provider: null,
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [cached],
    });
    expect(outcome.verified).toBe(true);
    expect(outcome.provider).toBe("github");
  });

  it("verifies the matching provider on a multi-provider endpoint (stripe + github registered)", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const stripeCached = await sealAs(store, "whsec_multi", "sec-stripe", "stripe");
    const githubCached = await sealAs(store, "gh_multi", "sec-gh", "github");
    const body = `{"action":"opened"}`;
    const sig = await githubSignature("gh_multi", body);
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["x-hub-signature-256", sig]],
      provider: null,
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [stripeCached, githubCached], // both registered; the github-signed event verifies via github
    });
    expect(outcome.verified).toBe(true);
    expect(outcome.provider).toBe("github");
  });
});
