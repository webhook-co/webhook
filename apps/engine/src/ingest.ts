// The wbhk.my write path. Cookieless, no CORS, path-token routed. Accept-all-verbs (ADR-0085, the
// inspector model): every standard method is captured + the method recorded; GET/HEAD/OPTIONS also get
// a friendly browser liveness response. Durable-before-ACK:
//   <verb> /<token> -> resolve (KV hot -> cold; 404 unknown) -> paused? 429 -> body cap? 413
//   -> capture raw bytes + headers + method -> derive dedup -> R2 PUT -> ingest_event insert
//   -> ACK (200 "ok" for write verbs; liveness for GET/HEAD/OPTIONS).
//
// Dependency-injected so the orchestration (the security-critical ordering + status codes) is
// unit-testable with fakes; the real resolver/R2/ingest_event integrations are validated against
// real Postgres (db slices) + the production-shaped benchmark. Verification (provider HMAC) lands
// in a follow-up slice — capture is the floor (events stored verified=false, verifiable
// retroactively); a missing adapter never blocks capture.
//
// HEADER FIDELITY (documented constraint): the Workers `Headers` object NORMALIZES — lowercases
// names, sorts them, and combines duplicates — so true wire order/casing can't be recovered. We
// store the normalized array-of-pairs (unscrubbed; full-fidelity protection is RLS + encryption +
// retention, not redaction). Only the raw BODY bytes are byte-exact, which is all HMAC needs.

import { type CachedSealedSecret } from "@webhook-co/db";
import {
  newId,
  payloadR2Key,
  redactHeadersForLog,
  utf8Decoder,
  type DedupStrategy,
  type Provider,
  type VerificationResult,
} from "@webhook-co/shared";

import { deriveDedup } from "./dedup";

/** A resolved ingest token -> its owning endpoint (the ingest resolver's narrowed result). */
export interface ResolvedEndpoint {
  readonly orgId: string;
  readonly endpointId: string;
  readonly paused: boolean;
  /** The endpoint's sealed provider signing secrets, delivered on the principal for verify. */
  readonly sealedSecrets: readonly CachedSealedSecret[];
}

/** What handleIngest hands the verify dep to attempt provider-signature verification. */
export interface VerifyIngestInput {
  readonly rawBody: Uint8Array;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** The detected provider (null = unrecognized sender -> no adapter -> unverified). */
  readonly provider: Provider | null;
  /**
   * The full request URL + HTTP method as received. A few Tier-2 providers sign over them (the URL:
   * Square/Twilio/Trello; the method: HubSpot). Forwarded verbatim to each adapter; schemes that don't
   * reference a url/method message part ignore them.
   */
  readonly requestUrl: string;
  readonly method: string;
  /** Authoritative org/endpoint (the AAD is rebuilt from these, not the cached secret context). */
  readonly orgId: string;
  readonly endpointId: string;
  readonly sealedSecrets: readonly CachedSealedSecret[];
}

/** The verification outcome stored on the event. `verification` is the structured diagnostic (jsonb). */
export interface VerificationOutcome {
  readonly verified: boolean;
  readonly verification: VerificationResult | null;
  /**
   * The provider that actually verified the event (the registered provider whose adapter matched).
   * Set only on a successful verification, where it's the AUTHORITATIVE label for the event's
   * `provider` — more reliable than header detection when providers collide on a signature header.
   * Undefined on failure/unverified (the event keeps the best-effort detected provider).
   */
  readonly provider?: Provider;
}

/** The full-fidelity capture row handed to ingest_event (variant B). */
export interface IngestRow {
  readonly id: string;
  readonly orgId: string;
  readonly endpointId: string;
  readonly payloadR2Key: string;
  readonly payloadBytes: number;
  readonly dedupKey: string;
  readonly dedupStrategy: DedupStrategy;
  readonly contentType: string | null;
  readonly contentHash: Uint8Array;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** The captured request's HTTP method (accept-all-verbs); recorded on every capture. */
  readonly method: string;
  readonly provider: Provider | null;
  readonly providerEventId: string | null;
  readonly dedupBucket: number | null;
  readonly verified: boolean;
  readonly verification: VerificationResult | null;
}

export interface IngestDeps {
  /** Resolve a path token to its endpoint (KV hot -> cold). null = unknown token (404). */
  resolve(token: string): Promise<ResolvedEndpoint | null>;
  /**
   * Provider-signature verification (best-effort). MUST NOT throw on a verification problem — it
   * returns a diagnostic outcome. handleIngest also guards the call so a thrown impl never blocks
   * capture (events are still stored, verified=false).
   */
  verify(input: VerifyIngestInput): Promise<VerificationOutcome>;
  /** Durably PUT the raw body to R2 BEFORE the metadata insert (durable-before-ACK, ADR-0013). */
  putPayload(key: string, body: Uint8Array, contentType: string | null): Promise<void>;
  /** Insert event metadata via ingest_event (variant B). inserted=false on a dedup no-op. */
  ingestEvent(row: IngestRow): Promise<{ inserted: boolean }>;
  /** Server-assigned receive time (drives the content-hash bucket). */
  now(): Date;
  /** Structured log sink. Headers passed here MUST already be scrubbed. */
  log(event: string, fields: Record<string, unknown>): void;
  /** Max captured body bytes (default MAX_VERIFIABLE_BODY_BYTES). Oversized -> 413. */
  maxBodyBytes: number;
  /** content_hash dedup-bucket width in ms. */
  dedupBucketWidthMs: number;
}

const PAUSED_RETRY_AFTER_SECONDS = 60;

/**
 * Read a request body stream, bounding it AS IT STREAMS: return null the moment the running total
 * exceeds `maxBytes` (and cancel the stream so the rest is never pulled), rather than buffering an
 * arbitrarily large body and checking its size afterward (review finding C1). A null stream (no
 * body) yields an empty array.
 */
export async function readCappedBody(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel(); // abort early — don't drain a too-large body into memory
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  // No Set-Cookie, no Access-Control-* — wbhk.my is cookieless + no-CORS by construction. nosniff:
  // wbhk.my now answers browser-facing GET/HEAD/OPTIONS (accept-all-verbs), so pin the declared
  // content-type against MIME sniffing on every text response.
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

/** The standard verbs wbhk.my accepts. A non-standard verb (TRACE/CONNECT/…) is rejected uniformly,
 *  BEFORE token resolution, so the rejection still leaks no token validity (the original no-oracle
 *  property, now scoped to the verbs we reject rather than to all-but-POST). */
const SUPPORTED_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const ALLOW_METHODS = "GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE";

// Browser-facing liveness for the non-bodied verbs: a paste-in-browser GET should say the endpoint is
// live, not throw a scary 405. no-referrer + noindex keep the token URL out of referer logs + search
// indexes. The body is a CONSTANT — it reflects NOTHING resolved (no endpoint id/org/name, no paused
// flag, no count, no captured payload), so a GET leaks only the same token-existence signal the capture
// path already does (a known token -> 2xx vs an unknown token -> 404), never a finer oracle.
const LIVENESS_HEADERS = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } as const;
const LIVENESS_BODY = "this webhook endpoint is live. POST your events here.\n";

/** The non-bodied verbs that get a browser liveness response (the others are write verbs → "ok"). Single
 *  source of truth so the routing decision and livenessAck() can't drift. */
const LIVENESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
function isLivenessVerb(method: string): boolean {
  return LIVENESS_METHODS.has(method);
}

function livenessAck(method: string): Response {
  if (method === "HEAD") {
    // Same headers as GET but no body (Workers does not auto-strip a HEAD body — return null ourselves).
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        ...LIVENESS_HEADERS,
      },
    });
  }
  if (method === "OPTIONS") {
    // 204 No Content. Deliberately NO Access-Control-* — wbhk.my is no-CORS, so we don't answer preflight.
    return new Response(null, {
      status: 204,
      headers: { "x-content-type-options": "nosniff", ...LIVENESS_HEADERS },
    });
  }
  return plain(200, LIVENESS_BODY, LIVENESS_HEADERS); // GET (nosniff comes from plain())
}

/**
 * If `raw` is a Slack `url_verification` handshake body, return its (non-empty) challenge string;
 * otherwise null. Slack POSTs `{ "type": "url_verification", "challenge": "<nonce>", "token": "…" }`
 * during Request URL setup and expects the challenge echoed back (it proves URL control; it carries no
 * secret). PURE and TOTAL: any decode/parse failure or unexpected shape (wrong type, missing/empty/
 * non-string challenge) returns null — it can NEVER throw into the ingest path, so the no-drop capture
 * floor is preserved (a non-handshake body just falls through to capture). A real challenge is a
 * non-empty nonce; an empty one is treated as not-a-handshake (captured, not diverted).
 */
export function slackUrlVerificationChallenge(raw: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(raw));
  } catch {
    return null; // not JSON -> not a handshake -> capture normally
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: unknown }).type === "url_verification" &&
    typeof (parsed as { challenge?: unknown }).challenge === "string" &&
    (parsed as { challenge: string }).challenge.length > 0
  ) {
    return (parsed as { challenge: string }).challenge;
  }
  return null;
}

export async function handleIngest(request: Request, deps: IngestDeps): Promise<Response> {
  // Accept-all-verbs (ADR-0085): capture every standard method (the inspector model). The supported-set
  // gate stays BEFORE token resolution so a rejected (non-standard) verb is answered uniformly and leaks
  // no token validity. GET verification-handshakes (Meta/X CRC/…) are a follow-up slice.
  if (!SUPPORTED_METHODS.has(request.method))
    return plain(405, "method not allowed", { allow: ALLOW_METHODS });

  // Path-token routing: the first path segment is the ingest token.
  const token = new URL(request.url).pathname.replace(/^\/+/, "").split("/")[0];
  if (!token) return plain(404, "not found");

  const endpoint = await deps.resolve(token);
  if (endpoint === null) return plain(404, "not found"); // unknown token — no hints, no breadcrumbs

  // Paused / soft-capped: WRITE verbs are rejected with a retryable 429 (the provider holds the event,
  // less likely to auto-disable than on a 4xx/404 — founder decision). A bodyless liveness verb still
  // answers a CONSTANT liveness (so a browser GET never reveals paused state — the response is identical
  // to an active endpoint's) but captures NOTHING: a paused endpoint stores and bills nothing.
  if (endpoint.paused) {
    if (isLivenessVerb(request.method)) return livenessAck(request.method);
    return plain(429, "endpoint paused", { "retry-after": String(PAUSED_RETRY_AFTER_SECONDS) });
  }

  // Body cap: reject early on a too-large Content-Length, then bound the actual read as it streams —
  // a lying/absent Content-Length can't smuggle an oversized body in (readCappedBody aborts the read
  // the moment the running total breaches the cap, never buffering the whole body first).
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > deps.maxBodyBytes)
    return plain(413, "payload too large");
  const raw = await readCappedBody(request.body, deps.maxBodyBytes);
  if (raw === null) return plain(413, "payload too large");

  // Capture: exact body bytes + normalized headers (see the header-fidelity note above).
  const headers: [string, string][] = [...request.headers];
  const contentType = request.headers.get("content-type");
  const derived = await deriveDedup(
    raw,
    headers,
    request.method,
    deps.now(),
    deps.dedupBucketWidthMs,
  );

  // Slack Request URL verification handshake (ADR-0011 / Slice C). During Request URL setup Slack POSTs
  // a signed `{ type: "url_verification", challenge }` and expects the challenge echoed — BEFORE any
  // real event, and often before the operator has even registered a signing secret. For a slack-detected
  // request we echo `{ challenge }` and capture NOTHING (it's a control message, not an event). The
  // helper is pure + total (any non-handshake shape -> null -> fall through to normal capture), so the
  // no-drop floor is never at risk. No signature check is needed: the challenge is Slack's own nonce
  // bounced 1:1 — it leaks nothing, we never store it, and a non-slack sender (no x-slack-signature)
  // never reaches this branch. This runs BEFORE the R2 PUT, so a handshake never writes a payload/row.
  //
  // The `providerEventId === null` guard confines the second JSON parse to slack bodies WITHOUT an event
  // id: a real Slack `event_callback` carries an `event_id` (deriveDedup already extracted it), so the
  // common steady-state event path skips this parse entirely — only a handshake (no event_id) pays it.
  if (derived.provider === "slack" && derived.providerEventId === null) {
    const challenge = slackUrlVerificationChallenge(raw);
    if (challenge !== null) {
      deps.log("ingest.slack_url_verification", { endpointId: endpoint.endpointId });
      // Response.json: application/json, no Set-Cookie / no Access-Control-* — the cookieless, no-CORS
      // wbhk.my posture (same guarantee plain() documents for the text responses), by construction.
      // nosniff: the challenge is attacker-influenced bytes echoed into a (browser-reachable) body.
      return Response.json(
        { challenge },
        { status: 200, headers: { "x-content-type-options": "nosniff" } },
      );
    }
  }

  // R2 PUT FIRST: the body is durable before any metadata row can point at it. A PUT failure means
  // the body isn't durable -> 500, and we never write the row (never ACK an undurable event).
  const key = await payloadR2Key(endpoint.orgId, endpoint.endpointId, derived.dedupKey);
  try {
    await deps.putPayload(key, raw, contentType);
  } catch (err) {
    deps.log("ingest.r2_put_failed", { endpointId: endpoint.endpointId, error: String(err) });
    return plain(500, "internal error");
  }

  // Provider-signature verification — AFTER the body is durable (so verify cycles never delay
  // durability) and BEFORE the insert (verified/verification are insert columns). Best-effort and
  // GUARDED: a thrown verify (KMS down, a corrupt secret) must NEVER block capture — we fall back to
  // verified=false and still store the event (capture is the floor; it's verifiable retroactively).
  let outcome: VerificationOutcome = { verified: false, verification: null };
  try {
    outcome = await deps.verify({
      rawBody: raw,
      headers,
      provider: derived.provider,
      requestUrl: request.url,
      method: request.method,
      orgId: endpoint.orgId,
      endpointId: endpoint.endpointId,
      sealedSecrets: endpoint.sealedSecrets,
    });
  } catch (err) {
    deps.log("ingest.verify_failed", { endpointId: endpoint.endpointId, error: String(err) });
  }

  // Metadata insert (the dedup gate). On failure -> 500; the R2 object survives for the orphan sweep,
  // and the provider's retry re-PUTs the same deterministic key and re-attempts the insert.
  let inserted: boolean;
  try {
    ({ inserted } = await deps.ingestEvent({
      id: newId(),
      orgId: endpoint.orgId,
      endpointId: endpoint.endpointId,
      payloadR2Key: key,
      payloadBytes: raw.byteLength,
      dedupKey: derived.dedupKey,
      dedupStrategy: derived.dedupStrategy,
      contentType,
      contentHash: derived.contentHash,
      headers,
      method: request.method,
      // A successful verify names the provider authoritatively (header detection can mis-pick when
      // providers collide on a signature header); otherwise fall back to the detected provider. The
      // providerEventId/dedupStrategy/dedupBucket below stay under the DETECTED provider (the dedup
      // basis) — that only diverges from `provider` if a request carried two providers' signature
      // headers, impossible for the current providers (no shared header); revisit if that changes.
      provider: outcome.provider ?? derived.provider,
      providerEventId: derived.providerEventId,
      dedupBucket: derived.dedupBucket,
      verified: outcome.verified,
      verification: outcome.verification,
    }));
  } catch (err) {
    deps.log("ingest.insert_failed", { endpointId: endpoint.endpointId, error: String(err) });
    return plain(500, "internal error");
  }

  // ACK once both artifacts are durable. A dedup no-op (inserted=false) is still a success.
  deps.log("ingest.captured", {
    endpointId: endpoint.endpointId,
    inserted,
    dedupStrategy: derived.dedupStrategy,
    provider: derived.provider,
    verified: outcome.verified,
    method: request.method,
    bytes: raw.byteLength,
    headers: redactHeadersForLog(headers), // signature/auth headers never logged verbatim
  });
  // ACK. Capture already happened above for every verb; this only varies the success body: write verbs
  // get the terse "ok", while GET/HEAD/OPTIONS get a browser-facing liveness response (constant, nothing
  // resolved reflected). A paused endpoint / unknown token never reaches here (liveness / 429 / 404 above).
  return isLivenessVerb(request.method) ? livenessAck(request.method) : plain(200, "ok");
}
