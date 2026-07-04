import { SW_SECRET_PROVIDERS, type Provider } from "./adapters/config";
import { isUsableStandardWebhooksSecret } from "./adapters/shared";
import { BRAINTREE_PUBLIC_KEY_PROVIDERS } from "./adapters/braintree-public-key";
import { CONFIGURED_HEADER_PROVIDERS } from "./adapters/bespoke/token-auth-providers";
import { isUsableConfiguredHeaderSecret } from "./adapters/bespoke/token-auth";
import { VERIFY_TOKEN_PROVIDERS } from "./adapters/verify-token";

// The single source of provider-secret shape validation, lifted verbatim from the `endpoints.addProviderSecret`
// contract superRefine so EVERY surface (api/mcp/web) — and the shared db registration core — validates
// identically. Pure + zod-free: the contract superRefine translates a failure to `ctx.addIssue`, the db core
// throws a `VALIDATION_ERROR` CapabilityFault. A value that matches an alphabet but isn't usable (a base64
// length ≡1 mod 4 paste, hex, a malformed configured-header JSON) is rejected up front — otherwise it stores
// fine yet decodes to nothing and verifies as NO_MATCHING_KEY forever (indistinguishable from "no secret").

/** The KIND of secret being registered under a provider slug. */
export type ProviderSecretKind = "signing_secret" | "verify_token" | "braintree_public_key";

export type ProviderSecretShapeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly path: "provider" | "secret"; readonly message: string };

export interface ProviderSecretShapeInput {
  readonly provider: Provider;
  readonly kind: ProviderSecretKind;
  readonly secret: string;
}

/**
 * Validate that `secret` has the right SHAPE for `(provider, kind)`. Returns `{ok:true}` or a single
 * `{ok:false, path, message}` (the first failing check), mirroring the contract superRefine's messages +
 * paths exactly.
 */
export function validateProviderSecretShape(
  input: ProviderSecretShapeInput,
): ProviderSecretShapeResult {
  const { provider, kind, secret } = input;

  // A verify-token is an OPAQUE user-chosen string (no base64/JSON shape), valid only for a provider that
  // does a verify-token handshake — so it bypasses the signing-secret shape refines below.
  if (kind === "verify_token") {
    if (!VERIFY_TOKEN_PROVIDERS.has(provider)) {
      return {
        ok: false,
        path: "provider",
        message:
          "this provider has no verify-token handshake; omit kind (or use signing_secret) to register a signing secret",
      };
    }
    return { ok: true };
  }

  // A braintree_public_key is an OPAQUE integration public key, valid only for a provider that answers the
  // bt_challenge handshake — so it also bypasses the signing-secret refines.
  if (kind === "braintree_public_key") {
    if (!BRAINTREE_PUBLIC_KEY_PROVIDERS.has(provider)) {
      return {
        ok: false,
        path: "provider",
        message:
          "this provider has no bt_challenge handshake; omit kind (or use signing_secret) to register a signing secret",
      };
    }
    return { ok: true };
  }

  // signing_secret: a Standard-Webhooks-family secret is base64 key material (optionally whsec_-prefixed).
  if (SW_SECRET_PROVIDERS.has(provider) && !isUsableStandardWebhooksSecret(secret)) {
    return {
      ok: false,
      path: "secret",
      message:
        "a Standard Webhooks secret must be base64 key material (optionally whsec_-prefixed)",
    };
  }

  // A Tier-4 operator-configured-header provider's secret is a JSON `{header, token}`.
  if (CONFIGURED_HEADER_PROVIDERS.has(provider) && !isUsableConfiguredHeaderSecret(secret)) {
    return {
      ok: false,
      path: "secret",
      message:
        'this provider expects a JSON secret {"header":"...","token":"..."} with a non-empty header name and token',
    };
  }

  return { ok: true };
}
