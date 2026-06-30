import { z } from "zod";

import { WebhookSchemeSchema, type WebhookScheme } from "./scheme";

// The verification result is a typed DISCRIMINATED UNION, not a boolean. One
// definition consumed by correctness code and every surface (CLI/web/MCP), stored on
// the event as the structured `verification` field so an inspection long after the
// fact can still explain a failure. Heuristic sub-diagnoses MUST carry `confidence`
// and never assert a cause we can't back — honesty over cleverness.

const Confidence = z.enum(["low", "medium"]);

/** Why a verification attempt failed. Discriminated on `code`. */
export const VerificationFailureSchema = z.discriminatedUnion("code", [
  // structural — inputs to even attempt verification are absent/garbled
  z.object({ code: z.literal("MISSING_HEADER"), header: z.string(), scheme: WebhookSchemeSchema }),
  z.object({
    code: z.literal("MALFORMED_SIGNATURE"),
    detail: z.string(),
    scheme: WebhookSchemeSchema,
  }),
  z.object({ code: z.literal("UNSUPPORTED_SCHEME"), observedHeaders: z.array(z.string()) }),
  // The remote verification key/cert could not be fetched (SSRF refusal, timeout, non-2xx, parse error)
  // for a Tier-3 remote-fetch provider — fail-soft, the event is captured unverified, never dropped.
  z.object({ code: z.literal("KEY_FETCH_FAILED"), scheme: WebhookSchemeSchema }),
  // temporal
  z.object({
    code: z.literal("TIMESTAMP_TOO_OLD"),
    skewSeconds: z.number(),
    toleranceSeconds: z.number(),
  }),
  z.object({
    code: z.literal("TIMESTAMP_IN_FUTURE"),
    skewSeconds: z.number(),
    toleranceSeconds: z.number(),
  }),
  // cryptographic — HMAC didn't match; the discriminator is our best heuristic at "why"
  z.object({ code: z.literal("NO_MATCHING_KEY"), keysTried: z.number().int().nonnegative() }),
  z.object({ code: z.literal("WRONG_SECRET"), confidence: Confidence }),
  z.object({
    code: z.literal("RAW_BODY_MODIFIED"),
    confidence: Confidence,
    // Keep this enum in lockstep with the probes in adapters/shared.ts that actually
    // emit it — only these two are produced today. Add a value here only alongside a probe.
    evidence: z.enum(["trailing_whitespace", "reencoded_json"]).optional(),
  }),
  z.object({ code: z.literal("PROXY_MUTATED_BYTES"), confidence: Confidence }),
  // generic: no confident sub-diagnosis
  z.object({ code: z.literal("SIGNATURE_MISMATCH") }),
]);
export type VerificationFailure = z.infer<typeof VerificationFailureSchema>;

/**
 * The STRENGTH of an authentic result. The vast majority of providers cryptographically sign — that's the
 * absent default ("signature"). The Tier-4 providers (GitLab token, HTTP Basic auth, etc.) only prove the
 * source by a shared STATIC token / credential — a weaker, non-cryptographic guarantee surfaced as a
 * distinct "authenticated" (not "verified") badge. Optional so every existing crypto result is unchanged
 * (absent ⇒ "signature"); only token/basic carry it.
 */
export const Authenticity = z.enum(["token", "basic"]);
export type Authenticity = z.infer<typeof Authenticity>;

export const VerificationResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    keyId: z.string(),
    scheme: WebhookSchemeSchema,
    authenticity: Authenticity.optional(),
  }),
  z.object({ ok: z.literal(false), reason: VerificationFailureSchema }),
]);
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// Convenience constructors so adapters and surfaces build results without restating
// the shape (and so a refactor of the union is caught at every call site).
export function verificationOk(
  keyId: string,
  scheme: WebhookScheme,
  authenticity: "signature" | Authenticity = "signature",
): VerificationResult {
  // Omit the field for cryptographic results so every existing ok result stays byte-identical; only the
  // weaker Tier-4 (token/basic) results carry an explicit authenticity.
  return authenticity === "signature"
    ? { ok: true, keyId, scheme }
    : { ok: true, keyId, scheme, authenticity };
}
export function verificationFailed(reason: VerificationFailure): VerificationResult {
  return { ok: false, reason };
}
