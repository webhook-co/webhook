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

import { revealIngestTokenCore } from "./ingest-token-seal";
import type { ReadSealedIngestTokenResult } from "./ingest-token-seal";

const SEALED: ReadSealedIngestTokenResult = {
  found: true,
  sealed: {
    sealed: {
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array([2]),
      wrapped: { wrappedDek: new Uint8Array([3]), kekRef: "kek" },
      envelopeVersion: 1,
    },
    context: { orgId: "o", endpointId: "e", keyId: "k" },
  },
};

describe("revealIngestTokenCore", () => {
  it("unseals + parses the wrapper and returns the token on success", async () => {
    const out = await revealIngestTokenCore(
      { read: async () => SEALED, unseal: async () => serializeIngestToken("whep_live") },
      "o",
      "e",
    );
    expect(out).toEqual({ found: true, token: "whep_live" });
  });

  it("returns {found:false} for an unknown/cross-org endpoint (→ NOT_FOUND) and never unseals", async () => {
    let unsealed = false;
    const out = await revealIngestTokenCore(
      {
        read: async () => ({ found: false }),
        unseal: async () => {
          unsealed = true;
          return "";
        },
      },
      "o",
      "e",
    );
    expect(out).toEqual({ found: false, token: null });
    expect(unsealed).toBe(false); // no blob, nothing to unseal
  });

  it("returns {found:true, token:null} for a visible endpoint with NO recoverable copy (rotate to reveal)", async () => {
    const out = await revealIngestTokenCore(
      { read: async () => ({ found: true, sealed: null }), unseal: async () => "unused" },
      "o",
      "e",
    );
    expect(out).toEqual({ found: true, token: null });
  });

  it("FAILS CLOSED: a non-ingest-token plaintext (wrong kind) yields token:null, never a bogus URL", async () => {
    const out = await revealIngestTokenCore(
      {
        read: async () => SEALED,
        // e.g. a provider-secret blob mistakenly reaching the ingest unsealer
        unseal: async () => JSON.stringify({ kind: "verify_token", token: "x" }),
      },
      "o",
      "e",
    );
    expect(out).toEqual({ found: true, token: null });
  });

  it("propagates an unseal THROW (KMS fault) — a transient error must not be conflated with 'no copy'", async () => {
    await expect(
      revealIngestTokenCore(
        { read: async () => SEALED, unseal: async () => Promise.reject(new Error("kms down")) },
        "o",
        "e",
      ),
    ).rejects.toThrow(/kms down/);
  });
});
