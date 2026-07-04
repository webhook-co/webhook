import { describe, expect, it } from "vitest";

import {
  BRAINTREE_PUBLIC_KEY_PROVIDERS,
  CONFIGURED_HEADER_PROVIDERS,
  PROVIDERS,
  SW_SECRET_PROVIDERS,
  VERIFY_TOKEN_PROVIDERS,
  type Provider,
} from "./index";
import { validateProviderSecretShape } from "./provider-secret-shape";

// Representative members picked from the live sets (robust to config changes) + one provider outside every
// special set (a plain HMAC/bespoke provider that gets no shape refine).
const SW = [...SW_SECRET_PROVIDERS][0]!;
const HEADER = [...CONFIGURED_HEADER_PROVIDERS][0]!;
const VT = [...VERIFY_TOKEN_PROVIDERS][0]!; // "meta"
const BT = [...BRAINTREE_PUBLIC_KEY_PROVIDERS][0]!; // "braintree"
const PLAIN = PROVIDERS.find(
  (p) =>
    !SW_SECRET_PROVIDERS.has(p) &&
    !CONFIGURED_HEADER_PROVIDERS.has(p) &&
    !VERIFY_TOKEN_PROVIDERS.has(p) &&
    !BRAINTREE_PUBLIC_KEY_PROVIDERS.has(p),
) as Provider;

describe("validateProviderSecretShape — verify_token", () => {
  it("accepts a verify_token for a verify-token-handshake provider", () => {
    expect(
      validateProviderSecretShape({ provider: VT, kind: "verify_token", secret: "any-opaque" }),
    ).toEqual({
      ok: true,
    });
  });

  it("rejects a verify_token for a provider with no verify-token handshake (path: provider)", () => {
    const r = validateProviderSecretShape({ provider: PLAIN, kind: "verify_token", secret: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.path).toBe("provider");
      expect(r.message).toMatch(/verify-token handshake/i);
    }
  });

  it("does NOT apply signing-secret shape refines to a verify_token (opaque)", () => {
    // A verify_token bypasses the SW/header shape checks even for an SW provider.
    expect(
      validateProviderSecretShape({
        provider: VT,
        kind: "verify_token",
        secret: "!!!not-base64!!!",
      }),
    ).toEqual({ ok: true });
  });
});

describe("validateProviderSecretShape — braintree_public_key", () => {
  it("accepts a braintree_public_key for braintree", () => {
    expect(
      validateProviderSecretShape({ provider: BT, kind: "braintree_public_key", secret: "pubkey" }),
    ).toEqual({ ok: true });
  });

  it("rejects a braintree_public_key for a non-braintree provider (path: provider)", () => {
    const r = validateProviderSecretShape({
      provider: PLAIN,
      kind: "braintree_public_key",
      secret: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.path).toBe("provider");
      expect(r.message).toMatch(/bt_challenge handshake/i);
    }
  });
});

describe("validateProviderSecretShape — signing_secret (SW-family)", () => {
  it("accepts valid base64 key material (whsec_-prefixed) for an SW provider", () => {
    expect(
      validateProviderSecretShape({
        provider: SW,
        kind: "signing_secret",
        secret: "whsec_c2VjcmV0",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a non-base64 secret for an SW provider (path: secret)", () => {
    const r = validateProviderSecretShape({
      provider: SW,
      kind: "signing_secret",
      secret: "!!!not-base64!!!",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.path).toBe("secret");
      expect(r.message).toMatch(/standard webhooks/i);
    }
  });
});

describe("validateProviderSecretShape — signing_secret (configured-header)", () => {
  it("accepts a valid JSON {header,token} for a configured-header provider", () => {
    expect(
      validateProviderSecretShape({
        provider: HEADER,
        kind: "signing_secret",
        secret: JSON.stringify({ header: "X-Api-Key", token: "abc123" }),
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a malformed configured-header secret (path: secret)", () => {
    const r = validateProviderSecretShape({
      provider: HEADER,
      kind: "signing_secret",
      secret: "just-a-plain-string",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.path).toBe("secret");
      expect(r.message).toMatch(/json secret/i);
    }
  });
});

describe("validateProviderSecretShape — signing_secret (plain / no refine)", () => {
  it("accepts any non-empty secret for a provider outside every special set", () => {
    expect(
      validateProviderSecretShape({
        provider: PLAIN,
        kind: "signing_secret",
        secret: "any-hmac-secret",
      }),
    ).toEqual({ ok: true });
  });

  it("treats the default kind (signing_secret) identically", () => {
    expect(
      validateProviderSecretShape({
        provider: SW,
        kind: "signing_secret",
        secret: "whsec_c2VjcmV0",
      }),
    ).toEqual({ ok: true });
  });
});
