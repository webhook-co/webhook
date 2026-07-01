import { toCachedSealedSecret, type CachedSealedSecret } from "@webhook-co/db";
import {
  LocalKmsProvider,
  SecretStore,
  serializeBraintreePublicKey,
  serializeVerifyTokenSecret,
  type EncryptionContext,
} from "@webhook-co/shared";
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

/** A Braintree `bt_signature` hex value: HMAC-SHA1 over the payload, keyed by SHA-1(secret) (sha1-secret). */
async function braintreeSigHex(secret: string, payload: string): Promise<string> {
  const sha1Key = new Uint8Array(await crypto.subtle.digest("SHA-1", enc.encode(secret)));
  const key = await crypto.subtle.importKey(
    "raw",
    sha1Key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

  it("does NOT accept a meta verify-token blob as a POST signing key (verification-downgrade guard, ADR-0086)", async () => {
    // A Meta endpoint holds TWO secrets under `meta`: the app secret (POST signer) + a GET-handshake
    // verify-token, sealed as a typed blob. The verify-token is lower-assurance (user-chosen, sent by Meta
    // in cleartext in the hub.verify_token URL during setup). An attacker who learns it must NOT be able to
    // forge a `verified` meta webhook by HMAC-ing the body with the (public-wrapper) blob string. The verify
    // path MUST skip verify-token blobs as candidate keys.
    const store = new SecretStore(await LocalKmsProvider.generate());
    const blob = serializeVerifyTokenSecret("weak-hub-verify-token");
    const vt = await sealAs(store, blob, "sec-vt", "meta");
    const body = `{"object":"page","entry":[]}`;
    const forged = await githubSignature(blob, body); // sha256=<hex>, Meta's x-hub-signature-256 format
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["x-hub-signature-256", forged]],
      provider: "meta",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [vt],
    });
    expect(outcome.verified).toBe(false); // a verify-token blob is NEVER a signing key
  });

  it("still verifies a real meta webhook when a verify-token coexists under `meta` (skips only the blob)", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const appSecret = "real-meta-app-secret";
    const app = await sealAs(store, appSecret, "sec-app", "meta");
    const vt = await sealAs(store, serializeVerifyTokenSecret("vt"), "sec-vt", "meta");
    const body = `{"object":"page","entry":[1]}`;
    const sig = await githubSignature(appSecret, body); // signed with the REAL app secret
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["x-hub-signature-256", sig]],
      provider: "meta",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [vt, app], // the verify-token is present but skipped; the app secret matches
    });
    expect(outcome.verified).toBe(true);
    expect(outcome.provider).toBe("meta");
  });

  it("does NOT accept a braintree public-key blob as a POST signing key (verification-downgrade guard)", async () => {
    // A braintree endpoint holds TWO secrets under `braintree`: the private-key signing secret + the
    // integration PUBLIC key (a typed blob, for the `bt_challenge` handshake). The public key is PUBLIC, so
    // the deterministic blob string is attacker-derivable — if the verify path tried it as a candidate key,
    // anyone knowing the public key could forge a `verified` braintree event (`bt_signature` = HMAC keyed by
    // SHA1(blobString)). The verify path MUST skip braintree-public-key blobs as candidate keys.
    const store = new SecretStore(await LocalKmsProvider.generate());
    const blob = serializeBraintreePublicKey("integration_public_key"); // gitleaks:allow — fake fixture
    const pk = await sealAs(store, blob, "sec-btpk", "braintree");
    const payload = "attacker-forged-bt-payload";
    const forged = await braintreeSigHex(blob, payload); // key = the PUBLIC blob string (derivable)
    const body = `bt_signature=${encodeURIComponent(`integration_public_key|${forged}`)}&bt_payload=${payload}`;
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["content-type", "application/x-www-form-urlencoded"]],
      provider: "braintree",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [pk],
    });
    expect(outcome.verified).toBe(false); // a public-key blob is NEVER a signing key
  });

  it("still verifies a real braintree webhook when a public-key blob coexists (skips only the blob)", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const privateKey = "integration_private_key"; // gitleaks:allow — fake fixture
    const priv = await sealAs(store, privateKey, "sec-btpriv", "braintree");
    const pk = await sealAs(
      store,
      serializeBraintreePublicKey("integration_public_key"), // gitleaks:allow — fake fixture
      "sec-btpk",
      "braintree",
    );
    const payload = "real-bt-payload";
    const sig = await braintreeSigHex(privateKey, payload); // signed with the REAL private key
    const body = `bt_signature=${encodeURIComponent(`integration_public_key|${sig}`)}&bt_payload=${payload}`;
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["content-type", "application/x-www-form-urlencoded"]],
      provider: "braintree",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [pk, priv], // the public-key blob is present but skipped; the private key matches
    });
    expect(outcome.verified).toBe(true);
  });

  it("REJECTS a bt_payload in the bt_challenge oracle domain (handshake-replay forgery guard)", async () => {
    // The REAL attack (needs NO stolen secret): the bt_challenge handshake HMACs a hex nonce under
    // SHA1(private_key) — the SAME key that verifies bt_payload. An attacker GETs a handshake response
    // `pubkey|HMAC(nonce)` and replays it as `bt_signature=pubkey|HMAC(nonce)` over `bt_payload=nonce`. The
    // HMAC is genuine (Braintree's own key), so constraining only the challenge shape is NOT enough — the
    // verify path MUST reject any bt_payload in the nonce domain (^[a-f0-9]{20,40}$). Real bt_payloads are
    // long base64 XML, never a short hex string, so this never rejects a genuine event.
    const store = new SecretStore(await LocalKmsProvider.generate());
    const privateKey = "integration_private_key"; // gitleaks:allow — fake fixture
    const priv = await sealAs(store, privateKey, "sec-btpriv", "braintree");
    const nonce = "20f9f8ed05f77439fe955c977e4c8a53"; // a valid bt_challenge value (hex, ≤40 chars)
    const oracleSig = await braintreeSigHex(privateKey, nonce); // == the handshake response HMAC (genuine)
    const body = `bt_signature=${encodeURIComponent(`integration_public_key|${oracleSig}`)}&bt_payload=${nonce}`;
    const verify = makeVerifyIngest(store, at);

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["content-type", "application/x-www-form-urlencoded"]],
      provider: "braintree",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [priv],
    });
    expect(outcome.verified).toBe(false); // a genuinely-HMAC'd oracle-domain payload is STILL rejected
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
