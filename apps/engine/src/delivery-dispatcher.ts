// Server-side remote delivery + its AUTHORITATIVE connect-time SSRF guard (ADR-0081). The engine is the
// single egress chokepoint: apps/api resolves the registered destination + the stored event under RLS and
// RPCs `env.DELIVERY_DISPATCHER.deliver(...)`; only the engine performs the user-controlled outbound POST.
//
// guardedDeliver is the pure pipeline (deps injected) so the whole guard — structural reject, resolve-and-
// validate EVERY resolved address, fail-closed, the H1 key re-derivation, redirect:manual, the header
// filter — is provable with fakes under the workerd test pool. The DeliveryDispatcher WorkerEntrypoint just
// wires the real R2 / DoH / fetch. NOTE: the resolve→fetch gap is an irreducible DNS-rebinding TOCTOU on
// workerd (no IP-pinning / SNI override); the guard is authoritative defense-in-depth atop the platform's
// public-only egress default — the residual is tracked internally, not published.

import {
  canonicalizeAndValidateUrl,
  filterDeliveryHeaders,
  isBlockedIp,
  payloadR2Key,
  signStandardWebhooks,
  type DeliverArgs,
  type DeliveryOutcome,
  type DeliverResult,
  type SealedSigningSecret,
  type SecretStore,
  type StandardWebhooksHeaders,
} from "@webhook-co/shared";

// The RPC contract types (DeliverArgs/DeliverResult/DeliveryOutcome) are single-sourced in
// @webhook-co/shared so the api consumer can't drift from this producer; re-exported for the local
// tests + the index.ts WorkerEntrypoint wiring.
export type { DeliverArgs, DeliveryOutcome, DeliverResult };

/** Sign the body for a delivery: unseal each secret + Standard Webhooks sign → the webhook-* headers. */
export type SignDelivery = (input: {
  readonly webhookId: string;
  readonly timestamp: number;
  readonly body: Uint8Array;
  readonly secrets: readonly SealedSigningSecret[];
}) => Promise<StandardWebhooksHeaders>;

export interface DeliverDeps {
  /** Read the payload object's bytes by key (the engine's R2_PAYLOADS.get → arrayBuffer), or null. */
  readonly getPayload: (key: string) => Promise<ArrayBuffer | null>;
  /** Resolve a host to its A+AAAA addresses (DoH); throws/returns [] → the guard blocks. */
  readonly resolve: (host: string) => Promise<string[]>;
  /** The outbound fetch (the real global in prod; a fake under test). */
  readonly fetch: typeof fetch;
  /** Unseal + Standard Webhooks sign (S3 Slice 2). Required iff a delivery carries `signing`. */
  readonly sign?: SignDelivery;
  readonly now: () => number;
}

const DELIVERY_TIMEOUT_MS = 10_000;
const DOH_TIMEOUT_MS = 5_000;
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/**
 * Inbound signature/timestamp headers stripped before we re-sign (S3 Slice 2, ADR-0084). The receiver
 * verifies webhook.co (our secret), not the original provider — whose signature it can't verify (different
 * secret) and which, for the Standard Webhooks trio, would COLLIDE with ours. The SW trio is always
 * replaced; the rest is a curated set of common provider signatures (lowercased; Headers.delete is
 * case-insensitive). Every entry is a genuine signature/timestamp header name, so stripping can't drop a
 * content header. Not exhaustive — an unlisted provider's stale signature is inert (the receiver ignores it).
 */
const STRIPPED_INBOUND_SIGNATURE_HEADERS = [
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "svix-id",
  "svix-timestamp",
  "svix-signature",
  "stripe-signature",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-signature",
  "x-signature-256",
  "x-webhook-signature",
  "x-shopify-hmac-sha256",
  "x-slack-signature",
  "x-slack-request-timestamp",
  "paypal-transmission-sig",
  "x-square-hmacsha256-signature",
  "x-twilio-email-event-webhook-signature",
] as const;

/**
 * Deliver an event's stored bytes to `url`, behind the authoritative connect-time guard. Never throws —
 * every failure (guard block, missing payload, non-2xx, connection error) is a recorded outcome, so a
 * delivery failure can never 5xx the caller.
 */
export async function guardedDeliver(deps: DeliverDeps, args: DeliverArgs): Promise<DeliverResult> {
  const started = deps.now();
  const done = (
    outcome: DeliveryOutcome,
    status: number | null,
    error: string | null,
  ): DeliverResult => ({
    outcome,
    status,
    error,
    latencyMs: Math.max(0, Math.round(deps.now() - started)),
  });

  // 1. Structural reject (defense-in-depth — the api validated the URL at registration; re-check here).
  const v = canonicalizeAndValidateUrl(args.url);
  if (!v.ok) return done("blocked", null, "destination url rejected at delivery");

  // 2. Resolve + validate EVERY returned address (the authoritative private-range defense). FAIL CLOSED:
  //    a resolver error / no-address answer does NOT fetch (so the Happy-Eyeballs "unvalidated AAAA" vector
  //    stays closed) — but it's classified 'failed' (a TRANSIENT infra failure: retry may succeed), NOT
  //    'blocked'. 'blocked' is reserved for a real guard refusal (resolves to a private/internal address)
  //    so the retry scheduler (Slice 3) can tell a recoverable DNS blip from a terminal SSRF block.
  let addresses: string[];
  try {
    addresses = await deps.resolve(v.host);
  } catch {
    return done("failed", null, "destination did not resolve");
  }
  if (addresses.length === 0) return done("failed", null, "destination did not resolve");
  for (const ip of addresses) {
    if (isBlockedIp(ip)) {
      return done(
        "blocked",
        null,
        "destination resolved to a disallowed (private/internal) address",
      );
    }
  }

  // 3. Re-derive the payload key from the AUTHENTICATED principal (H1) — never trust a handed key — read.
  const key = await payloadR2Key(args.orgId, args.endpointId, args.dedupKey);
  const obj = await deps.getPayload(key);
  if (obj === null) return done("failed", null, "payload not found");
  const body = new Uint8Array(obj); // sign and POST the SAME bytes — byte-correctness for the signature.

  // 3b. Re-sign (S3 Slice 2): when the delivery carries signing inputs, strip the inbound signature
  //     headers and set webhook.co's webhook-id/timestamp/signature over `body`. NEVER deliver unsigned
  //     when signing was requested — a sign failure (e.g. unseal error) is a recorded 'failed', not a POST.
  const headers = filterDeliveryHeaders(args.headers);
  if (args.signing) {
    if (!deps.sign) return done("failed", null, "signing requested but no signer wired");
    let signed: StandardWebhooksHeaders;
    try {
      signed = await deps.sign({
        webhookId: args.signing.webhookId,
        timestamp: args.signing.timestamp,
        body,
        secrets: args.signing.secrets,
      });
    } catch {
      return done("failed", null, "signing failed");
    }
    for (const h of STRIPPED_INBOUND_SIGNATURE_HEADERS) headers.delete(h);
    headers.set("webhook-id", signed["webhook-id"]);
    headers.set("webhook-timestamp", signed["webhook-timestamp"]);
    headers.set("webhook-signature", signed["webhook-signature"]);
  }

  // 4. POST the exact bytes with the (filtered, possibly re-signed) headers; NEVER follow a 3xx (H2 — no
  //    free-form-URL re-intro); bound by a timeout. A 3xx / non-2xx / connection error is a recorded
  //    failure, not a throw.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await deps.fetch(v.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    } as Parameters<typeof fetch>[1]);
    const delivered = res.status >= 200 && res.status < 300;
    return done(
      delivered ? "delivered" : "failed",
      res.status,
      delivered ? null : `http ${res.status}`,
    );
  } catch {
    return done("failed", null, "delivery connection failed");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The real `sign` dep: unseal each destination signing secret with the engine's KMS-backed SecretStore
 * (the engine holds the KEK; api/mcp never do), then Standard Webhooks-sign the body with all of them
 * (active + retiring → space-delimited, for rotation overlap). signStandardWebhooks throws if any secret
 * is unusable, so a corrupt secret surfaces as a signing failure (guardedDeliver → 'failed', never an
 * unsigned POST) rather than a silently-dropped signature.
 */
export function makeSignDelivery(store: SecretStore): SignDelivery {
  return async ({ webhookId, timestamp, body, secrets }) => {
    const plaintexts = await Promise.all(secrets.map((s) => store.openString(s.sealed, s.context)));
    return signStandardWebhooks({ id: webhookId, timestamp, body, secrets: plaintexts });
  };
}

/**
 * Resolve a host to its A + AAAA addresses via Cloudflare DoH JSON. FAIL CLOSED: a resolver SERVFAIL (or
 * any non-NOERROR/NXDOMAIN status, or a transport error) THROWS, so guardedDeliver blocks rather than
 * fetching an unvalidated host. NXDOMAIN for one family yields no addresses for that family (not an error).
 */
export async function resolveViaDoh(fetchImpl: typeof fetch, host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([
    queryDoh(fetchImpl, host, "A"),
    queryDoh(fetchImpl, host, "AAAA"),
  ]);
  return [...a, ...aaaa];
}

async function queryDoh(
  fetchImpl: typeof fetch,
  host: string,
  type: "A" | "AAAA",
): Promise<string[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`;
  // Bound the resolver call (a stalled DoH server must not hang deliver() — only the POST was bounded
  // before). An abort surfaces as a throw → guardedDeliver classifies it 'failed' (transient), not a fetch.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: "application/dns-json" },
      signal: controller.signal,
    } as Parameters<typeof fetch>[1]);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`doh ${type} transport ${res.status}`);
  const json = (await res.json()) as {
    Status?: number;
    Answer?: { type?: number; data?: string }[];
  };
  const status = json.Status ?? -1;
  if (status === 3) return []; // NXDOMAIN — no record for this family
  if (status !== 0) throw new Error(`doh ${type} status ${status}`); // SERVFAIL/etc → fail closed
  const wantType = type === "A" ? 1 : 28; // RR type: A=1, AAAA=28; ignore CNAME/other answer types
  const out: string[] = [];
  for (const ans of json.Answer ?? []) {
    if (ans.type === wantType && typeof ans.data === "string") out.push(ans.data);
  }
  return out;
}
