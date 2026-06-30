import type { WebhookScheme } from "./scheme";
import type { VerificationResult } from "./verification";

/**
 * A request to fetch a verification key/cert from a REMOTE url — the Tier-3 remote-fetch providers
 * (Kinde/Plaid JWKS, PayPal/SNS certificate URLs) don't ship the public key inline; the receiver fetches
 * it. The adapter builds this spec with the SSRF allowlist derived from operator-registered config (or a
 * hardcoded provider host), and the engine performs the fetch behind a host-pin + timeout + cache + fail-soft.
 */
export interface KeyFetchSpec {
  /** Cache key (e.g. the cert URL, or `kinde:<issuer>:jwks`). */
  readonly cacheKey: string;
  /** The URL to fetch. Its host MUST be allowed by `allowedHosts`, else the fetch is refused (SSRF guard). */
  readonly url: string;
  /**
   * The SSRF allowlist: the url's host must `===` one of these strings (or match the RegExp), else the
   * engine returns null without fetching. This keeps a message-supplied URL from reaching an arbitrary
   * host — the allowlist comes from operator-registered config / a hardcoded provider host, not the message.
   */
  readonly allowedHosts: readonly string[] | RegExp;
  /** HTTP method (default GET). POST is used by Plaid's authenticated key endpoint. */
  readonly method?: "GET" | "POST";
  /** Request body (Plaid's authenticated POST carries client_id/secret/key_id JSON). */
  readonly body?: string;
  /** Extra request headers (e.g. content-type, or Plaid credential headers). */
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  /** Cache TTL in seconds. */
  readonly ttlSeconds: number;
}

/**
 * Fetch the (cached) response-body bytes for a key/cert request — the adapter parses the cert/JWKS/JWK from
 * them. Returns null on ANY failure (SSRF refusal, timeout, non-2xx, network/parse error) so the caller
 * fails-soft to KEY_FETCH_FAILED; it NEVER throws and never blocks the ACK beyond the engine's timeout.
 * Provided by the engine on the ingest path; absent in pure contexts (a remote-fetch provider then can't
 * verify → KEY_FETCH_FAILED).
 */
export type KeyFetcher = (spec: KeyFetchSpec) => Promise<Uint8Array | null>;

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
  /**
   * Fetch a remote verification key/cert (Tier-3 remote-fetch providers). Provided by the engine on the
   * ingest path; absent in pure/test contexts (a remote-fetch adapter then yields KEY_FETCH_FAILED). Tests
   * inject a mock to avoid real I/O.
   */
  readonly fetchKey?: KeyFetcher;
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
