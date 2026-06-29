import type { WebhookScheme } from "./scheme";
import type { VerificationResult } from "./verification";

// One interface, one adapter per scheme. Adapters compute over the EXACT
// captured raw bytes, do a constant-time compare, honor each scheme's timestamp-skew
// window, and accept any non-revoked registered secret (rotation). The concrete
// per-provider adapters (Stripe + GitHub first) land behind this seam;
// this interface is fixed so every surface and the inbound verifier agree.

export interface VerifyInput {
  /** The exact captured request bytes — never a re-encoded copy. */
  readonly rawBody: Uint8Array;
  /** Ordered, unscrubbed header pairs as received (signatures live here). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** Non-revoked registered secrets for the source, newest first (rotation). */
  readonly secrets: readonly string[];
  /**
   * The full request URL as received (scheme+host+path+query). Some Tier-2 providers sign over it
   * (Square/Twilio/Trello) or a component of it (Contentful path, Mercado Pago query). Optional: only
   * schemes whose config references a `url`/`queryParam` message part need it (absent ⇒ MALFORMED).
   */
  readonly requestUrl?: string;
  /** The request HTTP method (e.g. "POST"). Signed by a few Tier-2 providers (HubSpot, Contentful). */
  readonly method?: string;
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
