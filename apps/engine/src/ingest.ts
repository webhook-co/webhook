// The wbhk.my write path. Cookieless, no CORS, path-token routed. Durable-before-ACK:
//   POST /<token> -> resolve (KV hot -> cold; 404 unknown) -> paused? 429 -> body cap? 413
//   -> capture raw bytes + headers -> derive dedup -> R2 PUT -> ingest_event insert -> ACK 200.
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
  /** Authoritative org/endpoint (the AAD is rebuilt from these, not the cached secret context). */
  readonly orgId: string;
  readonly endpointId: string;
  readonly sealedSecrets: readonly CachedSealedSecret[];
}

/** The verification outcome stored on the event. `verification` is the structured diagnostic (jsonb). */
export interface VerificationOutcome {
  readonly verified: boolean;
  readonly verification: VerificationResult | null;
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
  // No Set-Cookie, no Access-Control-* — wbhk.my is cookieless + no-CORS by construction.
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

/**
 * If `raw` is a Slack `url_verification` handshake body, return its challenge string; otherwise null.
 * Slack POSTs `{ "type": "url_verification", "challenge": "<nonce>", "token": "…" }` during Request URL
 * setup and expects the challenge echoed back (it proves URL control; it carries no secret). PURE and
 * TOTAL: any decode/parse failure or unexpected shape returns null — it can NEVER throw into the ingest
 * path, so the no-drop capture floor is preserved (a non-handshake body just falls through to capture).
 */
export function slackUrlVerificationChallenge(raw: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null; // not JSON -> not a handshake -> capture normally
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: unknown }).type === "url_verification" &&
    typeof (parsed as { challenge?: unknown }).challenge === "string"
  ) {
    return (parsed as { challenge: string }).challenge;
  }
  return null;
}

export async function handleIngest(request: Request, deps: IngestDeps): Promise<Response> {
  // Webhooks are POST. (GET verification-handshakes are a follow-up.) Method-checked first so the
  // rejection is uniform and leaks no token validity.
  if (request.method !== "POST") return plain(405, "method not allowed", { allow: "POST" });

  // Path-token routing: the first path segment is the ingest token.
  const token = new URL(request.url).pathname.replace(/^\/+/, "").split("/")[0];
  if (!token) return plain(404, "not found");

  const endpoint = await deps.resolve(token);
  if (endpoint === null) return plain(404, "not found"); // unknown token — no hints, no breadcrumbs

  // Paused / soft-capped -> reject (don't silently drop). 429 + Retry-After is retryable, so the
  // provider holds the event and is less likely to auto-disable than on a 4xx/404 (founder decision).
  if (endpoint.paused) {
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
  const derived = await deriveDedup(raw, headers, deps.now(), deps.dedupBucketWidthMs);

  // Slack Request URL verification handshake (ADR-0011 / Slice C). During Request URL setup Slack POSTs
  // a signed `{ type: "url_verification", challenge }` and expects the challenge echoed — BEFORE any
  // real event, and often before the operator has even registered a signing secret. For a request whose
  // DETECTED scheme is slack we echo `{ challenge }` and capture NOTHING (it's a control message, not an
  // event). The JSON parse is confined to slack-detected traffic (derived.provider), and the helper is
  // pure + total (any non-handshake shape -> null -> fall through to normal capture), so the no-drop
  // floor is never at risk. No signature check is needed: the challenge is Slack's own nonce bounced 1:1
  // — it leaks nothing, we never store it, and a non-slack sender (no x-slack-signature) never reaches
  // this branch. This runs BEFORE the R2 PUT, so a handshake never writes a payload or a metadata row.
  if (derived.provider === "slack") {
    const challenge = slackUrlVerificationChallenge(raw);
    if (challenge !== null) {
      deps.log("ingest.slack_url_verification", { endpointId: endpoint.endpointId });
      return new Response(JSON.stringify({ challenge }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
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
      provider: derived.provider,
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
    bytes: raw.byteLength,
    headers: redactHeadersForLog(headers), // signature/auth headers never logged verbatim
  });
  return plain(200, "ok");
}
