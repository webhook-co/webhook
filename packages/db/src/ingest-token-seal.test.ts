import { describe, expect, it } from "vitest";

import { parseIngestToken, serializeIngestToken } from "./ingest-token-seal";

// The typed plaintext wrapper for the SEALED, recoverable copy of an endpoint's ingest token (S8-remainder,
// decision-0018). The token is sealed inside a typed blob so cross-kind confusion fails CLOSED at the
// plaintext layer: even if a future generic reader hands the ingest unsealer a provider-secret / signing
// blob (or vice versa), parseIngestToken rejects anything that isn't an ingest-token blob. Mirrors the
// serializeBraintreePublicKey / serializeProviderSecretPlaintext precedent (a kind-tagged JSON envelope).

describe("serializeIngestToken / parseIngestToken", () => {
  it("round-trips: serialize then parse recovers the original token", () => {
    const blob = serializeIngestToken("whep_abc123DEF456");
    expect(parseIngestToken(blob)).toBe("whep_abc123DEF456");
  });

  it("serializes to a kind-tagged JSON envelope (not the bare token)", () => {
    const blob = serializeIngestToken("whep_tok");
    expect(blob).not.toBe("whep_tok");
    expect(JSON.parse(blob)).toEqual({ kind: "ingest_token", token: "whep_tok" });
  });

  it("returns null for a BARE token (not JSON) — a raw string is never mistaken for the blob", () => {
    expect(parseIngestToken("whep_abc123")).toBeNull();
  });

  it("returns null for a foreign-kind blob (cross-kind guard fails closed)", () => {
    // A provider-secret / braintree-public-key style blob must NOT parse as an ingest token.
    expect(
      parseIngestToken(JSON.stringify({ kind: "braintree_public_key", publicKey: "x" })),
    ).toBeNull();
    expect(parseIngestToken(JSON.stringify({ kind: "verify_token", token: "x" }))).toBeNull();
    expect(parseIngestToken(JSON.stringify({ kind: "signing_secret", token: "x" }))).toBeNull();
  });

  it("returns null for malformed JSON, wrong shape, or an empty/non-string token", () => {
    expect(parseIngestToken("{not json")).toBeNull();
    expect(parseIngestToken(JSON.stringify(["ingest_token", "x"]))).toBeNull();
    expect(parseIngestToken(JSON.stringify({ kind: "ingest_token" }))).toBeNull();
    expect(parseIngestToken(JSON.stringify({ kind: "ingest_token", token: "" }))).toBeNull();
    expect(parseIngestToken(JSON.stringify({ kind: "ingest_token", token: 123 }))).toBeNull();
    expect(parseIngestToken(JSON.stringify(null))).toBeNull();
  });
});
