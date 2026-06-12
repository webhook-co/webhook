import type { WebhookScheme } from "./scheme";
import type { VerificationResult } from "./verification";

// One interface, one adapter per scheme (§0.5). Adapters compute over the EXACT
// captured raw bytes, do a constant-time compare, honor each scheme's timestamp-skew
// window, and accept any non-revoked registered secret (rotation). The concrete
// per-provider adapters (Stripe + GitHub first) land in phase 1 behind this seam;
// the freeze fixes the interface so every surface and the inbound verifier agree.

export interface VerifyInput {
  /** The exact captured request bytes — never a re-encoded copy (§0.5). */
  readonly rawBody: Uint8Array;
  /** Ordered, unscrubbed header pairs as received (signatures live here). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** Non-revoked registered secrets for the source, newest first (rotation). */
  readonly secrets: readonly string[];
  /** Verification time; defaults to now. Injected for deterministic tests. */
  readonly now?: Date;
}

export interface VerifyAdapter {
  readonly scheme: WebhookScheme;
  /** The header carrying the signature (e.g. "stripe-signature"). */
  readonly signatureHeader: string;
  /** Frozen timestamp-skew tolerance for this scheme (CLOCK_SKEW_TOLERANCE_SECONDS). */
  readonly toleranceSeconds: number;
  verify(input: VerifyInput): Promise<VerificationResult> | VerificationResult;
}
