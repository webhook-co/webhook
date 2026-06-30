// A factory for the Tier-4 NON-CRYPTOGRAPHIC authenticity providers: those that prove the source by a
// shared STATIC token (header / JSON body field) or HTTP Basic credentials, compared constant-time to the
// registered secret. There is NO signature over the payload, so a match is surfaced as the weaker
// "authenticated" status (authenticity "token"/"basic"), NOT cryptographic "verified".
//
// Four token sources cover all of them:
//   - header           : a FIXED header carries the token (GitLab `X-Gitlab-Token`); secret = the token.
//   - jsonField        : a body JSON field carries the token (Microsoft Graph `value[0].clientState`).
//   - basicAuth        : `Authorization: Basic b64(user:pass)`; secret = the plain `user:pass`.
//   - configuredHeader : the operator CHOSE the header name (Okta/BigCommerce/Datadog/Brevo); the secret
//                        is a JSON `{ "header": "...", "token": "..." }` so the loop is secret-driven.
//
// (The MS-Graph `validationToken` echo + Okta `X-Okta-Verification-Challenge` are one-time subscription
// handshakes handled on the ingest path, separate from this per-message authenticity check.)

import { b64ToBytes, timingSafeEqual, utf8Decoder, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import {
  type Authenticity,
  verificationFailed,
  verificationOk,
  type VerificationResult,
} from "../../verification";
import type { Provider } from "../config";
import { findHeader } from "../shared";

export type TokenSource =
  | { readonly kind: "header"; readonly name: string }
  | { readonly kind: "jsonField"; readonly path: string }
  | { readonly kind: "basicAuth" }
  | { readonly kind: "configuredHeader" };

export interface TokenAuthConfig {
  readonly slug: Provider;
  readonly source: TokenSource;
  /** The strength to report on success ("token" for token-equality, "basic" for Basic auth). */
  readonly authenticity: Authenticity;
  /** For header detection; "" for body / operator-configured-header providers (F0 runs them regardless). */
  readonly signatureHeader: string;
  readonly toleranceSeconds: number;
}

/**
 * Whether a registered secret for an operator-configured-header (Tier-4) provider is USABLE: a JSON
 * `{ header, token }` with both a non-empty header name and a non-empty token. Single-sources the exact
 * criterion the `configuredHeader` factory branch enforces, so the contract can reject a malformed secret
 * at REGISTRATION rather than letting it store fine yet verify as NO_MATCHING_KEY forever (indistinguishable
 * from "no secret") — mirrors `isUsableStandardWebhooksSecret`.
 */
export function isUsableConfiguredHeaderSecret(secret: string): boolean {
  let cfg: { header?: unknown; token?: unknown };
  try {
    cfg = JSON.parse(secret) as { header?: unknown; token?: unknown };
  } catch {
    return false;
  }
  return (
    typeof cfg.header === "string" &&
    typeof cfg.token === "string" &&
    cfg.header.length > 0 &&
    cfg.token.length > 0
  );
}

/** Constant-time equality over the UTF-8 bytes (the registered token/credential is the secret). */
function tokenEqual(presented: string, secret: string): boolean {
  return timingSafeEqual(utf8Encoder.encode(presented), utf8Encoder.encode(secret));
}

/** Read a scalar string at a dot-path in the JSON body (numeric segments index arrays). null if absent. */
function jsonFieldValue(rawBody: Uint8Array, path: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decoder.decode(rawBody));
  } catch {
    return null;
  }
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null) return null;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" ? value : null;
}

/** Decode `Authorization: Basic <b64>` to the "user:pass" string, or null. */
function basicAuthCredential(input: VerifyInput): string | null {
  const auth = findHeader(input.headers, "authorization");
  if (auth === undefined || !auth.toLowerCase().startsWith("basic ")) return null;
  const bytes = b64ToBytes(auth.slice("basic ".length).trim());
  return bytes === null ? null : utf8Decoder.decode(bytes);
}

export function makeTokenAuthAdapter(config: TokenAuthConfig): VerifyAdapter {
  const { slug, source, authenticity, signatureHeader, toleranceSeconds } = config;

  function verify(input: VerifyInput): VerificationResult {
    // Operator-configured-header providers carry the header NAME in the registered secret → secret-driven.
    if (source.kind === "configuredHeader") {
      let sawUsableSecret = false;
      for (let i = 0; i < input.secrets.length; i++) {
        let cfg: { header?: unknown; token?: unknown };
        try {
          cfg = JSON.parse(input.secrets[i]!) as { header?: unknown; token?: unknown };
        } catch {
          continue;
        }
        // An empty header NAME or empty token is UNUSABLE — skip it (matching the fixed-location path's
        // empty-secret skip below). Otherwise an operator's `{header, token:""}` misconfiguration would
        // let an attacker forge a match by sending an empty header value (tokenEqual("","") is true).
        if (
          typeof cfg.header !== "string" ||
          typeof cfg.token !== "string" ||
          cfg.header.length === 0 ||
          cfg.token.length === 0
        ) {
          continue;
        }
        sawUsableSecret = true;
        const presented = findHeader(input.headers, cfg.header);
        if (presented !== undefined && tokenEqual(presented, cfg.token)) {
          return verificationOk(`secret_${i}`, slug, authenticity);
        }
      }
      return sawUsableSecret
        ? verificationFailed({ code: "SIGNATURE_MISMATCH" })
        : verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    }

    // Fixed-location providers: extract the presented token once, then compare to each registered secret.
    let presented: string | null;
    if (source.kind === "header") {
      const value = findHeader(input.headers, source.name);
      if (value === undefined) {
        return verificationFailed({ code: "MISSING_HEADER", header: source.name, scheme: slug });
      }
      presented = value;
    } else if (source.kind === "basicAuth") {
      presented = basicAuthCredential(input);
      if (presented === null) {
        return verificationFailed({
          code: "MISSING_HEADER",
          header: "authorization",
          scheme: slug,
        });
      }
    } else {
      presented = jsonFieldValue(input.rawBody, source.path);
      if (presented === null) {
        return verificationFailed({
          code: "MALFORMED_SIGNATURE",
          detail: `missing ${source.path}`,
          scheme: slug,
        });
      }
    }

    let sawUsableSecret = false;
    for (let i = 0; i < input.secrets.length; i++) {
      const secret = input.secrets[i]!;
      if (secret.length === 0) continue;
      sawUsableSecret = true;
      if (tokenEqual(presented, secret)) return verificationOk(`secret_${i}`, slug, authenticity);
    }
    return sawUsableSecret
      ? verificationFailed({ code: "SIGNATURE_MISMATCH" })
      : verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
  }

  return { scheme: slug, signatureHeader, toleranceSeconds, verify };
}
