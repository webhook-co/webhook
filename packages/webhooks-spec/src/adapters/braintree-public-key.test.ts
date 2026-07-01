import { describe, expect, it } from "vitest";

import {
  BRAINTREE_PUBLIC_KEY_PROVIDERS,
  parseBraintreePublicKey,
  serializeBraintreePublicKey,
} from "./braintree-public-key";

// Braintree's `?bt_challenge=` subscription handshake needs the integration PUBLIC key in the response
// (`<public_key>|<hmac>`), which POST verification never uses — so it is sealed as a TYPED blob
// `{kind:"braintree_public_key",publicKey}` under the SAME `braintree` slug as the private-key signing
// secret, distinguishable at unseal. The db SERIALIZES it before sealing; the engine PARSES it after
// unsealing (and the POST verify SKIPS it) — all single-sourced here.

describe("braintree public-key secret blob", () => {
  it("round-trips: serialize → parse returns the original public key", () => {
    const publicKey = "integration_public_key";
    expect(parseBraintreePublicKey(serializeBraintreePublicKey(publicKey))).toBe(publicKey);
  });

  it("serializes to the typed JSON blob with a `braintree_public_key` kind tag", () => {
    expect(JSON.parse(serializeBraintreePublicKey("pk_abc"))).toEqual({
      kind: "braintree_public_key",
      publicKey: "pk_abc",
    });
  });

  it("parse returns null for a BARE private-key signing secret (coexists under the same slug)", () => {
    expect(parseBraintreePublicKey("integration_private_key")).toBeNull();
    expect(parseBraintreePublicKey("just-a-plain-string")).toBeNull();
  });

  it("parse returns null for malformed JSON and for the wrong kind / shape", () => {
    expect(parseBraintreePublicKey("{not json")).toBeNull();
    expect(
      parseBraintreePublicKey(JSON.stringify({ kind: "verify_token", publicKey: "x" })),
    ).toBeNull(); // wrong kind (a Meta/eBay verify-token blob must NOT be read as a braintree public key)
    expect(parseBraintreePublicKey(JSON.stringify({ kind: "braintree_public_key" }))).toBeNull(); // no key
    expect(
      parseBraintreePublicKey(JSON.stringify({ kind: "braintree_public_key", publicKey: "" })),
    ).toBeNull(); // empty
    expect(
      parseBraintreePublicKey(JSON.stringify({ kind: "braintree_public_key", publicKey: 42 })),
    ).toBeNull(); // non-string
    expect(parseBraintreePublicKey(JSON.stringify(["braintree_public_key", "x"]))).toBeNull(); // array
  });
});

describe("BRAINTREE_PUBLIC_KEY_PROVIDERS", () => {
  it("includes braintree and excludes a non-handshake provider", () => {
    expect(BRAINTREE_PUBLIC_KEY_PROVIDERS.has("braintree")).toBe(true);
    expect(BRAINTREE_PUBLIC_KEY_PROVIDERS.has("stripe")).toBe(false);
  });
});
