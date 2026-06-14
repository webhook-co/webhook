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

import {
  newId,
  payloadR2Key,
  redactHeadersForLog,
  type DedupStrategy,
  type Provider,
} from "@webhook-co/shared";

import { deriveDedup } from "./dedup";

/** A resolved ingest token -> its owning endpoint (the ingest resolver's narrowed result). */
export interface ResolvedEndpoint {
  readonly orgId: string;
  readonly endpointId: string;
  readonly paused: boolean;
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
}

export interface IngestDeps {
  /** Resolve a path token to its endpoint (KV hot -> cold). null = unknown token (404). */
  resolve(token: string): Promise<ResolvedEndpoint | null>;
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

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  // No Set-Cookie, no Access-Control-* — wbhk.my is cookieless + no-CORS by construction.
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
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

  // Body cap: reject early on a too-large Content-Length, then bound the actual read (a lying/absent
  // Content-Length is caught after the read — a strict streaming cap is a hardening follow-up).
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > deps.maxBodyBytes)
    return plain(413, "payload too large");
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > deps.maxBodyBytes) return plain(413, "payload too large");

  // Capture: exact body bytes + normalized headers (see the header-fidelity note above).
  const headers: [string, string][] = [...request.headers];
  const contentType = request.headers.get("content-type");
  const derived = await deriveDedup(raw, headers, deps.now(), deps.dedupBucketWidthMs);

  // R2 PUT FIRST: the body is durable before any metadata row can point at it. A PUT failure means
  // the body isn't durable -> 500, and we never write the row (never ACK an undurable event).
  const key = await payloadR2Key(endpoint.orgId, endpoint.endpointId, derived.dedupKey);
  try {
    await deps.putPayload(key, raw, contentType);
  } catch (err) {
    deps.log("ingest.r2_put_failed", { endpointId: endpoint.endpointId, error: String(err) });
    return plain(500, "internal error");
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
    bytes: raw.byteLength,
    headers: redactHeadersForLog(headers), // signature/auth headers never logged verbatim
  });
  return plain(200, "ok");
}
