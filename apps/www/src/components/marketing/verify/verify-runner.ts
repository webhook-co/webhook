// The verify-orchestration core for the interactive signature verifier. Runs the REAL browser-safe
// engine (`getAdapterForScheme(...).verify(...)` from @webhook-co/webhooks-spec) entirely client-side:
// the secret, payload, and signature the user pastes NEVER leave the browser (no fetch, no server) — the
// page is a Next static export, so there is no endpoint to send them to. This module is pure logic (no
// React); the UI island wraps it. Unit-tested against real generated signatures.

import { getAdapterForScheme, type VerificationResult } from "@webhook-co/webhooks-spec";
import type { RecipeDescriptor } from "@webhook-co/webhooks-recipes";

export interface VerifyForm {
  /** Provider slug (must be a client-verifiable recipe). */
  readonly provider: string;
  /** The exact raw request body bytes, as text. */
  readonly payload: string;
  /** The signing secret (HMAC) or the provider's public key (asymmetric). Never leaves the browser. */
  readonly secret: string;
  /** The value of the provider's signature header (empty when the signature lives in the body). */
  readonly signatureValue: string;
  /** Extra request headers as `Name: value` lines — the timestamp / id / nonce headers the scheme folds in. */
  readonly extraHeaders: string;
  /** The full request URL (request-context schemes sign it). */
  readonly requestUrl?: string;
  /** The HTTP method (a few request-context schemes sign it). */
  readonly method?: string;
  /** Verification time (ISO). For timestamped schemes, set near the event's timestamp to test the signature
   *  itself rather than tripping the replay-age window. Defaults to now. */
  readonly verificationTime?: string;
}

export interface NormalizedResult {
  readonly status: "verified" | "failed" | "error";
  /** The engine's failure code (e.g. SIGNATURE_MISMATCH, TIMESTAMP_TOO_OLD, MISSING_HEADER). */
  readonly code?: string;
  /** Plain-English explanation of the outcome. */
  readonly explanation: string;
  /** The authenticity strength on success (`signature` for crypto; `token`/`basic` for the non-crypto tier). */
  readonly authenticity?: string;
}

/** Parse a `Name: value` block into ordered header pairs. Blank lines and lines without `:` are skipped. */
export function parseHeaderLines(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name !== "") out.push([name, value]);
  }
  return out;
}

/** Plain-English text for a verification result — honest about what each failure means. */
export function explain(result: VerificationResult): NormalizedResult {
  if (result.ok) {
    const authenticity = result.authenticity;
    return {
      status: "verified",
      authenticity,
      explanation:
        authenticity === "token" || authenticity === "basic"
          ? "Authenticated — the shared token/credential matched. (This provider proves the sender by a shared secret, not a cryptographic payload signature.)"
          : "Verified — the signature is valid for this payload and secret.",
    };
  }
  const reason = result.reason;
  const map: Record<string, string> = {
    MISSING_HEADER:
      "The signature header wasn't present — paste the provider's signature header value.",
    MALFORMED_SIGNATURE:
      "The signature or a required input was malformed — check the header value, prefix, and encoding.",
    UNSUPPORTED_SCHEME: "No adapter matched — pick the provider explicitly.",
    KEY_FETCH_FAILED:
      "This provider verifies against a key fetched from its servers — it can't be checked in the browser.",
    TIMESTAMP_TOO_OLD:
      "The signed timestamp is older than the replay window. Set the verification time near the event's timestamp to test the signature itself.",
    TIMESTAMP_IN_FUTURE: "The signed timestamp is in the future relative to the verification time.",
    NO_MATCHING_KEY:
      "No usable secret matched — check the secret is the right one (and in the right form).",
    WRONG_SECRET: "The signature didn't match — most likely the wrong signing secret.",
    RAW_BODY_MODIFIED:
      "The signature was valid for different bytes — the body was probably re-encoded or altered in transit.",
    PROXY_MUTATED_BYTES:
      "The signature was valid for slightly different bytes — a proxy likely mutated the body.",
    SIGNATURE_MISMATCH: "The signature did not match the payload and secret.",
  };
  return {
    status: "failed",
    code: reason.code,
    explanation: map[reason.code] ?? "Verification failed.",
  };
}

/** Run verification entirely in the browser. Never throws — a bad input becomes an `error` result. */
export async function runVerify(
  form: VerifyForm,
  recipe: RecipeDescriptor,
): Promise<NormalizedResult> {
  try {
    if (!recipe.clientVerifiable) {
      return {
        status: "error",
        explanation:
          "This provider can't be verified in the browser (its key is fetched from the provider's servers).",
      };
    }
    const adapter = getAdapterForScheme(form.provider as never);
    if (!adapter) {
      return { status: "error", explanation: `Unknown provider "${form.provider}".` };
    }

    const headers: Array<[string, string]> = [];
    // The signature header (skipped for sig-in-body schemes, where the signature is inside the payload).
    if (recipe.signatureHeader && form.signatureValue.trim() !== "") {
      headers.push([recipe.signatureHeader, form.signatureValue.trim()]);
    }
    headers.push(...parseHeaderLines(form.extraHeaders));

    const now = form.verificationTime ? new Date(form.verificationTime) : new Date();

    const result = await adapter.verify({
      rawBody: new TextEncoder().encode(form.payload),
      headers,
      secrets: form.secret === "" ? [] : [form.secret],
      requestUrl: form.requestUrl?.trim() || undefined,
      method: form.method?.trim() || undefined,
      now,
    });
    return explain(result);
  } catch (e) {
    return { status: "error", explanation: `Could not run verification: ${(e as Error).message}` };
  }
}
